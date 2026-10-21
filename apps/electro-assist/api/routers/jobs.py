"""异步生成：`POST /generate` 入队，`GET /jobs/{id}` 轮询。

接口刻意只回 job_id 与状态，不回模型原文：轮询响应要小，
而且错误细节（可能含用户文本）不应该出现在可被枚举的 URL 上。
"""
from __future__ import annotations

import re

from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel, Field

import passcode
import ratelimit
from services import generation

router = APIRouter(prefix="/api/electro", tags=["generate"])

JOB_ID_RE = re.compile(r"^j_[0-9a-f]{16}$")


class GenerateIn(BaseModel):
    text: str = Field(min_length=1, max_length=generation.MAX_INPUT_CHARS)
    retry_of: str | None = Field(default=None, max_length=64)


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
