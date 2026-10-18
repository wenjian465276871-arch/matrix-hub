"""生成接口与作业队列的契约测试。

重点不是"能返回 202"，而是五条会真出事的边界：
1. 同一文本两次生成 → **两个不同 id**（模型 id 不能当主键）；
2. 失败/超时不占访客配额，但成功第三次必须 429；
3. `retry_of` 只能用于自己失败的任务，且只能用一次；
4. 进程重启后残留 job 必须收敛为 timeout，不能永远 running；
5. 全站日预算打满时，连 job 都不该创建。
"""
from __future__ import annotations

import copy
import json
import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import store
from llm import Completion, LLMError, Usage
from main import app
from services import generation
from services.jobqueue import job_queue

client = TestClient(app)
SAMPLE = json.loads(
    (Path(__file__).resolve().parent.parent / "samples" / "door_switch_test.json").read_text(
        encoding="utf-8"
    )
)
TEXT = "工序：开关门功能试验。检查开关门时间 2.0-3.5s，确认门到位信号正常。"
# TestClient 的默认客户端地址；与 `ratelimit.client_ip()` 的取值保持一致。
IP = "testclient"


@pytest.fixture()
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "electro.db"))
    monkeypatch.setenv("GENERATE_PER_HOUR", "2")
    monkeypatch.setenv("GENERATE_PER_DAY", "10")
    monkeypatch.setenv("GENERATE_DAILY_BUDGET_MICROS", "3000000")
    store.init_db()
    job_queue.reset()
    yield
    job_queue.reset()


def _payload() -> dict:
    data = copy.deepcopy(SAMPLE)
    # 模拟模型自己写的语义化 id：服务端必须覆盖它
    data["id"] = "g_model_chosen_001"
    return data


class FakeProvider:
    name = "fake-model"

    def __init__(self, body: dict | None = None, error: Exception | None = None):
        self.body = body
        self.error = error
        self.calls = 0

    def structured(self, **_kwargs) -> Completion:
        self.calls += 1
        if self.error is not None:
            raise self.error
        return Completion(
            text=json.dumps(self.body, ensure_ascii=False),
            model=self.name,
            usage=Usage(prompt_tokens=1000, completion_tokens=500, reasoning_tokens=100),
            latency_ms=12,
        )

    def close(self) -> None:
        pass


def test_generate_requires_meaningful_text(env):
    r = client.post("/api/electro/generate", json={"text": "太短"})
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "input_too_short"


def test_job_snapshot_and_malformed_id(env):
    job_id = store.create_job(kind="generate", client_ip=IP, input_text=TEXT)
    r = client.get(f"/api/electro/jobs/{job_id}")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "queued"
    assert body["poll_after_ms"] == 1000
    assert body["guide_id"] is None

    assert client.get("/api/electro/jobs/j_deadbeef").status_code == 404


def test_run_saves_draft_with_server_assigned_id(env):
    job_id = store.create_job(kind="generate", client_ip=IP, input_text=TEXT)
    provider = FakeProvider(body=_payload())

    generation.run(job_id, TEXT, provider_factory=lambda: provider)

    job = store.get_job(job_id)
    assert job["status"] == "succeeded"
    assert job["guide_id"] != "g_model_chosen_001"
    assert re.match(r"^g_[0-9a-f]{16}$", job["guide_id"])
    assert job["cost_micros"] > 0

    row = store.get_guide(job["guide_id"])
    assert row is not None
    assert row["status"] == "draft"
    assert row["guide"]["id"] == job["guide_id"]
    assert row["summary"]
    assert row["source_note"]
    assert provider.calls == 1

    usage = store.usage_summary()
    assert usage["calls"] == 1
    assert usage["prompt_tokens"] == 1000
    assert usage["cached_tokens"] == 0


def test_same_text_twice_gets_two_ids(env):
    ids = []
    for _ in range(2):
        job_id = store.create_job(kind="generate", client_ip=IP, input_text=TEXT)
        generation.run(job_id, TEXT, provider_factory=lambda: FakeProvider(body=_payload()))
        ids.append(store.get_job(job_id)["guide_id"])
    assert len(set(ids)) == 2


def test_failure_is_recorded_and_usage_kept(env):
    job_id = store.create_job(kind="generate", client_ip=IP, input_text=TEXT)
    err = LLMError(
        "timeout",
        "模型调用超过 40s",
        usage=Usage(prompt_tokens=100, completion_tokens=20),
        cost_micros=300,
    )

    def factory():
        raise err

    generation.run(job_id, TEXT, provider_factory=factory)

    job = store.get_job(job_id)
    assert job["status"] == "timeout"
    assert job["error_code"] == "timeout"
    assert job["prompt_tokens"] > 0
    assert store.usage_summary()["calls"] >= 1


def test_hour_quota_and_failed_jobs_do_not_consume(env):
    ids = []
    for _ in range(2):
        r = client.post("/api/electro/generate", json={"text": TEXT})
        assert r.status_code == 202, r.text
        ids.append(r.json()["job_id"])

    r = client.post("/api/electro/generate", json={"text": TEXT})
    assert r.status_code == 429
    assert r.json()["detail"]["code"] == "hour_quota"
    assert int(r.headers["Retry-After"]) >= 1

    # 系统失败不占配额：把一个 job 标成 timeout，下一次应立即放行
    store.finish_job(ids[0], "timeout", error_code="timeout")
    r = client.post("/api/electro/generate", json={"text": TEXT})
    assert r.status_code == 202, r.text


def test_retry_of_requires_failed_job_and_is_single_use(env):
    queued = store.create_job(kind="generate", client_ip=IP, input_text=TEXT)
    r = client.post("/api/electro/generate", json={"text": TEXT, "retry_of": queued})
    assert r.status_code == 429
    assert r.json()["detail"]["code"] == "retry_not_failed"

    failed = store.create_job(kind="generate", client_ip=IP, input_text=TEXT)
    store.finish_job(failed, "failed", error_code="validation")
    r = client.post("/api/electro/generate", json={"text": TEXT, "retry_of": failed})
    assert r.status_code == 202, r.text

    r = client.post("/api/electro/generate", json={"text": TEXT, "retry_of": failed})
    assert r.status_code == 429
    assert r.json()["detail"]["code"] == "retry_used"


def test_retry_of_cannot_be_stolen_by_another_ip(env):
    failed = store.create_job(kind="generate", client_ip="198.51.100.9", input_text=TEXT)
    store.finish_job(failed, "failed", error_code="timeout")

    r = client.post("/api/electro/generate", json={"text": TEXT, "retry_of": failed})
    assert r.status_code == 429
    assert r.json()["detail"]["code"] == "retry_forbidden"


def test_site_budget_exhausted_does_not_create_job(env, monkeypatch):
    monkeypatch.setenv("GENERATE_DAILY_BUDGET_MICROS", "1000")
    store.record_usage(model="fake", prompt_tokens=10, completion_tokens=10, cost_micros=2000)

    before = store.count_jobs_today(IP)
    r = client.post("/api/electro/generate", json={"text": TEXT})
    assert r.status_code == 429
    assert r.json()["detail"]["code"] == "budget_exhausted"
    assert store.count_jobs_today(IP) == before


def test_recover_stale_converges_unfinished_jobs(env):
    job_id = store.create_job(kind="generate", client_ip=IP, input_text=TEXT)
    running = store.create_job(kind="generate", client_ip=IP, input_text=TEXT)
    store.mark_job_running(running)

    assert generation.recover_stale() == 2
    assert store.get_job(job_id)["status"] == "timeout"
    assert store.get_job(running)["error_code"] == "stale"


def test_quota_endpoint_shape(env):
    body = client.get("/api/electro/quota").json()
    assert body["hour"]["limit"] == 2
    assert body["day"]["limit"] == 10
    assert body["site_budget"]["limit_cny"] == 3.0
    assert body["queue"]["limit"] == 5
