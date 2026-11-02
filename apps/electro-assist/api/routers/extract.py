"""`POST /extract`：图片识别通道（双通道 ＋ 单通道回退）。

三条边界，缺一条就不能上线：
1. **不落库、不发布**：只回给确认页，`needs_review` 恒为 true；
2. **单独限流**：识别比生成贵（图片 token），不能和上传共用额度；
3. **失败也记账**：超时/截断同样烧了 token，漏记会让日预算在月底对不上。

通道策略（决策 #37，2026-11-01）：

- `EXTRACT_MODE=dual`（默认）：通道 A 只看图转录，通道 B 只吃文本出字段。
  两段独立调用，B 的输入就是可校验的原文。
- `EXTRACT_MODE=single`：原来的一次调用（`vision` 一把出 lines + fields）。

三种情况自动回退单通道，且**在返回里如实标注** `channels.fallback`：
通道 A 不按新提示词输出（解析失败）、通道 A 转录为空、通道 B 调用或解析失败。
回退不是静默的——前端要看得到"这次是单通道结果，核对要更仔细"。
"""
from __future__ import annotations

import base64
import logging
import os

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ValidationError

from core import assets
from core import ratelimit
import store
from llm import LLMError, get_provider
from llm.extract import (
    STRUCTURE_SYSTEM,
    SYSTEM_PROMPT,
    TRANSCRIBE_SYSTEM,
    ExtractPayload,
    StructurePayload,
    TranscribePayload,
    reconcile,
    structure_prompt,
    transcribe_prompt,
    user_prompt,
)
from llm.pricing import PRICE_VERSION, cost_micros
from llm.runner import extract_json
from services import quota as quota_service

router = APIRouter(prefix="/api/electro", tags=["extract"])

log = logging.getLogger("electro.extract")

MAX_IMAGES = 3
# 通道 A 要处理图片，给 60s；通道 B 只吃文本，45s 足够。
VISION_TIMEOUT_S = 60.0
TEXT_TIMEOUT_S = 45.0
# **不要按"输出多长"来估这个值**。deepseek-flash 默认走思考模式，reasoning
# 也计入 completion：2026-11-02 实测一张中文密集表格，reasoning 一个人吃掉
# 3000 tokens，正文一个字没输出就撞上上限（truncated）。
# 3000 是原来的值，就是那次失败的直接原因。给到 8192 才够「想清楚 + 说完」。
VISION_MAX_TOKENS = 8192
TEXT_MAX_TOKENS = 8192

# 单通道模式仍要能跑：老部署的环境变量里没有这个键时默认 dual。
DEFAULT_MODE = "dual"

_limiter: ratelimit.Limiter | None = None


def get_limiter() -> ratelimit.Limiter:
    global _limiter
    if _limiter is None:
        _limiter = ratelimit.Limiter(per_hour=3, per_day=8, site_per_day=30)
    return _limiter


def reset_limiter() -> None:
    """仅供测试：限流器是进程内单例。"""
    global _limiter
    _limiter = None


def mode() -> str:
    return (os.getenv("EXTRACT_MODE") or DEFAULT_MODE).strip().lower()


class ExtractIn(BaseModel):
    asset_ids: list[str]


def _load_images(ids: list[str]) -> list[str]:
    images: list[str] = []
    for asset_id in ids:
        if not assets.exists(asset_id):
            raise HTTPException(
                status_code=422,
                detail={"code": "asset_not_found", "message": f"图片 {asset_id} 不存在或已过期"},
            )
        with open(assets.asset_png(asset_id), "rb") as fh:
            images.append("data:image/png;base64," + base64.b64encode(fh.read()).decode("ascii"))
    return images


@router.post("/extract")
def extract(payload: ExtractIn, request: Request) -> dict:
    ids = [item.strip() for item in payload.asset_ids if item.strip()]
    if not ids:
        raise HTTPException(
            status_code=422,
            detail={"code": "assets_required", "message": "至少提供 1 张图片"},
        )
    if len(ids) > MAX_IMAGES:
        raise HTTPException(
            status_code=422,
            detail={"code": "too_many_assets", "message": f"一次最多识别 {MAX_IMAGES} 张"},
        )
    if len(set(ids)) != len(ids):
        raise HTTPException(
            status_code=422,
            detail={"code": "duplicate_asset", "message": "同一张图重复提交"},
        )

    images = _load_images(ids)

    # 先限流再调用：识别一次的成本是生成的数倍（图片 token），
    # 没有闸门就是一个可以烧穿日预算的入口。
    allowed, retry_after = get_limiter().hit(ratelimit.client_ip(request))
    if not allowed:
        raise HTTPException(
            status_code=429,
            detail={
                "code": "rate_limited",
                "message": f"识别过于频繁，请在 {retry_after} 秒后重试",
                "retry_after": retry_after,
            },
            headers={"Retry-After": str(retry_after)},
        )

    decision = quota_service.check(ratelimit.client_ip(request), unlimited=True)
    if not decision.ok:
        raise HTTPException(
            status_code=429,
            detail={"code": decision.code, "message": decision.message},
            headers={"Retry-After": str(decision.retry_after or 3600)},
        )

    try:
        provider = get_provider()
    except LLMError as exc:
        raise HTTPException(
            status_code=503,
            detail={
                "code": "vision_not_configured",
                "message": "服务端未配置模型密钥，图片识别不可用",
            },
        ) from exc

    # LLMError 必须在这里拦住。`_vision` 会重新抛出原始异常（它自己只负责记账），
    # 漏了这一层就会被 main.py 的兜底处理器接成 500「服务内部错误」，
    # 前端拿不到 504、用户看不到「超时」这两个字，日志里还多一份无用的堆栈。
    try:
        if mode() == "single":
            result, channels = _run_single(provider, images)
        else:
            result, channels = _run_dual(provider, images)
    except LLMError as exc:
        raise HTTPException(
            status_code=_status_for(exc.kind),
            detail={"code": f"extract_{exc.kind}", "message": str(exc)},
        ) from exc

    return {
        **result,
        "channels": channels,
        "disclaimer": "识别结果仅供录入，必须人工核对原图后才可作为作业依据",
    }


# ---------------------------------------------------------------- 两条路径


def _run_single(provider, images: list[str]) -> tuple[dict, dict]:
    """原路径：一次调用同时出 lines 与 fields。也是双通道失败时的退路。"""
    completion = _vision(provider, SYSTEM_PROMPT, user_prompt(len(images)), images)
    _record(completion)
    try:
        parsed = ExtractPayload.model_validate_json(extract_json(completion.text))
    except (ValueError, ValidationError) as exc:
        raise HTTPException(
            status_code=502,
            detail={
                "code": "extract_invalid",
                "message": "识别结果不是合法结构，请换一张更清晰的图重试",
            },
        ) from exc

    result = reconcile(parsed.lines, parsed.fields, parsed.warnings)
    return result, {
        "mode": "single",
        "fallback": None,
        "calls": 1,
        "model": completion.model,
        "latency_ms": completion.latency_ms,
    }


def _run_dual(provider, images: list[str]) -> tuple[dict, dict]:
    """通道 A 转录 → 通道 B 结构化。任一步不合规就退回单通道。"""
    try:
        a = _vision(provider, TRANSCRIBE_SYSTEM, transcribe_prompt(len(images)), images)
        _record(a)
        trans = TranscribePayload.model_validate_json(extract_json(a.text))
    except (ValueError, ValidationError):
        # 模型没按"只输出 lines"走（比如仍带了 fields）：这不是致命错误，
        # 说明通道 A 的约束没被遵守，直接走单通道，不必让用户重试。
        log.info("通道 A 输出不合规，回退单通道")
        return _fallback_single(provider, images, "transcribe_invalid")

    if not trans.lines:
        # 一张空转录没有任何可校验的东西：继续调通道 B 只会让它凭空编字段。
        return _fallback_single(provider, images, "transcribe_empty")

    try:
        b = provider.structured(  # type: ignore[attr-defined]
            system=STRUCTURE_SYSTEM,
            user=structure_prompt(trans.lines),
            schema={
                "type": "object",
                "properties": {"fields": {"type": "object"}, "warnings": {"type": "array"}},
            },
            timeout_s=TEXT_TIMEOUT_S,
            max_tokens=TEXT_MAX_TOKENS,
            # 结构化阶段只做排版，不需要推理链；关掉思考省一半延迟和四分之三成本。
            thinking=False,
        )
        _record(b)
        struct = StructurePayload.model_validate_json(extract_json(b.text))
    except (ValueError, ValidationError) as exc:
        log.info("通道 B 输出不合规，回退单通道：%s", exc)
        return _fallback_single(provider, images, "structure_invalid")
    except LLMError as exc:
        # 通道 A 的钱已经花了，B 失败的账也要记：失败不产生免费调用。
        _record_error(exc)
        log.warning("通道 B 调用失败，回退单通道：%s", exc)
        return _fallback_single(provider, images, f"structure_{exc.kind}")

    result = reconcile(trans.lines, struct.fields, [*trans.warnings, *struct.warnings])

    # 覆盖度：结构化阶段引用到的行数 / 总行数。低覆盖说明通道 B 只挑了一部分，
    # 这是"两通道到底有没有对上"的唯一可量化指标——不设阈值拦截，
    # 只如实报给确认页，让人决定要不要重识别。
    used = {step["source_line"] for step in result["fields"]["steps"]}
    used.discard(None)
    coverage = round(len(used) / len(trans.lines), 2) if trans.lines else 0.0

    return result, {
        "mode": "dual",
        "fallback": None,
        "calls": 2,
        "model": b.model,
        "latency_ms": a.latency_ms + b.latency_ms,
        "transcribe": {"lines": len(trans.lines), "latency_ms": a.latency_ms},
        "structure": {
            "steps": len(result["fields"]["steps"]),
            "coverage": coverage,
            "latency_ms": b.latency_ms,
        },
    }


def _fallback_single(provider, images: list[str], reason: str) -> tuple[dict, dict]:
    """退回单通道，并把原因写进 `channels.fallback`。

    不吞掉原因：前端要能告诉用户"这次只跑了一个通道"，
    否则两通道与单通道的结果长得一模一样，谁也不知道降级发生过。
    """
    result, channels = _run_single(provider, images)
    channels["fallback"] = reason
    channels["mode"] = "single"
    return result, channels


# ---------------------------------------------------------------- 调用与记账


def _vision(provider, system: str, user: str, images: list[str]):
    """包一层只为"失败也记账"：异常里带着已经花掉的 usage。"""
    try:
        return provider.vision(  # type: ignore[attr-defined]
            system=system,
            user=user,
            images=images,
            timeout_s=VISION_TIMEOUT_S,
            max_tokens=VISION_MAX_TOKENS,
        )
    except LLMError as exc:
        _record_error(exc)
        raise


def _status_for(kind: str) -> int:
    return {
        "timeout": 504,
        "rate_limit": 429,
        "auth": 503,
        "budget": 429,
    }.get(kind, 502)


def _record(completion) -> None:
    cost = cost_micros(completion.usage)
    total = completion.usage.prompt_tokens + completion.usage.completion_tokens
    if total <= 0 and cost <= 0:
        return
    store.record_usage(
        model=completion.model,
        prompt_tokens=completion.usage.prompt_tokens,
        completion_tokens=completion.usage.completion_tokens,
        reasoning_tokens=completion.usage.reasoning_tokens,
        cached_tokens=completion.usage.cached_tokens,
        cost_micros=cost,
        price_version=PRICE_VERSION,
    )


def _record_error(exc: LLMError) -> None:
    """失败也要记：只统计成功调用，预算熔断会在失败率最高时失灵。"""
    usage = exc.usage
    if usage is None:
        return
    total = usage.prompt_tokens + usage.completion_tokens
    if total <= 0 and exc.cost_micros <= 0:
        return
    store.record_usage(
        model="deepseek-flash",
        prompt_tokens=usage.prompt_tokens,
        completion_tokens=usage.completion_tokens,
        reasoning_tokens=usage.reasoning_tokens,
        cached_tokens=usage.cached_tokens,
        cost_micros=exc.cost_micros,
        price_version=PRICE_VERSION,
    )
