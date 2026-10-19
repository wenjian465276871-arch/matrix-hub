"""A1 会话与步骤提交。

三个端点分别对应现场的三个动作：开始、报一步、结束。
提交必须带 `Idempotency-Key`：现场网络不稳，重投是常态，服务端必须能认出
"这是同一次提交"而不是"又做了一遍"。
"""
from __future__ import annotations

import re
from typing import Any, Literal

from fastapi import APIRouter, Header, HTTPException, Path, Request
from pydantic import BaseModel, Field

import ratelimit
from services import sessions as service

router = APIRouter(prefix="/api/electro/sessions", tags=["sessions"])

SESSION_ID_RE = re.compile(r"^s_[0-9a-f]{16}$")
KEY_RE = re.compile(r"^[A-Za-z0-9:_.-]{8,128}$")


class StartIn(BaseModel):
    guide_id: str = Field(pattern=r"^g_[a-z0-9_]{5,31}$")
    device: str = Field(default="", max_length=40)
    location: str = Field(default="", max_length=40)


class StepIn(BaseModel):
    values: dict[str, Any] = Field(default_factory=dict)
    note: str = Field(default="", max_length=500)


class FinishIn(BaseModel):
    status: Literal["done", "aborted"] = "done"
    note: str = Field(default="", max_length=300)


def _raise(exc: service.SessionError) -> None:
    raise HTTPException(
        status_code=exc.status,
        detail={"code": exc.code, "message": exc.message, **exc.extra},
    )


def _check_session_id(session_id: str) -> None:
    if not SESSION_ID_RE.match(session_id):
        raise HTTPException(status_code=404, detail={"code": "session_not_found"})


@router.post("", status_code=201)
def start(body: StartIn, request: Request) -> dict:
    try:
        return service.start(
            body.guide_id,
            device=body.device,
            location=body.location,
            client_ip=ratelimit.client_ip(request),
        )
    except service.SessionError as exc:
        _raise(exc)
        raise  # pragma: no cover - _raise 一定抛异常


@router.get("/{session_id}")
def get_session(session_id: str) -> dict:
    _check_session_id(session_id)
    try:
        return service.snapshot(session_id)
    except service.SessionError as exc:
        _raise(exc)
        raise  # pragma: no cover


@router.post("/{session_id}/steps/{seq}")
def submit_step(
    session_id: str,
    body: StepIn,
    seq: int = Path(ge=1, le=99),
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> dict:
    _check_session_id(session_id)
    if idempotency_key is None or not KEY_RE.match(idempotency_key):
        raise HTTPException(
            status_code=400,
            detail={
                "code": "idempotency_key_required",
                "message": "提交步骤必须带 Idempotency-Key（8–128 位字母、数字或 :_.-）",
            },
        )
    try:
        return service.submit(
            session_id,
            seq,
            body.values,
            note=body.note,
            idempotency_key=idempotency_key,
        )
    except service.SessionError as exc:
        _raise(exc)
        raise  # pragma: no cover


@router.post("/{session_id}/finish")
def finish(session_id: str, body: FinishIn) -> dict:
    _check_session_id(session_id)
    try:
        return service.finish(session_id, body.status, body.note)
    except service.SessionError as exc:
        _raise(exc)
        raise  # pragma: no cover
