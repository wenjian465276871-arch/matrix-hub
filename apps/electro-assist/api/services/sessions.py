"""A1 引导：会话状态机 + 判据校验 + 记录。

状态机只有四个状态：`active → done` / `active → aborted`，另有隐式的
"当前步（current_seq）"。没有"跳过"——现场作业跳过一步不需要系统批准，
但系统不能假装那一步做过。

两条铁律：

1. **判定由服务端算**。客户端传来的 `verdict` 一律不信；否则改一下请求体
   就能把超差变成合格。
2. **失败不推进**。`fail`/`warn` 只落记录，`current_seq` 留在原地等复测或中止；
   只有 `pass`/`manual` 才前进。
"""
from __future__ import annotations

import os
import threading
import time
from datetime import datetime, timezone

import store
from models.guide import Guide
from services import criteria, library

# 会话创建是无需参数的写入端点，公开站必须有个上限，
# 否则一个脚本可以把 sessions 表刷到几十万行。进程内滑窗，重启清零。
SESSION_PER_HOUR = int(os.getenv("SESSION_PER_HOUR", "10"))
_session_hits: dict[str, list[float]] = {}
_session_lock = threading.Lock()


def reset_rate_limit() -> None:
    """仅供测试：清空进程内会话创建记录。"""
    with _session_lock:
        _session_hits.clear()


def _check_rate(client_ip: str) -> None:
    now = time.monotonic()
    with _session_lock:
        hits = [t for t in _session_hits.get(client_ip, []) if now - t < 3600]
        if len(hits) >= SESSION_PER_HOUR:
            retry = max(1, int(3600 - (now - hits[0])))
            raise SessionError(
                "rate_limited",
                f"每小时最多创建 {SESSION_PER_HOUR} 次作业，请稍后再试",
                status=429,
                extra={"retry_after": retry},
            )
        hits.append(now)
        _session_hits[client_ip] = hits


class SessionError(Exception):
    def __init__(
        self,
        code: str,
        message: str,
        *,
        status: int = 409,
        extra: dict | None = None,
    ):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.extra = extra or {}


def _load(session_id: str) -> tuple[dict, Guide, dict]:
    session = store.get_session(session_id)
    if session is None:
        raise SessionError("session_not_found", "作业会话不存在", status=404)

    found = library.get_detail(session["guide_id"])
    if found is None:
        raise SessionError("guide_missing", "会话关联的指导书已不存在", status=409)

    guide_dict, _status = found
    try:
        guide = Guide.model_validate(guide_dict)
    except Exception as exc:  # noqa: BLE001 - 库里的数据坏了是服务端问题，但要可读
        raise SessionError("guide_invalid", f"指导书数据无效：{exc}", status=409) from exc
    return session, guide, guide_dict


def start(guide_id: str, *, device: str = "", location: str = "", client_ip: str = "") -> dict:
    _check_rate(client_ip or "unknown")
    if library.get_detail(guide_id) is None:
        raise SessionError("guide_not_found", "指导书不存在", status=404)
    session_id = store.create_session(guide_id, device=device, location=location)
    return snapshot(session_id)


def snapshot(session_id: str) -> dict:
    session, guide, guide_dict = _load(session_id)
    records = store.list_records(session_id)
    return {
        "session": session,
        "guide": guide_dict,
        "records": records,
        "progress": {
            "total_steps": len(guide.steps),
            "recorded_steps": len({r["step_id"] for r in records}),
            "attempts": len(records),
            "current_seq": session["current_seq"],
        },
    }


def _response(record: dict, duplicate: bool) -> dict:
    session = store.get_session(record["session_id"])
    results = record["payload"].get("results", [])
    return {
        "record": record,
        "session": session,
        "verdict": record["verdict"],
        "results": results,
        "messages": [item.get("message", "") for item in results],
        "duplicate": duplicate,
    }


def submit(
    session_id: str,
    seq: int,
    values: dict,
    *,
    note: str = "",
    idempotency_key: str,
) -> dict:
    # 幂等必须排在顺序检查之前：成功后 current_seq 已前进，旧 seq 的重投会被误判乱序。
    existing = store.get_record_by_key(idempotency_key)
    if existing is not None:
        return _response(existing, duplicate=True)

    session, guide, _ = _load(session_id)
    if session["status"] != "active":
        raise SessionError("session_closed", "该作业已结束，不能继续提交", status=409)
    if seq < 1 or seq > len(guide.steps):
        raise SessionError("step_not_found", f"第 {seq} 步不存在", status=404)
    if seq < session["current_seq"]:
        raise SessionError(
            "step_already_passed",
            f"第 {seq} 步已通过，不能重复提交；如需复测请重新发起作业",
            status=409,
        )
    if seq > session["current_seq"]:
        raise SessionError(
            "out_of_order",
            f"当前应执行第 {session['current_seq']} 步，收到第 {seq} 步",
            status=409,
            extra={"expected_seq": session["current_seq"]},
        )

    step = guide.steps[seq - 1]
    try:
        verdict, results = criteria.evaluate_step(step, values)
    except criteria.CriterionError as exc:
        raise SessionError(
            exc.code,
            exc.message,
            status=422,
            extra={"criterion_id": exc.criterion_id},
        ) from exc

    payload = {
        "step_title": step.title,
        "results": [item.to_dict() for item in results],
        "note": (note or "").strip()[:500],
    }
    record_id, duplicate, error, _attempt = store.submit_step(
        session_id=session_id,
        step_id=step.id,
        seq=seq,
        verdict=verdict,
        payload=payload,
        idempotency_key=idempotency_key,
    )

    if error == "not_found":
        raise SessionError("session_not_found", "作业会话不存在", status=404)
    if error == "closed":
        raise SessionError("session_closed", "该作业已结束，不能继续提交", status=409)
    if error == "out_of_order":
        current = store.get_session(session_id)
        raise SessionError(
            "out_of_order",
            f"当前应执行第 {current['current_seq']} 步" if current else "步骤顺序冲突",
            status=409,
            extra={"expected_seq": current["current_seq"] if current else None},
        )

    record = store.get_record(record_id) if record_id else None
    if record is None:
        raise SessionError("record_missing", "记录写入后未能读回", status=500)
    return _response(record, duplicate=duplicate)


def finish(session_id: str, status: str, note: str = "") -> dict:
    session, guide, _ = _load(session_id)
    if session["status"] != "active":
        raise SessionError("session_closed", "该作业已结束", status=409)
    if status == "done" and session["current_seq"] <= len(guide.steps):
        raise SessionError(
            "steps_incomplete",
            f"还有步骤未通过（当前第 {session['current_seq']} 步），不能标记完成",
            status=409,
            extra={"expected_seq": session["current_seq"]},
        )
    store.finish_session(session_id, status, note=note)  # type: ignore[arg-type]
    return snapshot(session_id)


def _duration_s(session: dict) -> int:
    try:
        started = datetime.fromisoformat(session["created_at"])
        ended = (
            datetime.fromisoformat(session["finished_at"])
            if session.get("finished_at")
            else datetime.now(timezone.utc)
        )
        return max(0, int((ended - started).total_seconds()))
    except (ValueError, TypeError):
        return 0


def report(session_id: str) -> dict:
    session, guide, guide_dict = _load(session_id)
    records = store.list_records(session_id)

    by_step: dict[str, list[dict]] = {}
    for record in records:
        by_step.setdefault(record["step_id"], []).append(record)

    steps = []
    latest: list[dict] = []
    for step in guide.steps:
        attempts = by_step.get(step.id, [])
        if attempts:
            latest.append(attempts[-1])
        steps.append(
            {
                "seq": step.seq,
                "step_id": step.id,
                "title": step.title,
                "attempts": attempts,
                "final_verdict": attempts[-1]["verdict"] if attempts else "skipped",
            }
        )

    exceptions = []
    for record in records:
        if record["verdict"] not in ("fail", "warn"):
            continue
        messages = [
            item.get("message", "")
            for item in record["payload"].get("results", [])
            if item.get("verdict") in ("fail", "warn")
        ]
        exceptions.append(
            {
                "seq": record["seq"],
                "step_id": record["step_id"],
                "attempt": record["attempt"],
                "verdict": record["verdict"],
                "messages": messages,
                "note": record["payload"].get("note", ""),
                "created_at": record["created_at"],
            }
        )

    def count(verdict: str) -> int:
        return sum(1 for r in latest if r["verdict"] == verdict)

    return {
        "session": session,
        "guide": guide_dict,
        "steps": steps,
        "exceptions": exceptions,
        "summary": {
            "status": session["status"],
            "total_steps": len(guide.steps),
            "recorded_steps": len({r["step_id"] for r in records}),
            "attempts": len(records),
            "pass": count("pass"),
            "manual": count("manual"),
            "fail": count("fail"),
            "warn": count("warn"),
            "aborted": session["status"] == "aborted",
            "duration_s": _duration_s(session),
        },
    }
