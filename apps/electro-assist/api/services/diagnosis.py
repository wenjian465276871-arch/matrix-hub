"""B 模块的逐步诊断：故障树 + 测量值回填。

与 A1 的区别：
- A1 是"照着指导书做"，每一步的判据来自 Guide；
- 这里是从一个故障现象出发，顺着知识条目里的检查项走，**某一项异常就收敛到结论**，
  不用把整张清单做完。结论带原因、处置、升级条件与安全提示。
- 仍然不生成事实：所有原因/处置都来自人工整理的知识条目，模型只参与候选重排。

状态机：active → (pass 且还有下一项) active → (fail 或走完) concluded；任意时刻可 aborted。
"""
from __future__ import annotations

from dataclasses import dataclass

import store
from models.knowledge import Check, KnowledgeEntry

from . import knowledge

DISCLAIMER = "演示数据 · 非实际作业依据"


@dataclass
class DiagnosisError(Exception):
    code: str
    message: str
    status: int = 400

    def __str__(self) -> str:  # pragma: no cover - 仅日志可读性
        return f"[{self.code}] {self.message}"


def _entry_payload(entry: KnowledgeEntry) -> dict:
    return {
        "id": entry.id,
        "title": entry.title,
        "system": entry.system.value,
        "symptoms": entry.symptoms,
        "likely_causes": entry.likely_causes,
        "checks": [check.model_dump() for check in entry.checks],
        "escalation": entry.escalation,
        "safety": entry.safety,
        "sources": entry.sources,
    }


def _run_payload(run: dict) -> dict:
    return {
        "id": run["id"],
        "entry_id": run["entry_id"],
        "symptom": run["symptom"],
        "system": run["system"],
        "session_id": run["session_id"],
        "status": run["status"],
        "current_order": run["current_order"],
        "conclusion": run.get("conclusion"),
        "created_at": run["created_at"],
        "updated_at": run["updated_at"],
        "finished_at": run["finished_at"],
    }


def _steps_payload(steps: list[dict]) -> list[dict]:
    return [
        {
            "check_order": step["check_order"],
            "verdict": step["verdict"],
            "value": step["value"],
            "note": step["note"],
            "created_at": step["created_at"],
        }
        for step in steps
    ]


def _check_by_order(entry: KnowledgeEntry, order: int | None) -> Check | None:
    if order is None:
        return None
    return next((check for check in entry.checks if check.order == order), None)


def _first_order(entry: KnowledgeEntry) -> int:
    return min(check.order for check in entry.checks)


def _next_order(entry: KnowledgeEntry, current: Check) -> int | None:
    if current.next is not None:
        return current.next
    later = sorted(check.order for check in entry.checks if check.order > current.order)
    return later[0] if later else None


def _conclusion_fail(entry: KnowledgeEntry, check: Check) -> dict:
    cause = check.on_fail or f"检查项「{check.action}」异常，期望：{check.expect}"
    return {
        "kind": "fail",
        "check_order": check.order,
        "cause": cause,
        "action": entry.escalation,
        "safety": entry.safety,
        "sources": entry.sources,
    }


def _conclusion_exhausted(entry: KnowledgeEntry) -> dict:
    return {
        "kind": "exhausted",
        "check_order": None,
        "cause": "已按顺序完成全部检查，未定位到单一原因",
        "action": entry.escalation,
        "safety": entry.safety,
        "sources": entry.sources,
    }


def _conclusion_aborted(entry: KnowledgeEntry) -> dict:
    return {
        "kind": "aborted",
        "check_order": None,
        "cause": "诊断已中止",
        "action": entry.escalation,
        "safety": entry.safety,
        "sources": entry.sources,
    }


def state(run_id: str) -> dict:
    run = store.get_diagnose_run(run_id)
    if run is None:
        raise DiagnosisError("run_not_found", "诊断会话不存在", 404)
    entry = knowledge.get_entry(run["entry_id"])
    if entry is None:
        raise DiagnosisError("entry_not_found", "知识条目已不存在", 410)

    steps = store.list_diagnose_steps(run_id)
    current = _check_by_order(entry, run["current_order"]) if run["status"] == "active" else None
    return {
        "run": _run_payload(run),
        "entry": _entry_payload(entry),
        "current_check": current.model_dump() if current else None,
        "steps": _steps_payload(steps),
        "progress": {"done": len(steps), "total": len(entry.checks)},
        "conclusion": run.get("conclusion"),
        "disclaimer": DISCLAIMER,
    }


def start(
    symptom: str,
    *,
    system: str | None = None,
    entry_id: str | None = None,
    session_id: str | None = None,
) -> dict:
    text = symptom.strip()
    if len(text) < 4:
        raise DiagnosisError("input_too_short", "现象描述至少需要 4 个字符", 422)

    if session_id and store.get_session(session_id) is None:
        raise DiagnosisError("session_not_found", "关联的作业会话不存在", 404)

    # 显式给了条目就以条目为准：现场可能是从知识库列表点进来的，
    # 这时检索失败不应阻止开始诊断（条目本身存在即可）。
    entry = knowledge.get_entry(entry_id) if entry_id else None
    if entry_id and entry is None:
        raise DiagnosisError("entry_not_found", "指定的知识条目不存在", 404)

    hits, rerank_info, reason = knowledge.search_entries(
        text, system=system, top_k=knowledge.MAX_TOP_K
    )
    if entry is None:
        if reason:
            raise DiagnosisError(reason, knowledge.uncovered_message(reason), 404)
        entry = hits[0].entry

    run_id = store.create_diagnose_run(
        entry_id=entry.id,
        symptom=text,
        system=entry.system.value,
        session_id=session_id,
        current_order=_first_order(entry),
    )
    payload = state(run_id)
    payload["candidates"] = [
        {
            "id": hit.entry.id,
            "title": hit.entry.title,
            "system": hit.entry.system.value,
            "score": hit.score,
            "signals": hit.signals(),
        }
        for hit in hits
    ]
    payload["rerank"] = rerank_info
    return payload


def submit(
    run_id: str,
    order: int,
    *,
    result: str | None = None,
    value: float | None = None,
    note: str = "",
) -> dict:
    run = store.get_diagnose_run(run_id)
    if run is None:
        raise DiagnosisError("run_not_found", "诊断会话不存在", 404)
    if run["status"] != "active":
        raise DiagnosisError("run_finished", "该诊断已结束，请重新开始", 409)
    if run["current_order"] != order:
        raise DiagnosisError(
            "wrong_order",
            f"当前应提交第 {run['current_order']} 项检查",
            409,
        )

    entry = knowledge.get_entry(run["entry_id"])
    if entry is None:
        raise DiagnosisError("entry_not_found", "知识条目已不存在", 410)
    check = _check_by_order(entry, order)
    if check is None:
        raise DiagnosisError("check_not_found", "检查项不存在", 404)

    stored_value = ""
    if check.kind == "measure":
        if value is None:
            raise DiagnosisError("value_required", "该检查需要回填实测值", 422)
        if value < check.min or value > check.max:
            verdict = "fail"
        else:
            verdict = "pass"
        stored_value = str(value)
    else:
        if result not in ("pass", "fail"):
            raise DiagnosisError("result_required", "请提交 通过/异常", 422)
        verdict = result

    store.add_diagnose_step(
        run_id, order, verdict, value=stored_value, note=note
    )

    if verdict == "fail":
        store.update_diagnose_run(
            run_id,
            status="concluded",
            current_order=None,
            conclusion=_conclusion_fail(entry, check),
        )
    else:
        nxt = _next_order(entry, check)
        if nxt is None:
            store.update_diagnose_run(
                run_id,
                status="concluded",
                current_order=None,
                conclusion=_conclusion_exhausted(entry),
            )
        else:
            store.update_diagnose_run(run_id, status="active", current_order=nxt)

    return state(run_id)


def abort(run_id: str) -> dict:
    run = store.get_diagnose_run(run_id)
    if run is None:
        raise DiagnosisError("run_not_found", "诊断会话不存在", 404)
    if run["status"] == "active":
        entry = knowledge.get_entry(run["entry_id"])
        conclusion = _conclusion_aborted(entry) if entry else None
        store.update_diagnose_run(
            run_id, status="aborted", current_order=None, conclusion=conclusion
        )
    return state(run_id)
