"""图片 → 工艺文本的结构化识别（`POST /extract`）。

**双通道（2026-11-01，决策 #37）**：拆成「转录」与「结构化」两次调用。
此前是单通道（决策 #13 允许的 P4 形态），一次调用同时产 `lines` 与 `fields`，
问题是字段与原文的一致性只能事后用字符串匹配去猜。

双通道的做法与理由：

- **通道 A（转录）**只输出 `lines`，不看结构化任务，模型没有"必须凑出步骤"
  的压力，转录更贴原文；
- **通道 B（结构化）**只吃 A 的文本，**不再看图片**，输出 `fields`。
  它的输入就是可校验的原文，所以 `source_line` 天然准确，
  `fields` 里任何不在 `lines` 中的值都能被确定地判为编造。

**必须说清楚的一点**：这不是"OCR 引擎 ‖ 多模态模型"的异源双通道。
真正的异源通道需要第二个视觉服务（DashScope OCR 或本地 PaddleOCR），
当前只有 DeepSeek 一把 Key，所以两个通道是**同一模型的两段式**。
它换来的是"结构化阶段不再看图"，代价是延迟翻倍、成本约 1.6 倍。
`EXTRACT_MODE=single` 可退回单通道。

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


# ---------------------------------------------------------------- 双通道（决策 #37）

TRANSCRIBE_SYSTEM = """你是工艺截图的转录器。只做一件事：把图里的字抄下来。

硬规则：
1. **只写图中能看到的字**。看不清、被遮挡、模糊的，整行省略，不要猜、不要补。
2. 保持阅读顺序，一行一条。**不要把两行合并**，也不要把一行拆成两条。
3. 数值、单位、编号、端子号必须逐字照抄。不得换算、不得补零、不得改单位。
4. 不判断对错，不解释含义，不整理成步骤——那不是你的任务。
5. warnings 写转录时发现的问题（遮挡、编号跳号、单位缺失、表格错行）。
6. 只输出一个 JSON 对象，不要 Markdown 代码块，不要解释。

输出结构：
{
  "lines": ["第 1 行原文", "第 2 行原文"],
  "warnings": ["..."]
}
"""


def transcribe_prompt(image_count: int) -> str:
    return f"这是 {image_count} 张工艺文件截图（按上传顺序）。逐行转录，只输出 JSON。"


STRUCTURE_SYSTEM = """你是排版器。输入是一份**已经从截图转录出来的文本**，不需要也不允许看图。

任务：把转录文本整理成结构化字段。

硬规则：
1. **只使用输入文本里出现的内容**。文本没写的字段一律 null 或空数组，不要推测、不要补全。
2. 每个字段的值必须能在输入文本里**原样找到**（允许去掉空格后比较）。做不到就不要写。
3. 图中的标题对应 name，工位/位置对应 station，工具清单对应 tools，安全提示对应 safety。
4. 步骤按输入文本里的编号顺序输出；criterion 只放文本中写明的判据原文
   （例如「2.0–3.5s」），没有就写 null。**不要自己判断合格与否**。
5. source_line 是该步骤对应的输入行号（从 0 开始）。找不到就写 null，
   不要猜一个"差不多"的行号。
6. warnings 写整理时发现的问题（缺判据、步骤编号不连续、字段缺失）。
7. 只输出一个 JSON 对象，不要 Markdown 代码块，不要解释。

输出结构：
{
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


def structure_prompt(lines: list[str]) -> str:
    """把转录结果按「行号: 原文」喂给通道 B。

    带行号是为了让模型能填 `source_line`；如果不给行号，它只能数行，
    而模型数行经常差一——差一就指到别的步骤，回溯校验直接失效。
    """
    body = "\n".join(f"{index}: {line}" for index, line in enumerate(lines))
    return f"以下是转录文本（格式为「行号: 原文」）：\n\n{body}\n\n请整理成结构化字段，只输出 JSON。"


def _only_known(data: dict, model: type[BaseModel]) -> dict:
    """丢掉模型多给的键，而不是让整个结果作废。

    这些键本来就没有下游消费者，留着不用、拒了整个结果才是有代价的选择。
    """
    return {k: v for k, v in data.items() if k in model.model_fields}


def _hoist_field_warnings(data: dict) -> dict:
    """把被塞进 `fields` 里的 `warnings` 提到顶层。

    2026-11-02 线上：一张宽表截图，通道 A 转录 20 行**完全正确**，
    但模型把 `fields.warnings` 写成数组，`extra="forbid"` 直接判死整份结果；
    回退单通道后又死在同一处，用户只看到"没读出可用的结构"。
    位置放错不等于内容错误——这类字段只是提示语，挪一层就能用。
    """
    if not isinstance(data, dict):
        return data
    fields = data.get("fields")
    if isinstance(fields, dict):
        moved = fields.pop("warnings", None)
        if moved is not None:
            top = data.get("warnings")
            merged = list(top) if isinstance(top, list) else []
            merged.extend(moved if isinstance(moved, list) else [moved])
            data["warnings"] = merged
    return data


class ExtractedStep(BaseModel):
    model_config = ConfigDict(extra="forbid")

    seq: int = Field(ge=1, le=99)
    action: str = Field(min_length=2, max_length=200)
    criterion: str | None = Field(default=None, max_length=80)
    source_line: int | None = Field(default=None, ge=0, le=MAX_LINES)

    @model_validator(mode="before")
    @classmethod
    def _tolerate(cls, data):
        if not isinstance(data, dict):
            return data
        data = _only_known(data, cls)
        line = data.get("source_line")
        if isinstance(line, int) and not 0 <= line <= MAX_LINES:
            # 越界的行号指不回原图，留着比置空更糟：确认页会并排显示错行
            data["source_line"] = None
        return data

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

    @model_validator(mode="before")
    @classmethod
    def _tolerate(cls, data):
        return _only_known(data, cls) if isinstance(data, dict) else data

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


def _clean_lines(raw: list[str]) -> list[str]:
    """去空行、截长度、封顶条数。两个通道共用，避免各写一份漂移。"""
    cleaned = [line.strip()[:MAX_LINE_CHARS] for line in raw if line.strip()]
    return cleaned[:MAX_LINES]


def _clean_warnings(raw: list[str]) -> list[str]:
    return [item.strip()[:160] for item in raw if item.strip()][:10]


class ExtractPayload(BaseModel):
    """单通道输出：一次调用同时给 lines 与 fields。"""

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="before")
    @classmethod
    def _tolerate(cls, data):
        if not isinstance(data, dict):
            return data
        return _only_known(_hoist_field_warnings(data), cls)

    lines: list[str] = Field(default_factory=list)
    fields: ExtractFields
    warnings: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def _caps(self) -> "ExtractPayload":
        self.lines = _clean_lines(self.lines)
        self.warnings = _clean_warnings(self.warnings)
        return self


class TranscribePayload(BaseModel):
    """通道 A 输出：只有转录，没有结构化字段。

    `extra="forbid"` 在这里是**降级触发器**：如果模型仍按旧提示词吐出
    `fields`，解析会失败，路由据此判定"通道 A 没按要求工作"并回退单通道，
    而不是收下一份半成品。
    """

    model_config = ConfigDict(extra="forbid")

    lines: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def _caps(self) -> "TranscribePayload":
        self.lines = _clean_lines(self.lines)
        self.warnings = _clean_warnings(self.warnings)
        return self


class StructurePayload(BaseModel):
    """通道 B 输出：只有结构化字段，`lines` 用通道 A 的。"""

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="before")
    @classmethod
    def _tolerate(cls, data):
        if not isinstance(data, dict):
            return data
        return _only_known(_hoist_field_warnings(data), cls)

    fields: ExtractFields
    warnings: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def _caps(self) -> "StructurePayload":
        self.warnings = _clean_warnings(self.warnings)
        return self


def normalize(text: str) -> str:
    """比较用的归一化：去空白 + 全角转半角 + 小写。

    只用于「这句话在不在转录里」的判断，不改动返回值——
    归一化后的文本绝不能回写给用户，否则原文就被悄悄改写了。
    """
    return SPACE_RE.sub("", text.translate(FULLWIDTH)).lower()


def _numbers(text: str) -> list[str]:
    return NUM_RE.findall(text.translate(FULLWIDTH))


def reconcile(lines: list[str], fields: ExtractFields, warnings: list[str]) -> dict[str, Any]:
    """语义 + 回溯校验。返回可直接给前端的结果（含 `unverified` 明细）。

    参数从整份 payload 拆成三段，是为了让双通道能把"通道 A 的 lines"与
    "通道 B 的 fields"分别喂进来——校验逻辑本身一个字没改。
    """
    haystack = normalize("\n".join(lines))
    unverified: list[str] = []
    problems = list(warnings)

    def found(text: str | None) -> bool:
        return bool(text) and normalize(text) in haystack

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
        problems.append("没有得到任何转录文字：可能是纯图形截图，或图片过于模糊")
    if not steps:
        problems.append("没有识别到步骤：确认图片里是否有编号或分隔线")

    return {
        "lines": lines,
        "fields": {
            "name": name,
            "station": station,
            "tools": tools,
            "safety": safety,
            "steps": steps,
        },
        "warnings": problems,
        "unverified": unverified,
        "needs_review": True,
        "stats": {
            "lines": len(lines),
            "steps": len(steps),
            "verified_steps": sum(1 for step in steps if step["verified"]),
        },
    }
