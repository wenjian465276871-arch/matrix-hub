"""B 模块入口：快速检索 + 逐步诊断。

快速检索：一次提问，一次回答，给候选条目与完整检查清单。
逐步诊断：把条目变成故障树，逐项回填实测值/确认结果，服务端给出下一步或结论。
返回里带 `uncovered_reason` 与 `message`：查不到就说查不到，不给似是而非的答案。
"""
from __future__ import annotations

import os
import re
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

import ratelimit
from models.guide import System
from services import diagnosis, knowledge

router = APIRouter(prefix="/api/electro/diagnose", tags=["diagnose"])
RUN_ID_RE = re.compile(r"^d_[0-9a-f]{16}$")

def _make_limiter() -> ratelimit.Limiter:
    """纯内存检索，成本几乎为零；限流只为避免被脚本刷日志与占 CPU。"""
    return ratelimit.Limiter(
        per_hour=int(os.getenv("DIAGNOSE_PER_HOUR", "60")),
        per_day=int(os.getenv("DIAGNOSE_PER_DAY", "300")),
        site_per_day=int(os.getenv("DIAGNOSE_SITE_PER_DAY", "3000")),
    )


_limiter = _make_limiter()


def reset_limiter() -> None:
    """仅测试使用。

    限流器是模块级单例，`ratelimit.reset_limiter()` 管不到它：
    不重置的话全量跑会被前面用例耗尽额度，表现为"单跑绿、全量 429"。
    """
    global _limiter
    _limiter = _make_limiter()


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


class RunIn(BaseModel):
    symptom: str = Field(min_length=4, max_length=200)
    system: System | None = None
    entry_id: str | None = Field(default=None, max_length=40)
    session_id: str | None = Field(default=None, max_length=40)


class CheckIn(BaseModel):
    result: Literal["pass", "fail"] | None = None
    value: float | None = None
    note: str = Field(default="", max_length=200)


def _limit(request: Request) -> None:
    allowed, retry = _limiter.hit(ratelimit.client_ip(request))
    if not allowed:
        raise HTTPException(
            status_code=429,
            detail={"code": "rate_limited", "message": "排查请求过于频繁，请稍后再试"},
            headers={"Retry-After": str(retry)},
        )


def _raise(exc: diagnosis.DiagnosisError) -> None:
    raise HTTPException(
        status_code=exc.status,
        detail={"code": exc.code, "message": exc.message},
    ) from exc


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


# ---------------------------------------------------------------- 逐步诊断（2026-10-21）


@router.post("/runs", status_code=201)
def start_run(body: RunIn, request: Request) -> dict:
    _limit(request)
    try:
        return diagnosis.start(
            body.symptom,
            system=body.system.value if body.system else None,
            entry_id=body.entry_id,
            session_id=body.session_id,
        )
    except diagnosis.DiagnosisError as exc:
        _raise(exc)
        raise  # pragma: no cover - _raise 必定抛出


@router.get("/runs/{run_id}")
def get_run(run_id: str) -> dict:
    if not RUN_ID_RE.match(run_id):
        raise HTTPException(status_code=404, detail={"code": "run_not_found"})
    try:
        return diagnosis.state(run_id)
    except diagnosis.DiagnosisError as exc:
        _raise(exc)
        raise  # pragma: no cover


@router.post("/runs/{run_id}/checks/{order}")
def submit_check(run_id: str, order: int, body: CheckIn, request: Request) -> dict:
    _limit(request)
    if not RUN_ID_RE.match(run_id):
        raise HTTPException(status_code=404, detail={"code": "run_not_found"})
    try:
        return diagnosis.submit(
            run_id,
            order,
            result=body.result,
            value=body.value,
            note=body.note,
        )
    except diagnosis.DiagnosisError as exc:
        _raise(exc)
        raise  # pragma: no cover


@router.post("/runs/{run_id}/abort")
def abort_run(run_id: str, request: Request) -> dict:
    _limit(request)
    if not RUN_ID_RE.match(run_id):
        raise HTTPException(status_code=404, detail={"code": "run_not_found"})
    try:
        return diagnosis.abort(run_id)
    except diagnosis.DiagnosisError as exc:
        _raise(exc)
        raise  # pragma: no cover
