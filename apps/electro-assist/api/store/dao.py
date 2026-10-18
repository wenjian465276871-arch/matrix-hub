"""数据访问层：只做读写，不含业务规则。

边界约定：
- 这里不判断"该不该生成"（配额、预算、限流都在路由/服务层）；
- 这里不计算 token 价格（属 LLM 层，见 T09）；
- 时间一律 UTC ISO 字符串，只有「按天统计」用到北京时间的日界（`db.day_bounds_utc`）。

这样切开的原因：存储要能独立演进（以后换 Postgres 只改这一层），
业务规则要能独立测试（不依赖数据库）。
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
import uuid
from datetime import datetime
from typing import Any, Literal

from models.guide import Guide

from .db import connect, day_bounds_utc, now_iso, today_cst, tx

GuideStatus = Literal["draft", "published"]
JobKind = Literal["generate", "extract"]
JobStatus = Literal["queued", "running", "succeeded", "failed", "timeout"]
Verdict = Literal["pass", "warn", "fail", "manual", "skipped"]


def _new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:16]}"


def _row(row: sqlite3.Row | None) -> dict[str, Any] | None:
    return dict(row) if row is not None else None


# ---------------------------------------------------------------- guides


def save_guide(
    guide: Guide,
    *,
    status: GuideStatus = "draft",
    job_id: str | None = None,
) -> dict[str, Any]:
    """写入或更新一份指导书。

    已发布的指导书不会被后续草稿覆盖状态——否则一次重生成就把线上内容打下线了。
    内容本身仍会被更新，发布状态保持，直到显式 `publish_guide` / `unpublish`。
    """
    now = now_iso()
    payload = json.dumps(guide.model_dump(mode="json"), ensure_ascii=False)
    duration = sum(step.duration_s or 0 for step in guide.steps)

    with connect() as conn:
        with tx(conn):
            conn.execute(
                """
                INSERT INTO guides (id, schema_version, title, system, status, json, job_id,
                                    step_count, duration_s, created_at, updated_at, published_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                  schema_version = excluded.schema_version,
                  title          = excluded.title,
                  system         = excluded.system,
                  json           = excluded.json,
                  job_id         = excluded.job_id,
                  step_count     = excluded.step_count,
                  duration_s     = excluded.duration_s,
                  updated_at     = excluded.updated_at,
                  status         = CASE
                                     WHEN guides.status = 'published' THEN 'published'
                                     ELSE excluded.status
                                   END,
                  published_at   = COALESCE(guides.published_at, excluded.published_at)
                """,
                (
                    guide.id,
                    guide.schema_version,
                    guide.title,
                    guide.meta.system.value,
                    status,
                    payload,
                    job_id,
                    len(guide.steps),
                    duration,
                    now,
                    now,
                    now if status == "published" else None,
                ),
            )
    return {"id": guide.id, "status": status, "updated_at": now}


def get_guide(guide_id: str) -> dict[str, Any] | None:
    with connect() as conn:
        row = conn.execute("SELECT * FROM guides WHERE id = ?", (guide_id,)).fetchone()
    if row is None:
        return None
    data = dict(row)
    data["guide"] = json.loads(data.pop("json"))
    return data


def list_guides(*, status: GuideStatus | None = None, limit: int = 50) -> list[dict[str, Any]]:
    """列表不返回全文——与 `/api/electro/guides` 的口径保持一致。"""
    sql = """
        SELECT id, schema_version, title, system, status, job_id, step_count, duration_s,
               created_at, updated_at, published_at
        FROM guides
    """
    params: list[Any] = []
    if status:
        sql += " WHERE status = ?"
        params.append(status)
    sql += " ORDER BY updated_at DESC LIMIT ?"
    params.append(max(1, min(limit, 200)))

    with connect() as conn:
        return [dict(r) for r in conn.execute(sql, params)]


def publish_guide(guide_id: str) -> bool:
    now = now_iso()
    with connect() as conn:
        with tx(conn):
            cur = conn.execute(
                "UPDATE guides SET status = 'published', published_at = COALESCE(published_at, ?),"
                " updated_at = ? WHERE id = ?",
                (now, now, guide_id),
            )
    return cur.rowcount > 0


def count_guides(*, status: GuideStatus | None = None) -> int:
    sql = "SELECT COUNT(*) AS n FROM guides"
    params: list[Any] = []
    if status:
        sql += " WHERE status = ?"
        params.append(status)
    with connect() as conn:
        return int(conn.execute(sql, params).fetchone()["n"])


# ---------------------------------------------------------------- jobs


def create_job(
    *,
    kind: JobKind,
    client_ip: str,
    input_text: str,
    retry_of: str | None = None,
) -> str:
    job_id = _new_id("j")
    with connect() as conn:
        with tx(conn):
            conn.execute(
                """
                INSERT INTO jobs (id, kind, status, client_ip, input_sha256, input_chars,
                                  retry_of, created_at)
                VALUES (?, ?, 'queued', ?, ?, ?, ?, ?)
                """,
                (
                    job_id,
                    kind,
                    client_ip,
                    hashlib.sha256(input_text.encode("utf-8")).hexdigest(),
                    len(input_text),
                    retry_of,
                    now_iso(),
                ),
            )
    return job_id


def mark_job_running(job_id: str) -> bool:
    with connect() as conn:
        with tx(conn):
            cur = conn.execute(
                "UPDATE jobs SET status = 'running', started_at = ?"
                " WHERE id = ? AND status = 'queued'",
                (now_iso(), job_id),
            )
    return cur.rowcount > 0


def finish_job(
    job_id: str,
    status: JobStatus,
    *,
    guide_id: str | None = None,
    error_code: str | None = None,
    error_detail: str | None = None,
    prompt_tokens: int = 0,
    completion_tokens: int = 0,
    reasoning_tokens: int = 0,
    cost_micros: int = 0,
) -> dict[str, Any]:
    """落终态。耗时由 started_at 推算，不信任调用方传进来的数字。"""
    now = now_iso()
    with connect() as conn:
        with tx(conn):
            row = conn.execute("SELECT started_at FROM jobs WHERE id = ?", (job_id,)).fetchone()
            if row is None:
                raise KeyError(f"job 不存在: {job_id}")
            duration_ms = None
            if row["started_at"]:
                started = datetime.fromisoformat(row["started_at"])
                duration_ms = int((datetime.fromisoformat(now) - started).total_seconds() * 1000)
            conn.execute(
                """
                UPDATE jobs SET status = ?, guide_id = COALESCE(?, guide_id),
                       error_code = ?, error_detail = ?, finished_at = ?, duration_ms = ?,
                       prompt_tokens = ?, completion_tokens = ?, reasoning_tokens = ?,
                       cost_micros = ?
                WHERE id = ?
                """,
                (
                    status,
                    guide_id,
                    error_code,
                    error_detail,
                    now,
                    duration_ms,
                    prompt_tokens,
                    completion_tokens,
                    reasoning_tokens,
                    cost_micros,
                    job_id,
                ),
            )
    return {
        "id": job_id,
        "status": status,
        "finished_at": now,
        "duration_ms": duration_ms,
    }


def get_job(job_id: str) -> dict[str, Any] | None:
    with connect() as conn:
        return _row(conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone())


def count_jobs_between(client_ip: str, start_iso: str, end_iso: str) -> int:
    """配额统计口径：按 IP 与时间窗计数。

    被拒绝的请求不建 job，所以这里不需要再排除什么——
    "没建成 job"本身就是没消耗额度。
    """
    with connect() as conn:
        row = conn.execute(
            "SELECT COUNT(*) AS n FROM jobs WHERE client_ip = ? AND created_at >= ? AND created_at < ?",
            (client_ip, start_iso, end_iso),
        ).fetchone()
    return int(row["n"])


def count_jobs_today(client_ip: str, day: str | None = None) -> int:
    start, end = day_bounds_utc(day or today_cst())
    return count_jobs_between(client_ip, start, end)


# ---------------------------------------------------------------- usage


def record_usage(
    *,
    model: str,
    prompt_tokens: int,
    completion_tokens: int,
    reasoning_tokens: int = 0,
    cost_micros: int = 0,
    job_id: str | None = None,
    day: str | None = None,
) -> int:
    with connect() as conn:
        with tx(conn):
            cur = conn.execute(
                """
                INSERT INTO usage (day, job_id, model, prompt_tokens, completion_tokens,
                                   reasoning_tokens, cost_micros, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    day or today_cst(),
                    job_id,
                    model,
                    prompt_tokens,
                    completion_tokens,
                    reasoning_tokens,
                    cost_micros,
                    now_iso(),
                ),
            )
    return int(cur.lastrowid)


def usage_summary(day: str | None = None) -> dict[str, int]:
    target = day or today_cst()
    with connect() as conn:
        row = conn.execute(
            """
            SELECT COUNT(*) AS calls,
                   COALESCE(SUM(prompt_tokens), 0)     AS prompt_tokens,
                   COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
                   COALESCE(SUM(reasoning_tokens), 0)  AS reasoning_tokens,
                   COALESCE(SUM(cost_micros), 0)       AS cost_micros
            FROM usage WHERE day = ?
            """,
            (target,),
        ).fetchone()
    return {
        "day": target,
        "calls": int(row["calls"]),
        "prompt_tokens": int(row["prompt_tokens"]),
        "completion_tokens": int(row["completion_tokens"]),
        "reasoning_tokens": int(row["reasoning_tokens"]),
        "cost_micros": int(row["cost_micros"]),
    }


# ---------------------------------------------------------------- sessions / records


def create_session(guide_id: str) -> str:
    session_id = _new_id("s")
    now = now_iso()
    with connect() as conn:
        with tx(conn):
            conn.execute(
                "INSERT INTO sessions (id, guide_id, status, current_seq, created_at, updated_at)"
                " VALUES (?, ?, 'active', 1, ?, ?)",
                (session_id, guide_id, now, now),
            )
    return session_id


def get_session(session_id: str) -> dict[str, Any] | None:
    with connect() as conn:
        return _row(conn.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone())


def finish_session(session_id: str, status: Literal["done", "aborted"]) -> bool:
    now = now_iso()
    with connect() as conn:
        with tx(conn):
            cur = conn.execute(
                "UPDATE sessions SET status = ?, finished_at = ?, updated_at = ?"
                " WHERE id = ? AND status = 'active'",
                (status, now, now, session_id),
            )
    return cur.rowcount > 0


def submit_record(
    *,
    session_id: str,
    step_id: str,
    seq: int,
    verdict: Verdict,
    payload: dict[str, Any],
    idempotency_key: str,
) -> tuple[str, bool]:
    """提交一步结果，返回 (record_id, 是否重复提交)。

    幂等靠两道约束：
    - `idempotency_key` 唯一：同一个 key 重投直接返回原记录；
    - `(session_id, step_id)` 唯一：客户端换了 key 重投同一步，也不会产生第二条。

    记录与"推进 session.current_seq"在同一个事务里，避免出现
    "记录写进去了但进度没动"这种要靠人肉修的中间态。
    """
    record_id = _new_id("r")
    now = now_iso()
    body = json.dumps(payload, ensure_ascii=False)

    with connect() as conn:
        try:
            with tx(conn):
                conn.execute(
                    """
                    INSERT INTO records (id, session_id, step_id, seq, verdict, payload_json,
                                         idempotency_key, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (record_id, session_id, step_id, seq, verdict, body, idempotency_key, now),
                )
                conn.execute(
                    "UPDATE sessions SET current_seq = MAX(current_seq, ?), updated_at = ?"
                    " WHERE id = ?",
                    (seq + 1, now, session_id),
                )
            return record_id, False
        except sqlite3.IntegrityError:
            row = conn.execute(
                "SELECT id FROM records WHERE idempotency_key = ?"
                " OR (session_id = ? AND step_id = ?)",
                (idempotency_key, session_id, step_id),
            ).fetchone()
            if row is None:
                raise
            return str(row["id"]), True


def list_records(session_id: str) -> list[dict[str, Any]]:
    with connect() as conn:
        rows = conn.execute(
            "SELECT id, session_id, step_id, seq, verdict, payload_json, created_at"
            " FROM records WHERE session_id = ? ORDER BY seq, created_at",
            (session_id,),
        ).fetchall()
    out = []
    for r in rows:
        item = dict(r)
        item["payload"] = json.loads(item.pop("payload_json"))
        out.append(item)
    return out
