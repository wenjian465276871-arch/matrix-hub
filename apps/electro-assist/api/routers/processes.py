"""工艺文本结构化预检（`POST /processes`）。

**它不是生成器**：不调模型、不落库、不产出 Guide。它回答一个更便宜的问题——
"这段文本里，系统认得出哪些字段、缺哪些字段"。

为什么值得单独一个端点：
- 生成一次要花配额与钱，缺工位/缺判据的文本照样能生成，但结果一定需要人补；
- 模型不会告诉你"你没写安全项"，它只会安静地留空；
- 规则解析 0 token、毫秒级，适合放在提交按钮前面当"提交前自检"。

计划 §3.5 把它写成"创建工艺"，落地时改成语义等价但不建实体的预检：
建实体就要建表、建清理策略、建"工艺版本"，而 `/generate` 已经能直接吃文本。
多一个没有消费者的实体，只会多一处要维护的空壳。
"""
from __future__ import annotations

import re
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter(prefix="/api/electro", tags=["processes"])

MIN_CHARS = 10
MAX_CHARS = 20_000

FIELD_RE = {
    "name": re.compile(r"^\s*(?:工序|工序名称|作业名称)\s*[:：]\s*(.+)$"),
    "station": re.compile(r"^\s*(?:工位|工位号|作业位置)\s*[:：]\s*(.+)$"),
    "tools": re.compile(r"^\s*(?:工具|工器具|工具清单)\s*[:：]\s*(.+)$"),
}
SAFETY_RE = re.compile(r"^\s*(?:安全|安全提示|安全注意事项|警告|注意)\s*[:：]\s*(.+)$")
# 步骤编号：`1.` `1、` `1)` `(1)` `第1步`。只认行首，避免把"确认 2 个门"当成第 2 步。
STEP_RE = re.compile(r"^\s*(?:第\s*(\d+)\s*步|[(（]?(\d{1,2})[)）.、])\s*[:：]?\s*(.+)$")
BULLET_RE = re.compile(r"^\s*[-*·•]\s*(.+)$")
# 判据线索：区间、单边阈值、带单位的数值。这里只做"有没有"的判断，
# 具体 min/max 交给生成管线——预检不替用户决定判据类型。
CRITERION_RE = re.compile(
    r"(\d+(?:\.\d+)?\s*(?:[-–—~至]\s*\d+(?:\.\d+)?)\s*[A-Za-z%℃°·/]*"
    r"|(?:≤|≥|不大于|不小于|不超过|不低于)\s*\d+(?:\.\d+)?"
    r"|\d+(?:\.\d+)?\s*(?:V|A|mm|s|N·m|N|MPa|kPa|bar|℃|%|Hz|Ω))"
)
SPLIT_RE = re.compile(r"[、,，;；/]+")


class ProcessIn(BaseModel):
    # 长度不用 pydantic 的 min_length：它抛的是 `detail: [...]` 的校验错误，
    # 与全站 `{code, message}` 信封不一致，前端拿到后只能显示"未知错误"。
    text: str
    system: Literal["door", "hvac", "pantograph"] | None = None


@router.post("/processes")
def precheck(payload: ProcessIn) -> dict:
    """规则预检：认出字段、标出缺口。不改变输入、不产生副作用。"""
    text = payload.text.strip()
    if len(text) < MIN_CHARS:
        raise HTTPException(
            status_code=422,
            detail={"code": "input_too_short", "message": f"工艺文本至少需要 {MIN_CHARS} 个字符"},
        )
    if len(payload.text) > MAX_CHARS:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "input_too_long",
                "message": f"工艺文本过长（{len(payload.text)} 字符），上限 {MAX_CHARS}",
            },
        )

    lines = [line for line in text.splitlines() if line.strip()]
    name = station = None
    tools: list[str] = []
    safety: list[str] = []
    steps: list[dict] = []

    for line in lines:
        matched = False
        for key, pattern in FIELD_RE.items():
            found = pattern.match(line)
            if not found:
                continue
            value = found.group(1).strip()
            if key == "tools":
                tools.extend(item.strip() for item in SPLIT_RE.split(value) if item.strip())
            elif key == "name":
                name = value[:80]
            else:
                station = value[:80]
            matched = True
            break
        if matched:
            continue

        found = SAFETY_RE.match(line)
        if found:
            safety.append(found.group(1).strip()[:160])
            continue

        step = STEP_RE.match(line)
        if step:
            action = step.group(3).strip()
            seq = int(step.group(1) or step.group(2) or len(steps) + 1)
            steps.append(_step(seq, action))
            continue

        bullet = BULLET_RE.match(line)
        if bullet:
            steps.append(_step(len(steps) + 1, bullet.group(1).strip()))

    # 没有编号也没有项目符号时，退化成"一行一步"，但只在行数足够多时才这么做：
    # 3 行以内的文本更可能是标题 + 说明，硬拆会把标题变成第 1 步。
    if not steps and len(lines) >= 4:
        for line in lines:
            if line.startswith(("工序", "工位", "工具", "安全", "注意")):
                continue
            steps.append(_step(len(steps) + 1, line.strip()))

    missing: list[str] = []
    if not name:
        missing.append("工序名称")
    if not station:
        missing.append("工位")
    if not tools:
        missing.append("工具")
    if not safety:
        missing.append("安全项")
    if not any(step["criterion_hint"] for step in steps):
        missing.append("可核对的判据")

    warnings: list[str] = []
    if len(steps) < 2:
        warnings.append("只识别到 1 个步骤：检查是否用了「1. 2. 3.」或「- 」编号")
    if len(steps) > 12:
        warnings.append(f"识别到 {len(steps)} 个步骤，超过 8 步的生成结果会被压缩，建议拆分")
    long_steps = [step["seq"] for step in steps if len(step["action"]) > 120]
    if long_steps:
        warnings.append(f"第 {'、'.join(map(str, long_steps))} 步超过 120 字，模型容易漏掉后半句")
    if not name and lines:
        warnings.append("没找到「工序：」开头的行，标题可能来自文件页眉，生成前建议补一行")

    return {
        "process": {
            "name": name,
            "station": station,
            "system": payload.system,
            "tools": tools[:10],
            "safety": safety[:10],
            "steps": steps[:20],
        },
        "missing": missing,
        "warnings": warnings,
        "stats": {
            "chars": len(text),
            "lines": len(lines),
            "steps": len(steps),
            "steps_with_criterion": sum(1 for step in steps if step["criterion_hint"]),
        },
        "next": "确认无误后调用 POST /api/electro/generate；本预检不消耗配额与预算",
    }


def _step(seq: int, action: str) -> dict:
    hint = CRITERION_RE.search(action)
    return {
        "seq": seq,
        "action": action[:200],
        "criterion_hint": hint.group(1).strip() if hint else None,
    }
