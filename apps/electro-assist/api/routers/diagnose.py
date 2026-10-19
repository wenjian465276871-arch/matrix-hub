"""B 模块入口：一次提问，一次回答。

刻意不做多轮对话：现场的排查是"我给你现象，你给我下一步查什么"，
多轮会把责任推回给系统，而系统并不知道现场看到了什么。
返回里带 `uncovered_reason` 与 `message`：查不到就说查不到，不给似是而非的答案。
"""
from __future__ import annotations

import os

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

import ratelimit
from models.guide import System
from services import knowledge

router = APIRouter(prefix="/api/electro/diagnose", tags=["diagnose"])

# 纯内存检索，成本几乎为零；限流只为避免被脚本刷日志与占 CPU。
_limiter = ratelimit.Limiter(
    per_hour=int(os.getenv("DIAGNOSE_PER_HOUR", "60")),
    per_day=int(os.getenv("DIAGNOSE_PER_DAY", "300")),
    site_per_day=int(os.getenv("DIAGNOSE_SITE_PER_DAY", "3000")),
)


class Context(BaseModel):
    """从 A1 异常分支带过来的上下文，只用于回显与后续统计。"""

    model_config = ConfigDict(extra="forbid")

    guide_id: str | None = Field(default=None, max_length=40)
    step_seq: int | None = Field(default=None, ge=1, le=99)
    criterion_id: str | None = Field(default=None, max_length=40)


class DiagnoseIn(BaseModel):
    symptom: str = Field(min_length=4, max_length=200, description="现场现象，用现场的话说")
    system: System | None = None
    top_k: int = Field(default=3, ge=1, le=5)
    context: Context | None = None


@router.post("")
def diagnose(body: DiagnoseIn, request: Request) -> dict:
    allowed, retry = _limiter.hit(ratelimit.client_ip(request))
    if not allowed:
        raise HTTPException(
            status_code=429,
            detail={"code": "rate_limited", "message": "排查请求过于频繁，请稍后再试"},
            headers={"Retry-After": str(retry)},
        )

    result = knowledge.diagnose(body.symptom, system=body.system, top_k=body.top_k)
    if body.context is not None:
        result["context"] = body.context.model_dump()
    return result


@router.get("/kb")
def kb_overview() -> dict:
    """列出知识库覆盖范围。前端用它告诉用户"能问什么"，而不是让人盲试。"""
    provider = knowledge.get_provider()
    entries = provider.entries()
    return {
        "version": provider.version,
        "provider": provider.name,
        "systems": sorted(provider.systems()),
        "count": len(entries),
        "entries": [
            {"id": e.id, "title": e.title, "system": e.system.value} for e in entries
        ],
    }
