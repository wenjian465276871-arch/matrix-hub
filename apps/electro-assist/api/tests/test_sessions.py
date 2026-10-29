"""A1 会话 API 的契约测试。

盯的是会真出事的六条：
1. 步骤必须按顺序提交，跳步 409；
2. 同 key 重投只记一条，且返回原记录；
3. 通过后不能用新 key 重投同一步；
4. 超差不推进，复测产生 attempt 2，异常链留痕；
5. 结束前必须走完全部步骤；
6. 判定由服务端算，客户端伪造 verdict 无效。
"""
from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import store
from main import app
from services import library
from services import sessions as session_service

client = TestClient(app)
GUIDE_ID = "g_door_switch_test_001"
SAMPLES = Path(__file__).resolve().parent.parent / "data" / "samples"


@pytest.fixture()
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "electro.db"))
    monkeypatch.setenv("GUIDE_DIR", str(SAMPLES))
    monkeypatch.setenv("SEED_GUIDES", "1")
    store.init_db()
    library.ensure_seeded()
    session_service.reset_rate_limit()


def _start() -> str:
    r = client.post("/api/electro/sessions", json={"guide_id": GUIDE_ID})
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["session"]["status"] == "active"
    assert body["session"]["current_seq"] == 1
    assert body["progress"]["total_steps"] == 4
    return body["session"]["id"]


def _submit(sid: str, seq: int, values: dict, key: str, note: str = ""):
    return client.post(
        f"/api/electro/sessions/{sid}/steps/{seq}",
        json={"values": values, "note": note},
        headers={"Idempotency-Key": key},
    )


def test_full_session_flow(env):
    sid = _start()

    # 跳步
    r = _submit(sid, 2, {"supply_v": 110, "pin_ok": "一致"}, f"{sid}:s02:a1")
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "out_of_order"
    assert r.json()["detail"]["expected_seq"] == 1

    # 第 1 步：人工确认
    key1 = f"{sid}:s01:a1"
    r = _submit(sid, 1, {"confirm_safe": True}, key1)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["verdict"] == "manual"
    assert body["session"]["current_seq"] == 2
    assert body["duplicate"] is False

    # 同 key 重投：返回原记录
    r = _submit(sid, 1, {"confirm_safe": True}, key1)
    assert r.status_code == 200
    assert r.json()["duplicate"] is True
    assert r.json()["record"]["id"] == body["record"]["id"]

    # 通过后换 key 重投：拒绝
    r = _submit(sid, 1, {"confirm_safe": True}, f"{sid}:s01:a2")
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "step_already_passed"

    # 第 2 步：数值 + 枚举
    r = _submit(sid, 2, {"supply_v": 110, "pin_ok": "一致"}, f"{sid}:s02:a1")
    assert r.status_code == 200
    assert r.json()["session"]["current_seq"] == 3
    assert r.json()["verdict"] == "manual"

    # 第 3 步：超差 → 不推进
    r = _submit(
        sid, 3, {"open_time": 4.2, "close_time": 3.0}, f"{sid}:s03:a1"
    )
    assert r.status_code == 200
    assert r.json()["verdict"] == "fail"
    assert r.json()["session"]["current_seq"] == 3
    assert any("超出上限" in m for m in r.json()["messages"])

    # 复测：新 key → attempt 2，通过后推进
    r = _submit(
        sid, 3, {"open_time": 3.1, "close_time": 3.0}, f"{sid}:s03:a2"
    )
    assert r.status_code == 200
    assert r.json()["verdict"] == "pass"
    assert r.json()["record"]["attempt"] == 2
    assert r.json()["session"]["current_seq"] == 4

    # 还有一步没做，不能标记完成
    r = client.post(f"/api/electro/sessions/{sid}/finish", json={"status": "done"})
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "steps_incomplete"

    # 第 4 步
    r = _submit(
        sid,
        4,
        {"torque": 0.8, "result": "合格", "note": "外观正常"},
        f"{sid}:s04:a1",
    )
    assert r.status_code == 200
    assert r.json()["session"]["current_seq"] == 5

    # 完成
    r = client.post(f"/api/electro/sessions/{sid}/finish", json={"status": "done"})
    assert r.status_code == 200
    assert r.json()["session"]["status"] == "done"

    # 记录报告
    r = client.get(f"/api/electro/records/{sid}")
    assert r.status_code == 200, r.text
    report = r.json()
    assert report["summary"]["total_steps"] == 4
    assert report["summary"]["recorded_steps"] == 4
    assert report["summary"]["attempts"] == 5
    assert report["summary"]["pass"] == 1
    assert report["summary"]["manual"] == 3
    assert report["summary"]["fail"] == 0
    assert len(report["exceptions"]) == 1
    assert report["exceptions"][0]["seq"] == 3
    assert report["exceptions"][0]["attempt"] == 1
    assert [s["final_verdict"] for s in report["steps"]] == [
        "manual",
        "manual",
        "pass",
        "manual",
    ]

    # 每步耗时：首步从会话创建起算，后续步接上一步终了；复测算在本步内
    steps = report["steps"]
    assert steps[0]["started_at"] == report["session"]["created_at"]
    assert steps[0]["ended_at"] == steps[0]["attempts"][-1]["created_at"]
    assert steps[0]["duration_s"] is not None and steps[0]["duration_s"] >= 0
    assert steps[2]["ended_at"] == steps[2]["attempts"][-1]["created_at"]
    assert steps[2]["attempts"][-1]["attempt"] == 2
    for index in range(1, len(steps)):
        assert steps[index]["started_at"] == steps[index - 1]["ended_at"]
    total = sum(s["duration_s"] or 0 for s in steps)
    assert total <= report["summary"]["duration_s"] + 1


def test_client_cannot_forge_verdict(env):
    sid = _start()
    _submit(sid, 1, {"confirm_safe": True}, f"{sid}:s01:a1")
    _submit(sid, 2, {"supply_v": 110, "pin_ok": "一致"}, f"{sid}:s02:a1")

    # 多传一个 verdict 字段：Pydantic 忽略，服务端仍按实测值判 fail
    r = client.post(
        f"/api/electro/sessions/{sid}/steps/3",
        json={
            "values": {"open_time": 9.9, "close_time": 3.0},
            "verdict": "pass",
        },
        headers={"Idempotency-Key": f"{sid}:s03:forge"},
    )
    assert r.status_code == 200
    assert r.json()["verdict"] == "fail"


def test_missing_idempotency_key_is_400(env):
    sid = _start()
    r = client.post(
        f"/api/electro/sessions/{sid}/steps/1", json={"values": {"confirm_safe": True}}
    )
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "idempotency_key_required"


def test_missing_criterion_is_422_with_id(env):
    sid = _start()
    _submit(sid, 1, {"confirm_safe": True}, f"{sid}:s01:a1")
    r = _submit(sid, 2, {"supply_v": 110}, f"{sid}:s02:a1")
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "missing_criterion"
    assert r.json()["detail"]["criterion_id"] == "pin_ok"


def test_abort_flow(env):
    sid = _start()
    _submit(sid, 1, {"confirm_safe": True}, f"{sid}:s01:a1")

    r = client.post(
        f"/api/electro/sessions/{sid}/finish",
        json={"status": "aborted", "note": "现场条件不具备"},
    )
    assert r.status_code == 200
    assert r.json()["session"]["status"] == "aborted"
    assert r.json()["session"]["note"] == "现场条件不具备"

    # 结束后不能再提交
    r = _submit(sid, 2, {"supply_v": 110, "pin_ok": "一致"}, f"{sid}:s02:a1")
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "session_closed"

    report = client.get(f"/api/electro/records/{sid}").json()
    assert report["summary"]["aborted"] is True
    assert report["summary"]["recorded_steps"] == 1

    # 中止后未执行的步骤：耗时为 null，不能拿"0 秒"冒充做过
    assert report["steps"][0]["duration_s"] is not None
    for step in report["steps"][1:]:
        assert step["final_verdict"] == "skipped"
        assert step["started_at"] is None
        assert step["ended_at"] is None
        assert step["duration_s"] is None


def test_unknown_session_and_guide(env):
    assert client.get("/api/electro/sessions/s_0000000000000000").status_code == 404
    assert client.get("/api/electro/records/s_0000000000000000").status_code == 404
    r = client.post("/api/electro/sessions", json={"guide_id": "g_not_exist_000"})
    assert r.status_code == 404


def test_draft_guide_can_be_run_by_link(env):
    guide = library.load_fixtures(SAMPLES)[0]
    guide.id = "g_draft_run_001"
    store.save_guide(guide, status="draft")

    r = client.post("/api/electro/sessions", json={"guide_id": "g_draft_run_001"})
    assert r.status_code == 201
    assert r.json()["guide"]["id"] == "g_draft_run_001"


def test_session_creation_is_rate_limited(env, monkeypatch):
    monkeypatch.setattr(session_service, "SESSION_PER_HOUR", 2)
    session_service.reset_rate_limit()

    for _ in range(2):
        r = client.post("/api/electro/sessions", json={"guide_id": GUIDE_ID})
        assert r.status_code == 201
    r = client.post("/api/electro/sessions", json={"guide_id": GUIDE_ID})
    assert r.status_code == 429
    assert r.json()["detail"]["code"] == "rate_limited"
    assert r.json()["detail"]["retry_after"] >= 1
