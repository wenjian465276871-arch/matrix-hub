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
    assert store.schema_version() == 3
    assert store.init_db() == []  # 第二次不应重复应用
    assert store.schema_version() == 3


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


def test_published_content_is_immutable(db, guide):
    """已发布内容不可被覆盖——这是决策 #16 的底线。

    生成服务会给每份新稿分配随机 id，正常路径撞不上；这条测试防的是
    "有人手工把 id 设回去"或"未来某次重构把 upsert 又放开"。
    """
    store.save_guide(guide, status="published")
    first = store.get_guide(guide.id)
    assert first["status"] == "published" and first["published_at"]

    original_title = first["title"]
    guide.title = "客室侧门开关门功能试验（第二版）"
    result = store.save_guide(guide, status="draft")
    assert result["skipped"] is True

    second = store.get_guide(guide.id)
    assert second["title"] == original_title
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


def test_count_jobs_excludes_failed_for_visitor_quota(db):
    """决策 #17：系统失败不占访客配额，但默认口径（全站预算）仍要算。"""
    ip = "203.0.113.9"
    failed = store.create_job(kind="generate", client_ip=ip, input_text="a")
    store.finish_job(failed, "failed", error_code="timeout")
    ok = store.create_job(kind="generate", client_ip=ip, input_text="b")
    store.finish_job(ok, "succeeded")
    store.create_job(kind="generate", client_ip=ip, input_text="c")

    assert store.count_jobs_today(ip) == 3
    assert store.count_jobs_today(ip, exclude_failed=True) == 2


def test_retry_of_is_counted(db):
    original = store.create_job(kind="generate", client_ip="203.0.113.7", input_text="a")
    store.create_job(
        kind="generate", client_ip="203.0.113.7", input_text="a", retry_of=original
    )
    assert store.count_jobs_by_retry_of(original) == 1
    assert store.count_jobs_by_retry_of(original) == 1  # 只读，不消耗


def test_sweep_stale_jobs_only_touches_unfinished(db):
    queued = store.create_job(kind="generate", client_ip="203.0.113.7", input_text="a")
    running = store.create_job(kind="generate", client_ip="203.0.113.7", input_text="b")
    store.mark_job_running(running)
    done = store.create_job(kind="generate", client_ip="203.0.113.7", input_text="c")
    store.finish_job(done, "succeeded")

    # 用未来时刻作为切点：now_iso() 只有秒级精度，同一秒内可能不满足 <
    assert store.sweep_stale_jobs("9999-12-31T00:00:00+00:00") == 2
    assert store.get_job(queued)["status"] == "timeout"
    assert store.get_job(running)["status"] == "timeout"
    assert store.get_job(running)["error_code"] == "stale"
    assert store.get_job(done)["status"] == "succeeded"


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

    args = dict(
        session_id=sid,
        step_id="s01",
        seq=1,
        verdict="pass",
        payload={"value": 1},
        idempotency_key=f"{sid}:s01:a1",
    )
    rid1, dup1, err1, att1 = store.submit_step(**args)
    rid2, dup2, err2, att2 = store.submit_step(**args)

    assert (dup1, err1, att1) == (False, None, 1)
    assert (rid2, dup2, err2, att2) == (rid1, True, None, 1)
    assert len(store.list_records(sid)) == 1


def test_passed_step_cannot_be_resubmitted_with_new_key(db, guide):
    """通过后 current_seq 已前进，新 key 重投同一步必须是乱序，而不是再记一条。"""
    store.save_guide(guide)
    sid = store.create_session(guide.id)

    store.submit_step(
        session_id=sid, step_id="s01", seq=1, verdict="pass",
        payload={}, idempotency_key=f"{sid}:s01:a1",
    )
    rid, dup, err, attempt = store.submit_step(
        session_id=sid, step_id="s01", seq=1, verdict="pass",
        payload={}, idempotency_key=f"{sid}:s01:a2",
    )
    assert rid is None and dup is False
    assert err == "out_of_order"
    assert attempt == 0
    assert len(store.list_records(sid)) == 1


def test_failed_step_retest_gets_new_attempt(db, guide):
    """复测必须留痕：同一步的第二次提交是 attempt 2，不是覆盖第一条。"""
    store.save_guide(guide)
    sid = store.create_session(guide.id)

    first, _, err1, att1 = store.submit_step(
        session_id=sid, step_id="s01", seq=1, verdict="fail",
        payload={"results": [{"verdict": "fail"}]}, idempotency_key=f"{sid}:s01:a1",
    )
    second, _, err2, att2 = store.submit_step(
        session_id=sid, step_id="s01", seq=1, verdict="pass",
        payload={"results": [{"verdict": "pass"}]}, idempotency_key=f"{sid}:s01:a2",
    )

    assert err1 is None and err2 is None
    assert (att1, att2) == (1, 2)
    assert first != second
    records = store.list_records(sid)
    assert [r["attempt"] for r in records] == [1, 2]
    assert store.get_session(sid)["current_seq"] == 2


def test_out_of_order_step_is_rejected(db, guide):
    store.save_guide(guide)
    sid = store.create_session(guide.id)
    rid, dup, err, _ = store.submit_step(
        session_id=sid, step_id="s02", seq=2, verdict="pass",
        payload={}, idempotency_key=f"{sid}:s02:a1",
    )
    assert rid is None and dup is False and err == "out_of_order"


def test_closed_session_rejects_submit(db, guide):
    store.save_guide(guide)
    sid = store.create_session(guide.id)
    assert store.finish_session(sid, "aborted") is True

    rid, dup, err, _ = store.submit_step(
        session_id=sid, step_id="s01", seq=1, verdict="pass",
        payload={}, idempotency_key=f"{sid}:s01:a1",
    )
    assert rid is None and dup is False and err == "closed"


def test_session_metadata_is_persisted(db, guide):
    store.save_guide(guide)
    sid = store.create_session(guide.id, device="D-01", location="3 车 2 位")
    session = store.get_session(sid)
    assert session["device"] == "D-01"
    assert session["location"] == "3 车 2 位"


def test_session_progress_advances_and_finishes(db, guide):
    store.save_guide(guide)
    sid = store.create_session(guide.id)
    assert store.get_session(sid)["current_seq"] == 1

    store.submit_step(
        session_id=sid, step_id="s01", seq=1, verdict="pass",
        payload={}, idempotency_key=f"{sid}:s01:a1",
    )
    assert store.get_session(sid)["current_seq"] == 2

    assert store.finish_session(sid, "done", note="演练") is True
    session = store.get_session(sid)
    assert session["status"] == "done"
    assert session["note"] == "演练"
    # 已完成会话不能再次结束
    assert store.finish_session(sid, "aborted") is False


def test_healthz_reports_db(monkeypatch, db):
    from fastapi.testclient import TestClient

    from main import app

    r = TestClient(app).get("/healthz")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["checks"]["electro"] == "ok"
    assert body["checks"]["db"] == "ok"
    # 2026-10-21 增加：磁盘余量不足时部署脚本必须能看到 degraded
    assert body["checks"]["disk"] == "ok"
