"""清理脚本契约：该删的删、不该删的一律不动。"""
from __future__ import annotations

import os
import sqlite3
from datetime import datetime, timedelta, timezone

import pytest

import store
from scripts import cleanup


def _iso(moment: datetime) -> str:
    return moment.isoformat(timespec="seconds")


@pytest.fixture()
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "electro.db"))
    monkeypatch.setenv("UPLOAD_DIR", str(tmp_path / "uploads"))
    store.init_db()
    (tmp_path / "uploads").mkdir()
    return tmp_path


def _seed(row_days: dict[str, int]) -> None:
    now = datetime.now(timezone.utc)
    con = sqlite3.connect(store.db_path())
    try:
        with con:
            for label, days in row_days.items():
                ts = _iso(now - timedelta(days=days))
                if label.startswith("s_"):
                    con.execute(
                        "INSERT INTO sessions (id, guide_id, status, current_seq, created_at, updated_at)"
                        " VALUES (?, 'g_demo', 'done', 1, ?, ?)",
                        (label, ts, ts),
                    )
                    con.execute(
                        "INSERT INTO records (id, session_id, step_id, seq, attempt, verdict,"
                        " payload_json, idempotency_key, created_at)"
                        " VALUES (?, ?, 'st1', 1, 1, 'pass', '{}', ?, ?)",
                        ("r_" + label, label, label, ts),
                    )
                elif label.startswith("j_"):
                    status = "succeeded" if days > 50 else "queued"
                    con.execute(
                        "INSERT INTO jobs (id, kind, status, client_ip, created_at)"
                        " VALUES (?, 'generate', ?, '1.2.3.4', ?)",
                        (label, status, ts),
                    )
                elif label.startswith("d_"):
                    con.execute(
                        "INSERT INTO diagnose_runs (id, entry_id, symptom, system, status,"
                        " current_order, created_at, updated_at)"
                        " VALUES (?, 'kb_door_anti_pinch', '门反复开关', 'door', 'concluded',"
                        " NULL, ?, ?)",
                        (label, ts, ts),
                    )
                    con.execute(
                        "INSERT INTO diagnose_steps (id, run_id, check_order, verdict, value,"
                        " note, created_at) VALUES (?, ?, 1, 'fail', '', '', ?)",
                        ("ds_" + label[2:], label, ts),
                    )
                elif label.startswith("d_"):
                    con.execute(
                        "INSERT INTO diagnose_runs (id, entry_id, symptom, system, status,"
                        " current_order, created_at, updated_at)"
                        " VALUES (?, 'kb_door_anti_pinch', '门反复开关', 'door', 'concluded',"
                        " NULL, ?, ?)",
                        (label, ts, ts),
                    )
                    con.execute(
                        "INSERT INTO diagnose_steps (id, run_id, check_order, verdict, value,"
                        " note, created_at) VALUES (?, ?, 1, 'fail', '', '', ?)",
                        ("ds_" + label[2:], label, ts),
                    )
                elif label.startswith("u_"):
                    con.execute(
                        "INSERT INTO usage (day, model, prompt_tokens, completion_tokens,"
                        " cost_micros, created_at) VALUES ('2025-01-01', 'fake', 1, 1, 10, ?)",
                        (ts,),
                    )
            con.execute(
                "INSERT INTO guides (id, schema_version, title, system, status, json,"
                " created_at, updated_at) VALUES ('g_demo', '1.1', 't', 'door', 'published',"
                " '{}', ?, ?)",
                (_iso(now - timedelta(days=999)), _iso(now - timedelta(days=999))),
            )
    finally:
        con.close()


def _asset(root, name: str, age_days: int) -> None:
    path = root / "uploads" / name
    path.mkdir()
    (path / f"{name}.png").write_bytes(b"x" * 100)
    ts = (datetime.now(timezone.utc) - timedelta(days=age_days)).timestamp()
    os.utime(path, (ts, ts))


def test_plan_and_apply_delete_only_expired(env):
    _seed(
        {
            "s_old": 200,
            "s_new": 1,
            "j_old": 100,
            "j_new": 1,
            "d_old": 400,
            "d_new": 1,
            "d_old": 400,
            "d_new": 1,
            "u_old": 400,
            "u_new": 0,
        }
    )
    _asset(env, "a_" + "0" * 16, 40)
    _asset(env, "a_" + "1" * 16, 1)

    report = cleanup.plan()
    assert report.sessions == ["s_old"]
    assert report.records == 1
    assert report.jobs == ["j_old"]
    assert report.diagnose_runs == ["d_old"]
    assert report.diagnose_steps == 1
    assert report.diagnose_runs == ["d_old"]
    assert report.diagnose_steps == 1
    assert report.usage == 1
    assert [name for name, _ in report.uploads] == ["a_" + "0" * 16]

    deleted = cleanup.apply(report)
    assert deleted == {
        "sessions": 1,
        "records": 1,
        "diagnose_runs": 1,
        "diagnose_steps": 1,
        "jobs": 1,
        "usage": 1,
        "uploads": 1,
    }

    con = sqlite3.connect(store.db_path())
    try:
        assert con.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] == 1
        assert con.execute("SELECT COUNT(*) FROM records").fetchone()[0] == 1
        assert con.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 1
        assert con.execute("SELECT COUNT(*) FROM usage").fetchone()[0] == 1
        assert con.execute("SELECT COUNT(*) FROM diagnose_runs").fetchone()[0] == 1
        assert con.execute("SELECT COUNT(*) FROM diagnose_steps").fetchone()[0] == 1
        assert con.execute("SELECT COUNT(*) FROM diagnose_runs").fetchone()[0] == 1
        assert con.execute("SELECT COUNT(*) FROM diagnose_steps").fetchone()[0] == 1
        # 指导书是产品内容，任何情况下都不能被清理
        assert con.execute("SELECT COUNT(*) FROM guides").fetchone()[0] == 1
    finally:
        con.close()

    assert not (env / "uploads" / ("a_" + "0" * 16)).exists()
    assert (env / "uploads" / ("a_" + "1" * 16)).exists()


def test_referenced_assets_are_never_deleted(env):
    """被指导书引用的图不能按年龄清掉：已发布页面会直接裂图。"""
    import json

    referenced = "a_" + "2" * 16
    orphan = "a_" + "3" * 16
    _seed({})  # 只建 g_demo 这一份指导书
    _asset(env, referenced, 400)
    _asset(env, orphan, 400)

    con = sqlite3.connect(store.db_path())
    try:
        with con:
            con.execute(
                "UPDATE guides SET json = ? WHERE id = 'g_demo'",
                (
                    json.dumps(
                        {
                            "assets": [{"asset_id": referenced, "caption": "门锁间隙"}],
                            "steps": [],
                        }
                    ),
                ),
            )
    finally:
        con.close()

    report = cleanup.plan()
    assert [name for name, _ in report.uploads] == [orphan]
    cleanup.apply(report)
    assert (env / "uploads" / referenced).exists()
    assert not (env / "uploads" / orphan).exists()


def test_plan_keeps_active_jobs_even_if_old(env):
    _seed({"j_old": 100})
    con = sqlite3.connect(store.db_path())
    try:
        con.execute("UPDATE jobs SET status = 'running' WHERE id = 'j_old'")
        con.commit()
    finally:
        con.close()
    assert cleanup.plan().jobs == []


def test_dry_run_report_is_empty_on_fresh_data(env):
    _seed({"s_new": 0, "j_new": 0, "u_new": 0})
    assert cleanup.plan().empty()
