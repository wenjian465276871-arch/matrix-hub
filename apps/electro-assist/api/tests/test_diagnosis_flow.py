"""逐步诊断（故障树 + 回填）的契约测试。

这一层最容易出事的地方不是"能不能答"，而是"能不能不答"：
- 顺序必须由服务端决定，客户端不能跳步；
- 测量值必须由服务端判定，不能让前端算完再告诉后端"通过"；
- 结束之后不能再改，否则结论与记录会对不上。
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from main import app

client = TestClient(app)

BASE = "/api/electro/diagnose/runs"


def _start(**body) -> dict:
    r = client.post(BASE, json=body)
    assert r.status_code == 201, r.text
    return r.json()


def test_start_returns_first_check_and_progress():
    data = _start(symptom="门到关闭位不锁闭", entry_id="kb_door_air_pressure")
    assert data["run"]["status"] == "active"
    assert data["current_check"]["order"] == 1
    assert data["current_check"]["kind"] == "measure"
    assert data["progress"] == {"done": 0, "total": 4}
    assert data["disclaimer"] == "演示数据 · 非实际作业依据"
    assert data["conclusion"] is None


def test_measure_within_range_passes_and_advances():
    data = _start(symptom="门到关闭位不锁闭", entry_id="kb_door_air_pressure")
    run_id = data["run"]["id"]

    r = client.post(f"{BASE}/{run_id}/checks/1", json={"value": 0.62})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["steps"][0]["verdict"] == "pass"
    assert body["steps"][0]["value"] == "0.62"
    assert body["current_check"]["order"] == 2
    assert body["run"]["status"] == "active"


def test_measure_out_of_range_concludes_without_client_judgement():
    data = _start(symptom="门到关闭位不锁闭", entry_id="kb_door_air_pressure")
    run_id = data["run"]["id"]

    body = client.post(f"{BASE}/{run_id}/checks/1", json={"value": 0.2}).json()
    assert body["run"]["status"] == "concluded"
    assert body["current_check"] is None
    assert body["conclusion"]["kind"] == "fail"
    assert body["conclusion"]["check_order"] == 1
    assert body["conclusion"]["safety"]


def test_confirm_fail_concludes_immediately():
    data = _start(symptom="门关到一半又弹开", entry_id="kb_door_anti_pinch")
    run_id = data["run"]["id"]

    body = client.post(f"{BASE}/{run_id}/checks/1", json={"result": "fail"}).json()
    assert body["conclusion"]["kind"] == "fail"
    assert body["conclusion"]["cause"]
    assert body["conclusion"]["sources"]


def test_walking_all_checks_ends_as_exhausted():
    data = _start(symptom="门关到一半又弹开", entry_id="kb_door_anti_pinch")
    run_id = data["run"]["id"]

    body = data
    for order in (1, 2, 3, 4):
        body = client.post(f"{BASE}/{run_id}/checks/{order}", json={"result": "pass"}).json()
        assert body["progress"]["done"] == order
    assert body["run"]["status"] == "concluded"
    assert body["conclusion"]["kind"] == "exhausted"
    assert body["current_check"] is None


def test_out_of_order_submission_is_rejected():
    data = _start(symptom="门关到一半又弹开", entry_id="kb_door_anti_pinch")
    run_id = data["run"]["id"]

    r = client.post(f"{BASE}/{run_id}/checks/3", json={"result": "pass"})
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "wrong_order"


def test_finished_run_rejects_further_submission():
    data = _start(symptom="门关到一半又弹开", entry_id="kb_door_anti_pinch")
    run_id = data["run"]["id"]
    client.post(f"{BASE}/{run_id}/checks/1", json={"result": "fail"})

    r = client.post(f"{BASE}/{run_id}/checks/2", json={"result": "pass"})
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "run_finished"


def test_measure_requires_value_and_confirm_requires_result():
    data = _start(symptom="门到关闭位不锁闭", entry_id="kb_door_air_pressure")
    run_id = data["run"]["id"]
    r = client.post(f"{BASE}/{run_id}/checks/1", json={"result": "pass"})
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "value_required"

    other = _start(symptom="门关到一半又弹开", entry_id="kb_door_anti_pinch")
    r = client.post(f"{BASE}/{other['run']['id']}/checks/1", json={})
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "result_required"


def test_abort_marks_run_and_keeps_conclusion():
    data = _start(symptom="门关到一半又弹开", entry_id="kb_door_anti_pinch")
    run_id = data["run"]["id"]

    body = client.post(f"{BASE}/{run_id}/abort").json()
    assert body["run"]["status"] == "aborted"
    assert body["conclusion"]["kind"] == "aborted"
    assert client.post(f"{BASE}/{run_id}/checks/1", json={"result": "pass"}).status_code == 409


def test_unknown_run_and_bad_id_are_404():
    assert client.get(f"{BASE}/d_{'0' * 16}").status_code == 404
    assert client.get(f"{BASE}/not-a-run").status_code == 404
    assert client.post(f"{BASE}/d_{'0' * 16}/checks/1", json={"result": "pass"}).status_code == 404


def test_start_rejects_unknown_entry_and_session():
    r = client.post(BASE, json={"symptom": "门有问题", "entry_id": "kb_not_exists"})
    assert r.status_code == 404
    assert r.json()["detail"]["code"] == "entry_not_found"

    r = client.post(BASE, json={"symptom": "门有问题", "session_id": "s_0000000000000000"})
    assert r.status_code == 404
    assert r.json()["detail"]["code"] == "session_not_found"


def test_start_by_symptom_only_uses_top_hit():
    data = _start(symptom="空调不制冷，出风口温度降不下来")
    assert data["entry"]["system"] == "hvac"
    assert data["candidates"], "要学会话里带上候选，方便换一条重试"
    assert data["candidates"][0]["id"] == data["entry"]["id"]


def test_uncovered_subsystem_cannot_start_a_run():
    r = client.post(BASE, json={"symptom": "制动缸压力不足，闸瓦间隙大"})
    assert r.status_code == 404
    assert r.json()["detail"]["code"] == "system_not_covered"


# ---- 边界与并发（M4a 2026-10-22）------------------------------------------
# 这两类缺陷的共同点：正常操作不会触发，但一旦触发就绕过判定或暴露 500。


def test_non_finite_measure_values_are_rejected():
    """NaN 与任何数比较都是 False，会直接落进"通过"分支——必须挡在判定之前。"""
    data = _start(symptom="门到关闭位不锁闭", entry_id="kb_door_air_pressure")
    run_id = data["run"]["id"]

    for literal in ("NaN", "Infinity", "-Infinity"):
        r = client.post(
            f"{BASE}/{run_id}/checks/1",
            content=f'{{"value": {literal}}}',
            headers={"Content-Type": "application/json"},
        )
        assert r.status_code == 422, (literal, r.text)
        assert r.json()["detail"]["code"] == "value_invalid"

    # 一次都不该推进：仍是第 1 项、零条记录
    state = client.get(f"{BASE}/{run_id}").json()
    assert state["run"]["current_order"] == 1
    assert state["steps"] == []


def test_absurd_measure_value_is_rejected():
    data = _start(symptom="门到关闭位不锁闭", entry_id="kb_door_air_pressure")
    run_id = data["run"]["id"]
    r = client.post(f"{BASE}/{run_id}/checks/1", json={"value": 1e308})
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "value_invalid"


def test_duplicate_check_submission_returns_409_not_500():
    """唯一索引挡住重复写；但契约必须是 409，而不是让用户看到 500。"""
    from store import add_diagnose_step

    data = _start(symptom="门到关闭位不锁闭", entry_id="kb_door_air_pressure")
    run_id = data["run"]["id"]
    # 模拟"并发里已经有一条落库"：直接写一条同序号的记录
    add_diagnose_step(run_id, 1, "pass", value="0.6")

    r = client.post(f"{BASE}/{run_id}/checks/1", json={"value": 0.6})
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "duplicate_check"

    # 数据仍然只有一条，没有写坏
    state = client.get(f"{BASE}/{run_id}").json()
    assert len(state["steps"]) == 1


# ---- 边界与并发（M4a 2026-10-22）------------------------------------------
# 这两类缺陷的共同点：正常操作不会触发，但一旦触发就绕过判定或暴露 500。


def test_non_finite_measure_values_are_rejected():
    """NaN 与任何数比较都是 False，会直接落进"通过"分支——必须挡在判定之前。"""
    data = _start(symptom="门到关闭位不锁闭", entry_id="kb_door_air_pressure")
    run_id = data["run"]["id"]

    for literal in ("NaN", "Infinity", "-Infinity"):
        r = client.post(
            f"{BASE}/{run_id}/checks/1",
            content=f'{{"value": {literal}}}',
            headers={"Content-Type": "application/json"},
        )
        assert r.status_code == 422, (literal, r.text)
        assert r.json()["detail"]["code"] == "value_invalid"

    # 一次都不该推进：仍是第 1 项、零条记录
    state = client.get(f"{BASE}/{run_id}").json()
    assert state["run"]["current_order"] == 1
    assert state["steps"] == []


def test_absurd_measure_value_is_rejected():
    data = _start(symptom="门到关闭位不锁闭", entry_id="kb_door_air_pressure")
    run_id = data["run"]["id"]
    r = client.post(f"{BASE}/{run_id}/checks/1", json={"value": 1e308})
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "value_invalid"


def test_duplicate_check_submission_returns_409_not_500():
    """唯一索引挡住重复写；但契约必须是 409，而不是让用户看到 500。"""
    from store import add_diagnose_step

    data = _start(symptom="门到关闭位不锁闭", entry_id="kb_door_air_pressure")
    run_id = data["run"]["id"]
    # 模拟"并发里已经有一条落库"：直接写一条同序号的记录
    add_diagnose_step(run_id, 1, "pass", value="0.6")

    r = client.post(f"{BASE}/{run_id}/checks/1", json={"value": 0.6})
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "duplicate_check"

    # 数据仍然只有一条，没有写坏
    state = client.get(f"{BASE}/{run_id}").json()
    assert len(state["steps"]) == 1
