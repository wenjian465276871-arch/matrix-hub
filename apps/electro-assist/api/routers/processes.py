"""工艺文本：预检（`POST /processes`）、落库读取（`GET /processes/{id}`）、
从工艺重新生成（`POST /processes/{id}/generate`）。

预检**不是生成器**：不调模型、不产出 Guide。它回答一个更便宜的问题——
"这段文本里，系统认得出哪些字段、缺哪些字段"。

为什么值得单独一个端点：
- 生成一次要花配额与钱，缺工位/缺判据的文本照样能生成，但结果一定需要人补；
- 模型不会告诉你"你没写安全项"，它只会安静地留空；
- 规则解析 0 token、毫秒级，适合放在提交按钮前面当"提交前自检"。

工艺实体（2026-11-03 补）：计划 §3.5 原本写"创建工艺"，决策 #22 落地时收窄成
无状态预检，理由是"没有消费者"。现在消费者有了——详情页要拿同一份文本重新生成，
而原文此前只活在内存队列里，任务一结束就没了。落库范围刻意最小：只存原文 +
派生标题，**不存预检结果**（预检是解析规则的确定性输出，存下来只会与规则漂移）。
落库是可选动作：`save=false` 仍是纯预检，老调用方行为不变。
"""
from __future__ import annotations

import os
import re
from typing import Literal

from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel, Field

import store
from core import passcode, ratelimit
from routers.jobs import AssetIn, normalize_assets
from services import generation

router = APIRouter(prefix="/api/electro", tags=["processes"])

MIN_CHARS = 10
MAX_CHARS = 20_000
PROCESS_ID_RE = re.compile(r"^p_[0-9a-f]{16}$")
MAX_TITLE_CHARS = 80

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
    # 落库是可选动作：预检是"看一眼"，保存是"我要留着以后重新生成"。
    save: bool = False
    title: str | None = Field(default=None, max_length=MAX_TITLE_CHARS)


class ProcessGenerateIn(BaseModel):
    retry_of: str | None = Field(default=None, max_length=64)
    assets: list[AssetIn] = Field(default_factory=list, max_length=4)


_limiter: ratelimit.Limiter | None = None


def get_limiter() -> ratelimit.Limiter:
    """保存工艺会写库：不设限，一个脚本就能把演示站的 SQLite 灌满。"""
    global _limiter
    if _limiter is None:
        _limiter = ratelimit.Limiter(
            per_hour=int(os.getenv("PROCESS_SAVE_PER_HOUR", "20")),
            per_day=int(os.getenv("PROCESS_SAVE_PER_DAY", "60")),
            site_per_day=int(os.getenv("PROCESS_SAVE_SITE_PER_DAY", "300")),
        )
    return _limiter


def reset_limiter() -> None:
    """仅供测试：限流器是进程内单例。"""
    global _limiter
    _limiter = None


def _require_token(token: str | None) -> None:
    """与 `/generate` 同一口径：带了令牌就必须有效，否则静默降级会骗人。"""
    if token and not passcode.verify_token(token):
        raise HTTPException(
            status_code=401,
            detail={"code": "passcode_invalid", "message": "口令令牌无效或已过期，请重新验证"},
        )


@router.post("/processes")
def precheck(payload: ProcessIn, request: Request) -> dict:
    """规则预检：认出字段、标出缺口；`save=true` 时顺带把原文落库。

    预检本身仍不产生副作用——`save` 是显式请求，默认关闭。
    """
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

    process_id: str | None = None
    if payload.save:
        allowed, retry_after = get_limiter().hit(ratelimit.client_ip(request))
        if not allowed:
            raise HTTPException(
                status_code=429,
                detail={
                    "code": "rate_limited",
                    "message": f"保存过于频繁，请在 {retry_after} 秒后重试",
                    "retry_after": retry_after,
                },
                headers={"Retry-After": str(retry_after)},
            )
        title = (payload.title or name or generation.derive_process_title(text)).strip()
        created = store.create_process(
            text=text, title=title or "未命名工艺", system=payload.system or ""
        )
        process_id = created["id"]

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
        "process_id": process_id,
        "next": (
            f"已保存为 {process_id}，可用 POST /api/electro/processes/{process_id}/generate 生成"
            if process_id
            else "确认无误后调用 POST /api/electro/generate；本预检不消耗配额与预算"
        ),
    }


@router.get("/processes/{process_id}")
def get_process(process_id: str) -> dict:
    """取回工艺原文。随机 id、不枚举——与指导书同一套可见性口径。"""
    if not PROCESS_ID_RE.match(process_id):
        raise HTTPException(status_code=404, detail={"code": "not_found"})
    row = store.get_process(process_id)
    if row is None:
        raise HTTPException(
            status_code=404,
            detail={"code": "process_not_found", "message": "工艺不存在或已过期（保留 30 天）"},
        )
    return {
        "id": row["id"],
        "title": row["title"],
        "system": row["system"] or None,
        "chars": row["chars"],
        "text": row["text"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


@router.post("/processes/{process_id}/generate", status_code=202)
def generate_from_process(
    process_id: str,
    body: ProcessGenerateIn,
    request: Request,
    x_passcode_token: str | None = Header(default=None, alias="X-Passcode-Token"),
) -> dict:
    """用已保存的工艺重新生成。

    配额、预算、队列与 `/generate` 完全同一套（都走 `generation.submit`）：
    换个入口不等于换个额度，否则这里就是绕过限流的后门。
    """
    if not PROCESS_ID_RE.match(process_id):
        raise HTTPException(status_code=404, detail={"code": "not_found"})
    _require_token(x_passcode_token)
    row = store.get_process(process_id)
    if row is None:
        raise HTTPException(
            status_code=404,
            detail={"code": "process_not_found", "message": "工艺不存在或已过期（保留 30 天）"},
        )

    try:
        job_id = generation.submit(
            row["text"],
            ratelimit.client_ip(request),
            body.retry_of,
            privileged=bool(x_passcode_token),
            assets=normalize_assets(body.assets),
            process_id=row["id"],
        )
    except generation.GenerateRejected as exc:
        headers = {"Retry-After": str(exc.retry_after)} if exc.retry_after else None
        raise HTTPException(
            status_code=exc.status,
            detail={
                "code": exc.code,
                "message": exc.message,
                "retry_after": exc.retry_after,
            },
            headers=headers,
        ) from exc

    return {
        "job_id": job_id,
        "status": "queued",
        "process_id": row["id"],
        "poll_after_ms": 1000,
    }


def _step(seq: int, action: str) -> dict:
    hint = CRITERION_RE.search(action)
    return {
        "seq": seq,
        "action": action[:200],
        "criterion_hint": hint.group(1).strip() if hint else None,
    }
