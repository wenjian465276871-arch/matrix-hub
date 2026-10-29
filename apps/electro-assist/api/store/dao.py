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

    **ID 必须由调用方分配**（生成服务用随机 id），DAO 不接受模型给的 id。
    模型的 id 是语义化的（`g_door_side_door_test`），两人生成同一工序必撞；
    搭配 upsert 就是"后者静默覆盖前者"，已发布内容也会被顶替。

    **已发布内容不可覆盖**：即使 id 撞上（64 位随机理论上不会），也只返回现有记录。
    发布状态只能由 `publish_guide` 改变。
    """
    now = now_iso()
    payload = json.dumps(guide.model_dump(mode="json"), ensure_ascii=False)
    duration = sum(step.duration_s or 0 for step in guide.steps)

    with connect() as conn:
        with tx(conn):
            cur = conn.execute(
                """
                INSERT INTO guides (id, schema_version, title, system, status, json, job_id,
                                    step_count, duration_s, summary, source_note, generated_at,
                                    created_at, updated_at, published_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                  schema_version = excluded.schema_version,
                  title          = excluded.title,
                  system         = excluded.system,
                  json           = excluded.json,
                  job_id         = excluded.job_id,
                  step_count     = excluded.step_count,
                  duration_s     = excluded.duration_s,
                  summary        = excluded.summary,
                  source_note    = excluded.source_note,
                  generated_at   = excluded.generated_at,
                  updated_at     = excluded.updated_at,
                  status         = CASE
                                     WHEN guides.status = 'published' THEN 'published'
                                     ELSE excluded.status
                                   END,
                  published_at   = COALESCE(guides.published_at, excluded.published_at)
                WHERE guides.status != 'published'
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
                    guide.summary,
                    guide.meta.source_note,
                    guide.meta.generated_at.isoformat(),
                    now,
                    now,
                    now if status == "published" else None,
                ),
            )
            if cur.rowcount == 0:
                existing = conn.execute(
                    "SELECT status, updated_at FROM guides WHERE id = ?", (guide.id,)
                ).fetchone()
                if existing is not None:
                    return {
                        "id": guide.id,
                        "status": existing["status"],
                        "updated_at": existing["updated_at"],
                        "skipped": True,
                    }
    return {"id": guide.id, "status": status, "updated_at": now, "skipped": False}


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
        SELECT id, schema_version, title, summary, system, status, job_id, step_count,
               duration_s, source_note, generated_at, created_at, updated_at, published_at
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


def list_guides_with_schema_version(version: str) -> list[dict[str, Any]]:
    """取出 schema_version 与给定值不同的指导书（含全文）。

    只给"版本戳归一化"用：存量样例写于 1.0/1.1，而 seed 只补缺不覆盖，
    于是接口一直返回旧版本号。归一化只改版本戳，内容要先过当前模型校验。
    """
    with connect() as conn:
        rows = conn.execute(
            "SELECT id, schema_version, json FROM guides WHERE schema_version != ?", (version,)
        ).fetchall()
    return [dict(r) for r in rows]


def update_guide_schema_version(guide_id: str, version: str, payload: str) -> None:
    """只改版本戳与整份 JSON，不碰 status / published_at / 发布状态。

    已发布内容不可覆盖是硬规则；这里覆盖的是"同一份内容在新契约下的写法"，
    调用方必须先 `Guide.model_validate` 通过才允许调用。
    """
    with connect() as conn:
        with tx(conn):
            conn.execute(
                "UPDATE guides SET schema_version = ?, json = ?, updated_at = ? WHERE id = ?",
                (version, payload, now_iso(), guide_id),
            )


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
    assets: list[dict[str, str]] | None = None,
) -> str:
    job_id = _new_id("j")
    payload = json.dumps(assets or [], ensure_ascii=False)
    with connect() as conn:
        with tx(conn):
            conn.execute(
                """
                INSERT INTO jobs (id, kind, status, client_ip, input_sha256, input_chars,
                                  retry_of, assets_json, created_at)
                VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?)
                """,
                (
                    job_id,
                    kind,
                    client_ip,
                    hashlib.sha256(input_text.encode("utf-8")).hexdigest(),
                    len(input_text),
                    retry_of,
                    payload,
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


def count_jobs_between(
    client_ip: str,
    start_iso: str,
    end_iso: str,
    *,
    exclude_failed: bool = False,
) -> int:
    """配额统计口径：按 IP 与时间窗计数。

    `exclude_failed=True` 用于访客配额（决策 #17：系统失败不该让用户买单）。
    全站预算统计不吃这个参数——失败调用的 token 已经花掉了。
    """
    sql = (
        "SELECT COUNT(*) AS n FROM jobs"
        " WHERE client_ip = ? AND created_at >= ? AND created_at < ?"
    )
    if exclude_failed:
        sql += " AND status NOT IN ('failed', 'timeout')"
    with connect() as conn:
        row = conn.execute(sql, (client_ip, start_iso, end_iso)).fetchone()
    return int(row["n"])


def oldest_job_between(
    client_ip: str,
    start_iso: str,
    end_iso: str,
    *,
    exclude_failed: bool = True,
) -> str | None:
    """时间窗内最早一条 job 的时间，用于算配额重置时刻。"""
    sql = (
        "SELECT MIN(created_at) AS t FROM jobs"
        " WHERE client_ip = ? AND created_at >= ? AND created_at < ?"
    )
    if exclude_failed:
        sql += " AND status NOT IN ('failed', 'timeout')"
    with connect() as conn:
        row = conn.execute(sql, (client_ip, start_iso, end_iso)).fetchone()
    return row["t"] if row and row["t"] else None


def count_jobs_today(
    client_ip: str,
    day: str | None = None,
    *,
    exclude_failed: bool = False,
) -> int:
    start, end = day_bounds_utc(day or today_cst())
    return count_jobs_between(client_ip, start, end, exclude_failed=exclude_failed)


def count_jobs_by_retry_of(retry_of: str) -> int:
    """一个失败 job 只允许被重试一次——否则 retry_of 就是无限额度。"""
    with connect() as conn:
        row = conn.execute(
            "SELECT COUNT(*) AS n FROM jobs WHERE retry_of = ?", (retry_of,)
        ).fetchone()
    return int(row["n"])


def sweep_stale_jobs(before_iso: str, note: str = "服务重启导致中断，请重试") -> int:
    """把重启后残留的 queued/running 收敛为 timeout。

    单容器部署每次 `up -d` 都会换进程；没有这一步，那些 job 会永远转圈，
    用户重试还会被配额拦住（决策 #17 后不会，但"永远 running"本身仍是坏体验）。
    """
    now = now_iso()
    with connect() as conn:
        with tx(conn):
            cur = conn.execute(
                """
                UPDATE jobs
                   SET status = 'timeout', error_code = 'stale', error_detail = ?,
                       finished_at = ?
                 WHERE status IN ('queued', 'running') AND created_at < ?
                """,
                (note, now, before_iso),
            )
    return cur.rowcount


# ---------------------------------------------------------------- usage


def record_usage(
    *,
    model: str,
    prompt_tokens: int,
    completion_tokens: int,
    reasoning_tokens: int = 0,
    cached_tokens: int = 0,
    cost_micros: int = 0,
    price_version: str = "",
    job_id: str | None = None,
    day: str | None = None,
) -> int:
    with connect() as conn:
        with tx(conn):
            cur = conn.execute(
                """
                INSERT INTO usage (day, job_id, model, prompt_tokens, completion_tokens,
                                   reasoning_tokens, cached_tokens, cost_micros, price_version,
                                   created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    day or today_cst(),
                    job_id,
                    model,
                    prompt_tokens,
                    completion_tokens,
                    reasoning_tokens,
                    cached_tokens,
                    cost_micros,
                    price_version,
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
                   COALESCE(SUM(cached_tokens), 0)     AS cached_tokens,
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
        "cached_tokens": int(row["cached_tokens"]),
        "cost_micros": int(row["cost_micros"]),
    }


# ---------------------------------------------------------------- sessions / records


def create_session(guide_id: str, *, device: str = "", location: str = "") -> str:
    session_id = _new_id("s")
    now = now_iso()
    with connect() as conn:
        with tx(conn):
            conn.execute(
                "INSERT INTO sessions (id, guide_id, status, current_seq, device, location,"
                " created_at, updated_at) VALUES (?, ?, 'active', 1, ?, ?, ?, ?)",
                (session_id, guide_id, device.strip(), location.strip(), now, now),
            )
    return session_id


def get_session(session_id: str) -> dict[str, Any] | None:
    with connect() as conn:
        return _row(conn.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone())


def finish_session(
    session_id: str, status: Literal["done", "aborted"], note: str = ""
) -> bool:
    now = now_iso()
    with connect() as conn:
        with tx(conn):
            cur = conn.execute(
                "UPDATE sessions SET status = ?, note = ?, finished_at = ?, updated_at = ?"
                " WHERE id = ? AND status = 'active'",
                (status, note.strip()[:300], now, now, session_id),
            )
    return cur.rowcount > 0


def submit_step(
    *,
    session_id: str,
    step_id: str,
    seq: int,
    verdict: Verdict,
    payload: dict[str, Any],
    idempotency_key: str,
) -> tuple[str | None, bool, str | None, int]:
    """提交一步结果，返回 (record_id, 是否重复, 错误码, attempt)。

    错误码：`not_found` / `closed` / `out_of_order`。
    幂等与顺序检查放在**同一个写事务**里：先 `BEGIN IMMEDIATE` 拿到写锁，
    再读 `current_seq` 判断，避免两个并发请求都读到 1、都认为自己是下一步。

    `attempt` 在事务内按 `MAX+1` 分配：同一步复测会得到 2、3…，
    异常链因此可回溯；同一 attempt 的重试仍由 `idempotency_key` 唯一约束兜住。
    """
    record_id = _new_id("r")
    now = now_iso()
    body = json.dumps(payload, ensure_ascii=False)

    with connect() as conn:
        try:
            with tx(conn):
                # 幂等优先于顺序：成功提交后 current_seq 已前进，旧 seq 的重投
                # 必须先被认出来，否则会被误判成乱序。
                existing = conn.execute(
                    "SELECT id, attempt FROM records WHERE idempotency_key = ?",
                    (idempotency_key,),
                ).fetchone()
                if existing is not None:
                    return str(existing["id"]), True, None, int(existing["attempt"])

                session = conn.execute(
                    "SELECT status, current_seq FROM sessions WHERE id = ?", (session_id,)
                ).fetchone()
                if session is None:
                    return None, False, "not_found", 0
                if session["status"] != "active":
                    return None, False, "closed", 0
                if seq != session["current_seq"]:
                    return None, False, "out_of_order", 0

                row = conn.execute(
                    "SELECT COALESCE(MAX(attempt), 0) + 1 AS n FROM records"
                    " WHERE session_id = ? AND step_id = ?",
                    (session_id, step_id),
                ).fetchone()
                attempt = int(row["n"])

                conn.execute(
                    """
                    INSERT INTO records (id, session_id, step_id, seq, attempt, verdict,
                                         payload_json, idempotency_key, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        record_id,
                        session_id,
                        step_id,
                        seq,
                        attempt,
                        verdict,
                        body,
                        idempotency_key,
                        now,
                    ),
                )
                if verdict in ("pass", "manual"):
                    # 只有通过/记录型才推进；fail/warn 留在本步等复测或中止
                    conn.execute(
                        "UPDATE sessions SET current_seq = ?, updated_at = ? WHERE id = ?",
                        (seq + 1, now, session_id),
                    )
                else:
                    conn.execute(
                        "UPDATE sessions SET updated_at = ? WHERE id = ?", (now, session_id)
                    )
            return record_id, False, None, attempt
        except sqlite3.IntegrityError:
            row = conn.execute(
                "SELECT id, attempt FROM records WHERE idempotency_key = ?",
                (idempotency_key,),
            ).fetchone()
            if row is None:
                row = conn.execute(
                    "SELECT id, attempt FROM records WHERE session_id = ? AND step_id = ?"
                    " ORDER BY attempt DESC LIMIT 1",
                    (session_id, step_id),
                ).fetchone()
            if row is None:
                raise
            return str(row["id"]), True, None, int(row["attempt"])


def _record(row: sqlite3.Row) -> dict[str, Any]:
    item = dict(row)
    item["payload"] = json.loads(item.pop("payload_json"))
    return item


def get_record_by_key(idempotency_key: str) -> dict[str, Any] | None:
    """幂等重投的第一道检查。

    必须在"顺序检查"之前调用：第一次提交成功后 `current_seq` 已经前进，
    此时用同一个 key 重投旧 seq，会被顺序检查误判成乱序。
    """
    with connect() as conn:
        row = conn.execute(
            "SELECT id, session_id, step_id, seq, attempt, verdict, payload_json, created_at"
            " FROM records WHERE idempotency_key = ?",
            (idempotency_key,),
        ).fetchone()
    return _record(row) if row is not None else None


def get_record(record_id: str) -> dict[str, Any] | None:
    with connect() as conn:
        row = conn.execute(
            "SELECT id, session_id, step_id, seq, attempt, verdict, payload_json, created_at"
            " FROM records WHERE id = ?",
            (record_id,),
        ).fetchone()
    return _record(row) if row is not None else None


def list_records(session_id: str) -> list[dict[str, Any]]:
    with connect() as conn:
        rows = conn.execute(
            "SELECT id, session_id, step_id, seq, attempt, verdict, payload_json, created_at"
            " FROM records WHERE session_id = ? ORDER BY seq, attempt",
            (session_id,),
        ).fetchall()
    return [_record(row) for row in rows]


# ---------------------------------------------------------------- 逐步诊断（B / 2026-10-21）


def create_diagnose_run(
    *,
    entry_id: str,
    symptom: str,
    system: str,
    session_id: str | None = None,
    current_order: int | None = None,
) -> str:
    run_id = _new_id("d")
    now = now_iso()
    with connect() as conn:
        with tx(conn):
            conn.execute(
                """
                INSERT INTO diagnose_runs
                  (id, entry_id, symptom, system, session_id, status, current_order,
                   created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)
                """,
                (run_id, entry_id, symptom, system, session_id, current_order, now, now),
            )
    return run_id


def get_diagnose_run(run_id: str) -> dict[str, Any] | None:
    with connect() as conn:
        row = conn.execute("SELECT * FROM diagnose_runs WHERE id = ?", (run_id,)).fetchone()
    if row is None:
        return None
    data = dict(row)
    raw = data.pop("conclusion_json", "") or ""
    try:
        data["conclusion"] = json.loads(raw) if raw else None
    except json.JSONDecodeError:
        data["conclusion"] = None
    return data


def list_diagnose_steps(run_id: str) -> list[dict[str, Any]]:
    with connect() as conn:
        rows = conn.execute(
            "SELECT * FROM diagnose_steps WHERE run_id = ? ORDER BY check_order, created_at",
            (run_id,),
        ).fetchall()
    return [dict(row) for row in rows]


def add_diagnose_step(
    run_id: str,
    check_order: int,
    verdict: str,
    *,
    value: str = "",
    note: str = "",
) -> str:
    step_id = _new_id("ds")
    with connect() as conn:
        with tx(conn):
            conn.execute(
                """
                INSERT INTO diagnose_steps
                  (id, run_id, check_order, verdict, value, note, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (step_id, run_id, check_order, verdict, value[:120], note[:200], now_iso()),
            )
    return step_id


def update_diagnose_run(
    run_id: str,
    *,
    status: str,
    current_order: int | None,
    conclusion: dict[str, Any] | None = None,
) -> None:
    now = now_iso()
    finished = now if status != "active" else None
    payload = json.dumps(conclusion, ensure_ascii=False) if conclusion is not None else None
    with connect() as conn:
        with tx(conn):
            if payload is None:
                conn.execute(
                    "UPDATE diagnose_runs SET status = ?, current_order = ?, updated_at = ?, "
                    "finished_at = ? WHERE id = ?",
                    (status, current_order, now, finished, run_id),
                )
            else:
                conn.execute(
                    "UPDATE diagnose_runs SET status = ?, current_order = ?, conclusion_json = ?, "
                    "updated_at = ?, finished_at = ? WHERE id = ?",
                    (status, current_order, payload, now, finished, run_id),
                )


def list_diagnose_runs_by_session(session_id: str) -> list[dict[str, Any]]:
    with connect() as conn:
        rows = conn.execute(
            "SELECT * FROM diagnose_runs WHERE session_id = ? ORDER BY created_at DESC",
            (session_id,),
        ).fetchall()
    result = []
    for row in rows:
        data = dict(row)
        raw = data.pop("conclusion_json", "") or ""
        try:
            data["conclusion"] = json.loads(raw) if raw else None
        except json.JSONDecodeError:
            data["conclusion"] = None
        result.append(data)
    return result
