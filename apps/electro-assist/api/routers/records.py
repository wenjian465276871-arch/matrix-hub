"""作业记录：给打印页用的整份报告。

路径参数是 `session_id` 而不是单条 record id：现场要打印的是"这次作业"，
不是某一步。单条记录留在 `steps[].attempts[]` 里，异常链单独汇总。
"""
from __future__ import annotations

import re

from fastapi import APIRouter, HTTPException

from services import sessions as service

router = APIRouter(prefix="/api/electro/records", tags=["records"])

SESSION_ID_RE = re.compile(r"^s_[0-9a-f]{16}$")


@router.get("/{session_id}")
def get_report(session_id: str) -> dict:
    if not SESSION_ID_RE.match(session_id):
        raise HTTPException(status_code=404, detail={"code": "not_found"})
    try:
        return service.report(session_id)
    except service.SessionError as exc:
        raise HTTPException(
            status_code=exc.status,
            detail={"code": exc.code, "message": exc.message, **exc.extra},
        ) from exc
