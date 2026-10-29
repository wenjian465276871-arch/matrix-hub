"""配额查询：前端在生成页展示"今天还能生成几次"。

没有这个端点，用户只能在被 429 之后才知道额度用完了——
那是把服务端的约束变成用户的意外。
"""
from __future__ import annotations

from fastapi import APIRouter, Request

from core import ratelimit
from services import quota
from services.jobqueue import job_queue

router = APIRouter(prefix="/api/electro", tags=["quota"])


@router.get("/quota")
def get_quota(request: Request) -> dict:
    data = quota.snapshot(ratelimit.client_ip(request))
    data["queue"] = {"pending": job_queue.pending(), "limit": job_queue.maxsize}
    return data
