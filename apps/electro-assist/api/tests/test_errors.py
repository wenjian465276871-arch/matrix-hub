"""错误信封与请求号：500 也必须是可解析、可追溯的。

没有它，前端只能显示"未知错误"，线上排障只能靠时间对齐日志。
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from main import app
from services import knowledge

client = TestClient(app, raise_server_exceptions=False)


def test_unhandled_error_returns_envelope_with_ref(monkeypatch):
    def boom(*_args, **_kwargs):
        raise RuntimeError("boom")

    monkeypatch.setattr(knowledge, "diagnose", boom)
    r = client.post("/api/electro/diagnose", json={"symptom": "门关不上"})

    assert r.status_code == 500
    body = r.json()
    assert body["detail"]["code"] == "internal_error"
    assert body["detail"]["message"]
    ref = body["detail"]["ref"]
    assert ref and ref != "-"
    # 响应头与信封必须对得上，用户看到的编号才能拿来查日志
    assert r.headers["X-Request-Id"] == ref


def test_success_response_carries_request_id():
    r = client.get("/healthz")
    assert r.status_code == 200
    assert r.headers.get("X-Request-Id")


def test_request_id_is_echoed_when_client_supplies_one():
    r = client.get("/healthz", headers={"X-Request-Id": "abc12345"})
    assert r.headers["X-Request-Id"] == "abc12345"
