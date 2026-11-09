"""任务终态不可复活，但账不能丢（2026-11-10 评审 P2-4）。

## 场景（真实会发生的顺序）

1. 容器重启，`sweep_stale_jobs` 把还在 `running` 的任务收敛成 `timeout`，
   用户看到"超时，请重试"；
2. 那个其实没死的 worker 回来，交付结果。

旧实现里第 2 步会无条件把 `timeout` 改成 `succeeded`——用户看到的结论来回跳，
成功指标也被污染。新实现里**状态保持 timeout**（先写的终态更权威），
但 token 与成本照样记账（钱确实花了）。
"""
from __future__ import annotations

import pytest

import store

FAR_FUTURE = "2099-01-01T00:00:00+00:00"


@pytest.fixture()
def db(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "electro.db"))
    store.init_db()
    return tmp_path


def _new_job() -> str:
    job = store.create_job(kind="generate", client_ip="10.0.0.7", input_text="x" * 20)
    assert store.mark_job_running(job)
    return job


def test_normal_finish_still_works(db):
    job = _new_job()
    out = store.finish_job(job, "succeeded", prompt_tokens=100, completion_tokens=50)
    assert out["status"] == "succeeded"
    assert out["status_preserved"] is False
    assert store.get_job(job)["completion_tokens"] == 50


def test_swept_job_is_not_resurrected_but_tokens_are_recorded(db):
    job = _new_job()
    assert store.sweep_stale_jobs(FAR_FUTURE) == 1

    out = store.finish_job(job, "succeeded", prompt_tokens=800, completion_tokens=400)
    assert out["status"] == "timeout", "终态被后来的 worker 改写了"
    assert out["status_preserved"] is True

    row = store.get_job(job)
    assert row["status"] == "timeout"
    assert row["prompt_tokens"] == 800 and row["completion_tokens"] == 400


def test_second_terminal_does_not_overwrite_the_first(db):
    job = _new_job()
    store.finish_job(job, "succeeded", prompt_tokens=10, completion_tokens=5)
    out = store.finish_job(job, "failed", error_code="server", prompt_tokens=99, completion_tokens=66)

    assert out["status"] == "succeeded"
    assert out["status_preserved"] is True
    row = store.get_job(job)
    assert row["error_code"] is None, "错误码不该被后到的失败覆盖"
    assert row["completion_tokens"] == 66, "后到的账仍要记（钱已花）"


def test_repairs_are_not_overwritten_by_late_writer(db):
    """先落的那份降级说明才是真正产出这份指导书的生成，不能被后来者盖掉。"""
    job = _new_job()
    store.finish_job(job, "succeeded", repairs=["第一处"])
    store.finish_job(job, "succeeded", repairs=["后来者"])
    row = store.get_job(job)
    assert row["repairs"] == '["第一处"]'
