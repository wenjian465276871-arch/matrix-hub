"""异步生成：`POST /generate` 入队，`GET /jobs/{id}` 轮询。

接口刻意只回 job_id 与状态，不回模型原文：轮询响应要小，
而且错误细节（可能含用户文本）不应该出现在可被枚举的 URL 上。
"""
from __future__ import annotations

import re

from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel, Field

import assets as asset_store
import passcode
import ratelimit
from models.guide import ASSET_ID_RE
from services import generation

router = APIRouter(prefix="/api/electro", tags=["generate"])

JOB_ID_RE = re.compile(r"^j_[0-9a-f]{16}$")
MAX_ASSETS_PER_JOB = 4


class AssetIn(BaseModel):
    """提交素材：只传 id 与说明，不传路径、不传 URL。

    路径由服务端按 id 拼，客户端给的东西一律当成不可信输入——
    否则 `../../etc/passwd` 这种字符串会顺着"图片地址"流进渲染层。
    """

    asset_id: str = Field(pattern=ASSET_ID_RE)
    caption: str | None = Field(default=None, max_length=60)


class GenerateIn(BaseModel):
    text: str = Field(min_length=1, max_length=generation.MAX_INPUT_CHARS)
    retry_of: str | None = Field(default=None, max_length=64)
    # 现场素材是可选输入；上限 4 张，够一份工序用，也不至于让草稿变成相册。
    assets: list[AssetIn] = Field(default_factory=list, max_length=MAX_ASSETS_PER_JOB)


def _normalize_assets(items: list[AssetIn]) -> list[dict[str, str]]:
    """把请求里的素材收紧成「确定存在」的 (id, 说明) 列表。

    没有这一步，用户传错 id 也能提交成功，等到详情页才发现图裂开——
    那时配额已经扣了，还得重新生成一次。宁可在入口 422。
    """
    seen: set[str] = set()
    ready: list[dict[str, str]] = []
    for index, item in enumerate(items, start=1):
        if item.asset_id in seen:
            raise HTTPException(
                status_code=422,
                detail={"code": "asset_duplicate", "message": "同一张图提交了两次"},
            )
        seen.add(item.asset_id)
        if not asset_store.exists(item.asset_id):
            raise HTTPException(
                status_code=422,
                detail={
                    "code": "asset_not_found",
                    "message": "素材不存在或已过期，请重新上传后再生成",
                },
            )
        caption = (item.caption or "").strip() or f"图 {index}"
        ready.append({"asset_id": item.asset_id, "caption": caption})
    return ready


@router.post("/generate", status_code=202)
def generate(
    body: GenerateIn,
    request: Request,
    x_passcode_token: str | None = Header(default=None, alias="X-Passcode-Token"),
) -> dict:
    # 令牌无效时明确报错，而不是静默降级成普通访客：
    # 否则用户会以为口令生效了，直到第 3 次生成才撞上 429。
    if x_passcode_token and not passcode.verify_token(x_passcode_token):
        raise HTTPException(
            status_code=401,
            detail={"code": "passcode_invalid", "message": "口令令牌无效或已过期，请重新验证"},
        )

    try:
        job_id = generation.submit(
            body.text,
            ratelimit.client_ip(request),
            body.retry_of,
            privileged=bool(x_passcode_token),
            assets=_normalize_assets(body.assets),
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

    return {"job_id": job_id, "status": "queued", "poll_after_ms": 1000}


@router.get("/jobs/{job_id}")
def get_job(job_id: str) -> dict:
    if not JOB_ID_RE.match(job_id):
        raise HTTPException(status_code=404, detail={"code": "not_found"})
    snapshot = generation.snapshot(job_id)
    if snapshot is None:
        raise HTTPException(status_code=404, detail={"code": "not_found"})
    return snapshot
