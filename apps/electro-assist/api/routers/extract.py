"""`POST /extract`：图片识别通道。

三条边界，缺一条就不能上线：
1. **不落库、不发布**：只回给确认页，`needs_review` 恒为 true；
2. **单独限流**：识别比生成贵（图片 token），不能和上传共用额度；
3. **失败也记账**：超时/截断同样烧了 token，漏记会让日预算在月底对不上。
"""
from __future__ import annotations

import base64
import logging

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ValidationError

import assets
import ratelimit
import store
from llm import LLMError, get_provider
from llm.extract import (
    SYSTEM_PROMPT,
    ExtractPayload,
    reconcile,
    user_prompt,
)
from llm.pricing import PRICE_VERSION, cost_micros
from llm.runner import extract_json
from services import quota as quota_service

router = APIRouter(prefix="/api/electro", tags=["extract"])

log = logging.getLogger("electro.extract")

MAX_IMAGES = 3
CALL_TIMEOUT_S = 60.0
MAX_TOKENS = 3000

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


class ExtractIn(BaseModel):
    asset_ids: list[str]


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

    images: list[str] = []
    for asset_id in ids:
        if not assets.exists(asset_id):
            raise HTTPException(
                status_code=422,
                detail={"code": "asset_not_found", "message": f"图片 {asset_id} 不存在或已过期"},
            )
        with open(assets.asset_png(asset_id), "rb") as fh:
            images.append("data:image/png;base64," + base64.b64encode(fh.read()).decode("ascii"))

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

    try:
        completion = provider.vision(  # type: ignore[attr-defined]
            system=SYSTEM_PROMPT,
            user=user_prompt(len(images)),
            images=images,
            timeout_s=CALL_TIMEOUT_S,
            max_tokens=MAX_TOKENS,
        )
    except LLMError as exc:
        _record(completion_model=None, usage=exc.usage, cost=exc.cost_micros)
        raise HTTPException(
            status_code=_status_for(exc.kind),
            detail={"code": f"extract_{exc.kind}", "message": str(exc)},
        ) from exc

    cost = cost_micros(completion.usage)
    _record(completion_model=completion.model, usage=completion.usage, cost=cost)

    try:
        body = extract_json(completion.text)
        parsed = ExtractPayload.model_validate_json(body)
    except (ValueError, ValidationError) as exc:
        raise HTTPException(
            status_code=502,
            detail={
                "code": "extract_invalid",
                "message": "识别结果不是合法结构，请换一张更清晰的图重试",
            },
        ) from exc

    result = reconcile(parsed)
    return {
        **result,
        "disclaimer": "识别结果仅供录入，必须人工核对原图后才可作为作业依据",
        "model": completion.model,
        "latency_ms": completion.latency_ms,
        "cost_micros": cost,
    }


def _status_for(kind: str) -> int:
    return {
        "timeout": 504,
        "rate_limit": 429,
        "auth": 503,
        "budget": 429,
    }.get(kind, 502)


def _record(*, completion_model: str | None, usage, cost: int) -> None:
    """失败也要记：只统计成功调用，预算熔断会在失败率最高时失灵。"""
    total = usage.prompt_tokens + usage.completion_tokens
    if total <= 0 and cost <= 0:
        return
    store.record_usage(
        model=completion_model or "deepseek-flash",
        prompt_tokens=usage.prompt_tokens,
        completion_tokens=usage.completion_tokens,
        reasoning_tokens=usage.reasoning_tokens,
        cached_tokens=usage.cached_tokens,
        cost_micros=cost,
        price_version=PRICE_VERSION,
    )
