"""诊断 run 的状态写入必须带 CAS（评审 2026-11-08 第三轮 P2-1 / 待办 R5-3）。

**缺陷长什么样**：`submit` 是「读状态 → 落 step → 写状态」三步。读的时候
`status=active`，写完 step 之后用户点了「结束诊断」，`abort` 把状态改成
`aborted`；随后 `submit` 那次 `status="active"` 的写把 `aborted` 覆盖回去，
留下 `status=active` + `conclusion=aborted` 的矛盾态。

**为什么用注入而不是 sleep 撑窗口**：上一轮用 `sleep(0.5)` 复现过，但那种用例
既慢又不稳（机器快时窗口没撑开就绿了）。这里直接把 `add_diagnose_step`
换成「落库之后立刻 abort」，把 TOCTOU 变成确定性时序——每次跑都命中同一条路径。

**反向验证**：把 `update_diagnose_run` 的 `expect_status` 去掉（或忽略返回值），
`test_abort_is_not_undone_by_inflight_submit` 立刻红（run 会回到 active）。
"""
from __future__ import annotations

import pytest

import store
from services import diagnosis
from services.diagnosis import DiagnosisError

ENTRY = "kb_door_air_pressure"
SYMPTOM = "门到关闭位不锁闭"


def _start() -> str:
    data = diagnosis.start(SYMPTOM, entry_id=ENTRY)
    assert data["run"]["status"] == "active"
    return data["run"]["id"]


def test_abort_is_not_undone_by_inflight_submit(monkeypatch):
    run_id = _start()
    real_add = store.add_diagnose_step

    def add_then_abort(*args, **kwargs):
        step_id = real_add(*args, **kwargs)
        # 用户在「step 已落库、结论还没写回」这一刻点了结束诊断。
        diagnosis.abort(run_id)
        return step_id

    monkeypatch.setattr(store, "add_diagnose_step", add_then_abort)

    with pytest.raises(DiagnosisError) as exc:
        diagnosis.submit(run_id, 1, value=0.62)

    assert exc.value.code == "run_finished"
    assert exc.value.status == 409

    run = store.get_diagnose_run(run_id)
    assert run is not None
    assert run["status"] == "aborted", "终态被在飞 submit 复活了"
    assert run["current_order"] is None
    assert run["conclusion"]["kind"] == "aborted"


def test_double_abort_is_idempotent():
    """两次 abort 只有一次命中，第二次不该报错，也不该改状态。"""
    run_id = _start()

    first = diagnosis.abort(run_id)
    second = diagnosis.abort(run_id)

    assert first["run"]["status"] == "aborted"
    assert second["run"]["status"] == "aborted"
    assert second["conclusion"]["kind"] == "aborted"

    run = store.get_diagnose_run(run_id)
    assert run is not None and run["status"] == "aborted"


def test_normal_submit_still_advances_after_cas():
    """CAS 不能把正常路径拦住：这是"加了守卫"与"加了功能性 bug"的分界。"""
    run_id = _start()

    body = diagnosis.submit(run_id, 1, value=0.62)

    assert body["run"]["status"] == "active"
    assert body["current_check"]["order"] == 2
    assert len(body["steps"]) == 1
