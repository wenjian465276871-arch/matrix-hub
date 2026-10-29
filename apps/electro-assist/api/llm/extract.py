"""图片 → 工艺文本的结构化识别（`POST /extract`）。

**单通道**，这是决策 #13 允许的 P4 形态："做单通道（二选一）或继续延后"。
为什么不做双通道：双通道要 OCR 层给出**文字坐标**，而当前模型只给语义，
不给 bbox——假装有第二通道，等于用一个不可验证的"一致"去背书第一通道。

三层校验（计划 §2.1 决策 #11）在这里的落法：
1. **结构**：pydantic 强约束，字段缺失即拒；
2. **语义**：`fields` 里的每个值必须能在 `lines`（原图转录）里找到；
   找不到就标 `unverified`，数值类直接清空——宁可空，不可编；
3. **回溯**：每个 step 带 `source_line`，指回 `lines` 的下标，确认页据此并排显示。

输出永远 `needs_review=True`：识别结果不写库、不自动发布，只回给确认页。
"""
from __future__ import annotations

import re
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

MAX_LINES = 80
MAX_STEPS = 20
MAX_LINE_CHARS = 200

NUM_RE = re.compile(r"\d+(?:\.\d+)?")
SPACE_RE = re.compile(r"[\s\u3000]+")
# 转录时常混入全角数字/单位，比较前统一，避免"２.０"与"2.0"被判成两个值。
FULLWIDTH = str.maketrans("０１２３４５６７８９．－～", "0123456789.-~")

SYSTEM_PROMPT = """你是工艺截图的转录器，不是解释器。

任务：逐行转录图中可见文字，并把它们整理成结构化字段。

硬规则：
1. **只写图中能看到的字**。看不清、被遮挡、模糊的，写 null 或省略，不要猜。
2. 数值、单位、编号、端子号必须逐字照抄。不得换算、不得补零、不得改写单位。
3. 图中的标题对应 name，工位/位置对应 station，工具清单对应 tools，安全提示对应 safety。
4. 步骤按图中的编号顺序输出；criterion 只放图中写明的判据原文（例如「2.0–3.5s」），
   没有判据就写 null。**不要自己判断合格与否**。
5. lines 是逐行转录结果，保持阅读顺序；一行一条，不要把两行合并。
6. source_line 是 steps[i] 对应的 lines 下标（从 0 开始）。找不到就写 null。
7. warnings 写你在转录时发现的问题（缺行、遮挡、编号跳号、单位缺失）。
8. 只输出一个 JSON 对象，不要 Markdown 代码块，不要解释。

输出结构：
{
  "lines": ["第 1 行原文", "第 2 行原文"],
  "fields": {
    "name": "工序名称或 null",
    "station": "工位或 null",
    "tools": ["工具1"],
    "safety": ["安全提示原文"],
    "steps": [
      {"seq": 1, "action": "动作原文", "criterion": "判据原文或 null", "source_line": 0}
    ]
  },
  "warnings": ["..."]
}
"""


def user_prompt(image_count: int) -> str:
    return (
        f"这是 {image_count} 张工艺文件截图（按上传顺序）。"
        "请按系统提示转录并结构化，只输出 JSON。"
    )


class ExtractedStep(BaseModel):
    model_config = ConfigDict(extra="forbid")

    seq: int = Field(ge=1, le=99)
    action: str = Field(min_length=2, max_length=200)
    criterion: str | None = Field(default=None, max_length=80)
    source_line: int | None = Field(default=None, ge=0, le=MAX_LINES)

    @field_validator("action", "criterion")
    @classmethod
    def _no_markup(cls, value: str | None) -> str | None:
        if value is None:
            return None
        text = value.strip()
        if "<" in text or "javascript:" in text.lower():
            raise ValueError("字段含疑似标记内容")
        return text


class ExtractFields(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, max_length=80)
    station: str | None = Field(default=None, max_length=80)
    tools: list[str] = Field(default_factory=list)
    safety: list[str] = Field(default_factory=list)
    steps: list[ExtractedStep] = Field(default_factory=list)

    @model_validator(mode="after")
    def _caps(self) -> "ExtractFields":
        if len(self.tools) > 10:
            self.tools = self.tools[:10]
        if len(self.safety) > 10:
            self.safety = self.safety[:10]
        if len(self.steps) > MAX_STEPS:
            self.steps = self.steps[:MAX_STEPS]
        self.tools = [item.strip()[:40] for item in self.tools if item.strip()]
        self.safety = [item.strip()[:160] for item in self.safety if item.strip()]
        return self


class ExtractPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    lines: list[str] = Field(default_factory=list)
    fields: ExtractFields
    warnings: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def _line_caps(self) -> "ExtractPayload":
        cleaned = [line.strip()[:MAX_LINE_CHARS] for line in self.lines if line.strip()]
        self.lines = cleaned[:MAX_LINES]
        self.warnings = [item.strip()[:160] for item in self.warnings if item.strip()][:10]
        return self


def normalize(text: str) -> str:
    """比较用的归一化：去空白 + 全角转半角 + 小写。

    只用于「这句话在不在转录里」的判断，不改动返回值——
    归一化后的文本绝不能回写给用户，否则原文就被悄悄改写了。
    """
    return SPACE_RE.sub("", text.translate(FULLWIDTH)).lower()


def _numbers(text: str) -> list[str]:
    return NUM_RE.findall(text.translate(FULLWIDTH))


def reconcile(payload: ExtractPayload) -> dict[str, Any]:
    """语义 + 回溯校验。返回可直接给前端的结果（含 `unverified` 明细）。"""
    lines = payload.lines
    haystack = normalize("\n".join(lines))
    unverified: list[str] = []
    warnings = list(payload.warnings)

    def found(text: str | None) -> bool:
        return bool(text) and normalize(text) in haystack

    fields = payload.fields
    name = fields.name if found(fields.name) else None
    if fields.name and name is None:
        unverified.append("工序名称在原图文字中找不到，已清空")
    station = fields.station if found(fields.station) else None
    if fields.station and station is None:
        unverified.append("工位在原图文字中找不到，已清空")

    tools = [tool for tool in fields.tools if found(tool)]
    dropped_tools = len(fields.tools) - len(tools)
    if dropped_tools:
        unverified.append(f"{dropped_tools} 个工具名在原图文字中找不到，已剔除")

    safety = [item for item in fields.safety if found(item)]
    if len(safety) != len(fields.safety):
        unverified.append(f"{len(fields.safety) - len(safety)} 条安全提示找不到原文，已剔除")

    steps: list[dict[str, Any]] = []
    for step in fields.steps:
        criterion = step.criterion
        # 判据里的每个数字都必须在转录里出现过：这是"不许补数"的最后一道闸。
        missing_numbers = [n for n in _numbers(criterion or "") if normalize(n) not in haystack]
        if criterion and missing_numbers:
            unverified.append(
                f"第 {step.seq} 步判据「{criterion}」中的 {'、'.join(missing_numbers)} "
                "在原图里找不到，已清空判据"
            )
            criterion = None

        action_numbers = [n for n in _numbers(step.action) if normalize(n) not in haystack]
        verified = found(step.action) and not action_numbers
        if action_numbers:
            unverified.append(
                f"第 {step.seq} 步动作里的 {'、'.join(action_numbers)} 在原图里找不到，请核对"
            )
        elif not verified:
            unverified.append(f"第 {step.seq} 步为改写文本（非原图原文），请核对")

        steps.append(
            {
                "seq": len(steps) + 1,
                "action": step.action,
                "criterion": criterion,
                "source_line": step.source_line,
                "verified": verified,
            }
        )

    if not lines:
        warnings.append("没有得到任何转录文字：可能是纯图形截图，或图片过于模糊")
    if not steps:
        warnings.append("没有识别到步骤：确认图片里是否有编号或分隔线")

    return {
        "lines": lines,
        "fields": {
            "name": name,
            "station": station,
            "tools": tools,
            "safety": safety,
            "steps": steps,
        },
        "warnings": warnings,
        "unverified": unverified,
        "needs_review": True,
        "stats": {
            "lines": len(lines),
            "steps": len(steps),
            "verified_steps": sum(1 for step in steps if step["verified"]),
        },
    }
