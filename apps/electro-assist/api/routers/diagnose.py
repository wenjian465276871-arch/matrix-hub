"""B 模块入口：快速检索 + 逐步诊断。

快速检索：一次提问，一次回答，给候选条目与完整检查清单。
逐步诊断：把条目变成故障树，逐项回填实测值/确认结果，服务端给出下一步或结论。
返回里带 `uncovered_reason` 与 `message`：查不到就说查不到，不给似是而非的答案。

**流式（2026-11-01，决策 #36）**：`stream=1` 时按 recall → rerank → done 三帧推送。
此前 B 一律一次性 JSON，理由是"18 条、P95 毫秒级，没有可流的内容"。这话只说对一半：
召回确实是毫秒，但**重排是一次模型调用**，有 Key 时 1–4 秒。等的就是这一段，
而它前面已经能给出候选列表。CSV 式"假分帧"（把同一个结果切三段发）不做——
每帧必须是某一步真的完成了，否则不如不要。

**传输层重连（2026-11-08，决策 #45）**：请求头 `Last-Event-ID` 的值是**客户端最后
收到的事件名**（`recall` / `rerank` / `done`），服务端据此跳过该帧及之前所有帧。
不做跨请求续生成：重连会把被打断的那一步重跑一遍（重排多花一次模型调用，约 ¥0.002），
换来的是"客户端已看到的帧不重复、没看到的帧不丢"。
"""
from __future__ import annotations

import json
import logging
import os
import re
from collections.abc import Iterator
from typing import Literal

from fastapi import APIRouter, Header, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

from core import ratelimit
from models.guide import System
from services import diagnosis, knowledge

router = APIRouter(prefix="/api/electro/diagnose", tags=["diagnose"])
RUN_ID_RE = re.compile(r"^d_[0-9a-f]{16}$")
# `Last-Event-ID` 的可接受值：本接口会产出的事件名。
# 含 `error` 是因为它也是终止帧——客户端收到 error 后不该再重连。
RESUME_EVENTS = ("recall", "rerank", "done", "error")

log = logging.getLogger("electro.diagnose")

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


def _frame(event: str, payload: dict) -> str:
    """SSE 帧。`data` 必须是单行——JSON 里的真换行会被传输层当成帧边界。"""
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    return f"event: {event}\ndata: {body}\n\n"


def _stream(body: DiagnoseIn, resume_from: str | None = None) -> Iterator[str]:
    """把业务流程翻成帧。异常也要发帧，不能直接断开。

    客户端看到"连接被重置"只会说"页面卡住了"；收到 `event: error` 才能
    把 `message` 显示出来，也才知道该不该重试。

    `resume_from` 是客户端最后收到的事件名：跳过它及之前的所有帧。
    为什么要按事件名而不是字节偏移：三帧的边界就是阶段边界，没有"半帧"可续。
    """
    skipping = resume_from
    try:
        for event, payload in knowledge.iter_diagnose(
            body.symptom, system=body.system.value if body.system else None, top_k=body.top_k
        ):
            if skipping is not None:
                if event == skipping:
                    # 断点帧本身不再重发——客户端已经有了。
                    skipping = None
                continue
            if event == "done" and body.context is not None:
                payload["context"] = body.context.model_dump()
            yield _frame(event, payload)
        if skipping is not None:
            # 客户端报了一个本次流程不会产出的事件名（版本不一致、或伪造）。
            # 静默返回空流会让前端以为"卡住"，必须显式说清楚。
            log.warning("unknown Last-Event-ID: %s", skipping)
            yield _frame(
                "error",
                {
                    "stage": "error",
                    "code": "resume_mismatch",
                    "message": "断点位置无法识别，请重新发起排查",
                },
            )
    except Exception as exc:  # noqa: BLE001 - 流内异常只能靠帧传递
        log.exception("排查流式推送失败")
        yield _frame(
            "error",
            {
                "stage": "error",
                "code": "stream_failed",
                "message": "排查过程中出错，请重试；反复失败请改用非流式结果",
                "detail": str(exc)[:200],
            },
        )


@router.post("", response_model=None)
def diagnose(
    body: DiagnoseIn,
    request: Request,
    stream: bool = Query(False, description="true 时按 recall → rerank → done 三帧推送"),
    last_event_id: str | None = Header(
        default=None,
        alias="Last-Event-ID",
        description="客户端最后收到的事件名；只对 stream=1 生效",
    ),
) -> dict | StreamingResponse:
    """一次性 JSON 或 SSE，二选一。默认一次性：老客户端与 curl 都不用改。"""
    # 限流必须在返回响应之前做完：一旦开始流，HTTP 状态码已经发出去了，
    # 再发现超额只能发一个"429 帧"——那比直接 429 更难处理。
    # 重连请求**照常计数**：免限流等于给"反复断流"发一张免费重排券。
    allowed, retry = _limiter.hit(ratelimit.client_ip(request))
    if not allowed:
        raise HTTPException(
            status_code=429,
            detail={"code": "rate_limited", "message": "排查请求过于频繁，请稍后再试"},
            headers={"Retry-After": str(retry)},
        )

    if not stream:
        result = knowledge.diagnose(body.symptom, system=body.system, top_k=body.top_k)
        if body.context is not None:
            result["context"] = body.context.model_dump()
        return result

    # 白名单外的值一律当作没断点：最可能是旧版客户端或中间层乱加的头，
    # 正常返回结果比让用户看一条 `resume_mismatch` 更有用。
    resume_from = last_event_id if last_event_id in RESUME_EVENTS else None
    if last_event_id is not None and resume_from is None:
        log.warning("忽略非法 Last-Event-ID: %r", last_event_id[:40])

    return StreamingResponse(
        _stream(body, resume_from),
        media_type="text/event-stream; charset=utf-8",
        headers={
            "Cache-Control": "no-cache, no-store",
            # 中间层（CDN/反代）见到这个头就不缓冲；Caddy 另需 flush_interval -1。
            "X-Accel-Buffering": "no",
        },
    )


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
