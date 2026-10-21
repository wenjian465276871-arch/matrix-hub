"""口令通道契约测试。

要证明的四条边界：
1. 未配置口令时功能整体关闭（503），生成接口行为不变；
2. 错误口令不给令牌，正确口令给短期令牌；
3. 令牌只豁免「每 IP」配额，**全站预算仍然生效**；
4. 验证接口本身限流，避免被当成爆破入口。
"""
from __future__ import annotations

import time

import pytest
from fastapi.testclient import TestClient

import passcode
import store
from main import app
from routers import passcode as passcode_router
from services.jobqueue import job_queue

client = TestClient(app)
TEXT = "工序：开关门功能试验。检查开关门时间 2.0-3.5s，确认门到位信号正常。"
IP = "testclient"


@pytest.fixture()
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "electro.db"))
    monkeypatch.setenv("GENERATE_PER_HOUR", "1")
    monkeypatch.setenv("GENERATE_PER_DAY", "2")
    monkeypatch.setenv("ELECTRO_PASSCODE", "demo-code")
    monkeypatch.setenv("PASSCODE_PER_HOUR", "2")
    monkeypatch.setenv("PASSCODE_PER_DAY", "10")
    store.init_db()
    passcode_router.reset_limiter()
    job_queue.reset()
    yield
    passcode_router.reset_limiter()
    job_queue.reset()


def _token() -> str:
    r = client.post("/api/electro/passcode/verify", json={"code": "demo-code"})
    assert r.status_code == 200, r.text
    return r.json()["token"]


def test_disabled_returns_503(env, monkeypatch):
    monkeypatch.delenv("ELECTRO_PASSCODE")
    r = client.post("/api/electro/passcode/verify", json={"code": "demo-code"})
    assert r.status_code == 503
    assert r.json()["detail"]["code"] == "passcode_disabled"


def test_wrong_code_rejected_right_code_issues_token(env):
    r = client.post("/api/electro/passcode/verify", json={"code": "nope"})
    assert r.status_code == 401
    assert r.json()["detail"]["code"] == "passcode_invalid"

    body = client.post("/api/electro/passcode/verify", json={"code": "demo-code"}).json()
    assert body["expires_in"] == passcode.TOKEN_TTL_SECONDS
    assert passcode.verify_token(body["token"])


def test_tampered_and_expired_tokens_rejected(env):
    token = _token()
    tampered = token[:-1] + ("0" if token[-1] != "0" else "1")
    assert not passcode.verify_token(tampered)
    assert not passcode.verify_token("v1.1.deadbeef")
    assert not passcode.verify_token(None)

    expired = passcode.issue(now=time.time() - passcode.TOKEN_TTL_SECONDS - 10)["token"]
    assert not passcode.verify_token(expired)


def test_verify_is_rate_limited(env):
    assert client.post("/api/electro/passcode/verify", json={"code": "x"}).status_code == 401
    assert client.post("/api/electro/passcode/verify", json={"code": "x"}).status_code == 401
    r = client.post("/api/electro/passcode/verify", json={"code": "x"})
    assert r.status_code == 429
    assert r.json()["detail"]["code"] == "rate_limited"


def test_token_bypasses_per_ip_quota_only(env):
    assert client.post("/api/electro/generate", json={"text": TEXT}).status_code == 202
    # 每 IP 每小时 1 次：第二次必须被拦
    blocked = client.post("/api/electro/generate", json={"text": TEXT})
    assert blocked.status_code == 429
    assert blocked.json()["detail"]["code"] == "hour_quota"

    token = _token()
    headers = {"X-Passcode-Token": token}
    for _ in range(2):
        r = client.post("/api/electro/generate", json={"text": TEXT}, headers=headers)
        assert r.status_code == 202, r.text


def test_invalid_token_is_rejected_not_silently_downgraded(env):
    r = client.post(
        "/api/electro/generate",
        json={"text": TEXT},
        headers={"X-Passcode-Token": "v1.1.deadbeef"},
    )
    assert r.status_code == 401
    assert r.json()["detail"]["code"] == "passcode_invalid"


def test_budget_still_applies_with_token(env, monkeypatch):
    monkeypatch.setenv("GENERATE_DAILY_BUDGET_MICROS", "1000")
    store.record_usage(model="fake", prompt_tokens=10, completion_tokens=10, cost_micros=2000)
    token = _token()
    r = client.post(
        "/api/electro/generate",
        json={"text": TEXT},
        headers={"X-Passcode-Token": token},
    )
    assert r.status_code == 429
    assert r.json()["detail"]["code"] == "budget_exhausted"
