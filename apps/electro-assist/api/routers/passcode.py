"""口令验证：用一次口令换一张短期令牌。

令牌只解决"能不能连续生成"，不解决身份与权限——没有用户体系，不做后台，
这是刻意的（决策 #16）。验证接口按 IP 限流，避免变成口令爆破入口。
"""
from __future__ import annotations

import os

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

import passcode
import ratelimit

router = APIRouter(prefix="/api/electro/passcode", tags=["passcode"])


class PasscodeIn(BaseModel):
    code: str = Field(min_length=1, max_length=64)


_limiter: ratelimit.Limiter | None = None


def get_limiter() -> ratelimit.Limiter:
    global _limiter
    if _limiter is None:
        _limiter = ratelimit.Limiter(
            per_hour=int(os.getenv("PASSCODE_PER_HOUR", "10")),
            per_day=int(os.getenv("PASSCODE_PER_DAY", "50")),
            site_per_day=int(os.getenv("PASSCODE_SITE_PER_DAY", "500")),
        )
    return _limiter


def reset_limiter() -> None:
    """仅供测试：限流器是进程内单例。"""
    global _limiter
    _limiter = None


@router.post("/verify")
def verify(body: PasscodeIn, request: Request) -> dict:
    if not passcode.enabled():
        raise HTTPException(
            status_code=503,
            detail={
                "code": "passcode_disabled",
                "message": "本站未启用口令通道",
            },
        )

    allowed, retry_after = get_limiter().hit(ratelimit.client_ip(request))
    if not allowed:
        raise HTTPException(
            status_code=429,
            detail={
                "code": "rate_limited",
                "message": f"验证过于频繁，请在 {retry_after} 秒后重试",
                "retry_after": retry_after,
            },
            headers={"Retry-After": str(retry_after)},
        )

    if not passcode.verify_code(body.code):
        # 不区分"口令错误"与"口令为空"：少一个可探测信号。
        raise HTTPException(
            status_code=401,
            detail={"code": "passcode_invalid", "message": "口令不正确"},
        )

    return passcode.issue()
