"""前端错误上报（FRONTEND §9 的 `_fe-error` 欠账）。

**为什么值得一个端点**：前端此前只有 `console.error`，线上白屏只能靠用户截图。
浏览器报错本身已经发生，与其让人描述"点了一下就没了"，不如收一条带路由与
错误号的记录，和 Nginx/Caddy 的访问日志、后端的 `X-Request-Id` 对得上。

四条硬约束：

1. **不落库**。这是运维线索，不是业务数据；写进 SQLite 就等于给公开站加了
   一个可以被匿名灌爆的表。只进日志，跟着日志轮转一起消失。
2. **限流独立**。报错循环（比如渲染函数每次重试都抛）会在几秒内打满额度，
   必须自己一个桶，不能挤占生成与排查的配额。
3. **字段全部截断**。堆栈可以几万字符，一条日志能撑爆 journald。
4. **清洗控制字符**。`\n` 混进 message 就能在日志里伪造一整行，
   让人以为发生了别的事——这是日志注入，不是洁癖。
"""
from __future__ import annotations

import logging
import os

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field

from core import ratelimit

router = APIRouter(prefix="/api/electro", tags=["ops"])

log = logging.getLogger("electro.fe")

MAX_MESSAGE = 300
MAX_STACK = 1200
MAX_TEXT = 120


def _make_limiter() -> ratelimit.Limiter:
    """单 IP 30/时、120/日，全站 600/日。

    数值取得比业务接口宽：一次白屏可能连报 5 条（渲染、路由、请求各一次），
    限太死会把最有价值的第一波信息丢掉。
    """
    return ratelimit.Limiter(
        per_hour=int(os.getenv("FE_ERROR_PER_HOUR", "30")),
        per_day=int(os.getenv("FE_ERROR_PER_DAY", "120")),
        site_per_day=int(os.getenv("FE_ERROR_SITE_PER_DAY", "600")),
    )


_limiter = _make_limiter()


def reset_limiter() -> None:
    """仅供测试：模块级单例不重置会让全量跑互相耗尽额度。"""
    global _limiter
    _limiter = _make_limiter()


class FeErrorIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    message: str = Field(min_length=1, max_length=MAX_MESSAGE)
    kind: str = Field(default="error", max_length=24)
    source: str = Field(default="", max_length=MAX_TEXT)
    route: str = Field(default="", max_length=MAX_TEXT)
    ref: str = Field(default="", max_length=32)
    stack: str = Field(default="", max_length=MAX_STACK)


def _clean(text: str, limit: int) -> str:
    """压成单行并截断：控制字符能伪造日志行，必须清掉。"""
    flat = " ".join(text.split())
    return flat[:limit]


@router.post("/fe-error", status_code=204)
def report(payload: FeErrorIn, request: Request) -> Response:
    """收一条前端错误。永远返回 204——上报失败不该再触发一次上报。"""
    allowed, retry_after = _limiter.hit(ratelimit.client_ip(request))
    if not allowed:
        # 429 而不是 204：让前端自己知道"别再发了"，避免它继续打。
        raise HTTPException(
            status_code=429,
            detail={"code": "rate_limited", "message": "错误上报过于频繁"},
            headers={"Retry-After": str(retry_after)},
        )

    ref = getattr(request.state, "ref", "-")
    log.warning(
        "前端错误 kind=%s route=%s ref=%s ip=%s source=%s message=%s stack=%s",
        _clean(payload.kind, 24),
        _clean(payload.route, MAX_TEXT),
        _clean(payload.ref, 32) or "-",
        ratelimit.client_ip(request),
        _clean(payload.source, MAX_TEXT) or "-",
        _clean(payload.message, MAX_MESSAGE),
        _clean(payload.stack, MAX_STACK) or "-",
    )
    return Response(status_code=204)
