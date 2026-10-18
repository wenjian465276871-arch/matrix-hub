"""存储层测试。

这些用例盯的不是"能存能取"，而是几条容易在半夜炸开的边界：
- 迁移幂等（重复启动不能重复建表）；
- 已发布内容不被草稿覆盖（否则一次重生成就把线上打下线）；
- 幂等键与 (session, step) 双约束（否则重投产生重复作业记录）；
- 金额用整数累加（REAL 会让预算熔断判错）。
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

import store
from models.guide import Guide

SAMPLE = json.loads(
    (Path(__file__).resolve().parent.parent / "samples" / "door_switch_test.json").read_text(
        encoding="utf-8"
    )
)


@pytest.fixture()
def db(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "electro.db"))
    store.init_db()
    return tmp_path / "electro.db"


@pytest.fixture()
def guide() -> Guide:
    return Guide.model_validate(SAMPLE)


def test_migrations_are_idempotent(db):
    assert store.schema_version() == 1
    assert store.init_db() == []  # 第二次不应重复应用
    assert store.schema_version() == 1


def test_save_and_read_guide(db, guide):
    store.save_guide(guide)
    row = store.get_guide(guide.id)
    assert row is not None
    assert row["status"] == "draft"
    assert row["step_count"] == len(guide.steps)
    assert row["duration_s"] == sum(s.duration_s or 0 for s in guide.steps)
    assert row["guide"]["title"] == guide.title
    # 全文能原样还原（含图元参数）
    assert row["guide"]["steps"][1]["figures"][0]["primitive"] == "connector"


def test_list_does_not_include_body(db, guide):
    store.save_guide(guide)
    items = store.list_guides()
    assert len(items) == 1
    assert "guide" not in items[0]
    assert items[0]["step_count"] == len(guide.steps)


def test_published_not_overwritten_by_draft(db, guide):
    store.save_guide(guide, status="published")
    first = store.get_guide(guide.id)
    assert first["status"] == "published" and first["published_at"]

    # 重生成产生的新草稿：内容更新，但发布状态与发布时间保持不变
    guide.title = "客室侧门开关门功能试验（第二版）"
    store.save_guide(guide, status="draft")
    second = store.get_guide(guide.id)
    assert second["title"] == guide.title
    assert second["status"] == "published"
    assert second["published_at"] == first["published_at"]


def test_publish_missing_guide_returns_false(db):
    assert store.publish_guide("g_not_exist_001") is False


def test_job_lifecycle(db):
    job_id = store.create_job(kind="generate", client_ip="203.0.113.7", input_text="x" * 100)
    job = store.get_job(job_id)
    assert job["status"] == "queued"
    assert job["input_chars"] == 100
    assert job["input_sha256"]

    assert store.mark_job_running(job_id) is True
    assert store.get_job(job_id)["status"] == "running"
    # 重复标记不应把 started_at 冲掉
    assert store.mark_job_running(job_id) is False

    done = store.finish_job(
        job_id,
        "succeeded",
        guide_id="g_door_switch_test_001",
        prompt_tokens=1200,
        completion_tokens=800,
        reasoning_tokens=300,
        cost_micros=4500,
    )
    assert done["duration_ms"] is not None and done["duration_ms"] >= 0
    job = store.get_job(job_id)
    assert job["status"] == "succeeded"
    assert job["guide_id"] == "g_door_switch_test_001"
    assert job["reasoning_tokens"] == 300
    assert job["cost_micros"] == 4500


def test_finish_unknown_job_raises(db):
    with pytest.raises(KeyError):
        store.finish_job("j_missing", "failed")


def test_count_jobs_today_by_ip(db):
    store.create_job(kind="generate", client_ip="203.0.113.7", input_text="a")
    store.create_job(kind="generate", client_ip="203.0.113.7", input_text="b")
    store.create_job(kind="extract", client_ip="198.51.100.9", input_text="c")

    assert store.count_jobs_today("203.0.113.7") == 2
    assert store.count_jobs_today("198.51.100.9") == 1
    assert store.count_jobs_today("192.0.2.1") == 0


def test_usage_sums_are_exact_integers(db):
    store.record_usage(model="deepseek-flash", prompt_tokens=1000, completion_tokens=200, cost_micros=1234)
    store.record_usage(model="deepseek-flash", prompt_tokens=2000, completion_tokens=300, cost_micros=2345)

    summary = store.usage_summary()
    assert summary["calls"] == 2
    assert summary["prompt_tokens"] == 3000
    assert summary["completion_tokens"] == 500
    assert summary["cost_micros"] == 3579  # 整数相加，不存在浮点漂移
    assert store.usage_summary(day="2000-01-01")["calls"] == 0


def test_record_idempotent_same_key(db, guide):
    store.save_guide(guide)
    sid = store.create_session(guide.id)

    rid1, dup1 = store.submit_record(
        session_id=sid, step_id="s01", seq=1, verdict="pass",
        payload={"value": 1}, idempotency_key=f"{sid}:s01",
    )
    rid2, dup2 = store.submit_record(
        session_id=sid, step_id="s01", seq=1, verdict="pass",
        payload={"value": 1}, idempotency_key=f"{sid}:s01",
    )
    assert rid1 == rid2
    assert dup1 is False and dup2 is True
    assert len(store.list_records(sid)) == 1


def test_record_idempotent_across_different_keys(db, guide):
    """客户端换了 Idempotency-Key 重投同一步，也不能产生第二条。"""
    store.save_guide(guide)
    sid = store.create_session(guide.id)

    rid1, _ = store.submit_record(
        session_id=sid, step_id="s02", seq=2, verdict="pass",
        payload={}, idempotency_key=f"{sid}:s02",
    )
    rid2, dup = store.submit_record(
        session_id=sid, step_id="s02", seq=2, verdict="pass",
        payload={}, idempotency_key=f"{sid}:s02-retry-1",
    )
    assert rid1 == rid2 and dup is True
    assert len(store.list_records(sid)) == 1


def test_session_progress_advances_and_finishes(db, guide):
    store.save_guide(guide)
    sid = store.create_session(guide.id)
    assert store.get_session(sid)["current_seq"] == 1

    store.submit_record(
        session_id=sid, step_id="s01", seq=1, verdict="pass",
        payload={}, idempotency_key=f"{sid}:s01",
    )
    assert store.get_session(sid)["current_seq"] == 2

    assert store.finish_session(sid, "done") is True
    assert store.get_session(sid)["status"] == "done"
    # 已完成会话不能再次结束
    assert store.finish_session(sid, "aborted") is False


def test_healthz_reports_db(monkeypatch, db):
    from fastapi.testclient import TestClient

    from main import app

    r = TestClient(app).get("/healthz")
    assert r.status_code == 200
    assert r.json() == {"status": "ok", "checks": {"electro": "ok", "db": "ok"}}
