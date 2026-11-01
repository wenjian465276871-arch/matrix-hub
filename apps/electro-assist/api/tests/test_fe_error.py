"""前端错误上报（`POST /fe-error`）。

这不是业务接口，测的是**它不会成为新的攻击面**：

1. 超长字段由 pydantic 直接拒（不接受任意大小请求体）；
2. 限流独立，报错风暴不会挤占生成/排查配额；
3. 不落库——只写日志，否则等于给公开站加了一个匿名可写的表；
4. 返回 204，上报失败不会再触发一次上报。
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

import store
from main import app
from routers import fe as fe_router

client = TestClient(app)


@pytest.fixture(autouse=True)
def _reset():
    fe_router.reset_limiter()
    yield
    fe_router.reset_limiter()


def test_accepts_minimal_payload():
    r = client.post("/api/electro/fe-error", json={"message": "TypeError: x is not a function"})
    assert r.status_code == 204
    assert r.text == ""


def test_rejects_oversized_fields():
    r = client.post(
        "/api/electro/fe-error",
        json={"message": "x" * 301},
    )
    assert r.status_code == 422


def test_rejects_unknown_fields():
    """`extra="forbid"`：上报体是个白名单，不接受"顺手多带一个字段"。"""
    r = client.post(
        "/api/electro/fe-error",
        json={"message": "boom", "cookie": "session=abc"},
    )
    assert r.status_code == 422


def test_rate_limited(monkeypatch):
    monkeypatch.setenv("FE_ERROR_PER_HOUR", "2")
    monkeypatch.setenv("FE_ERROR_SITE_PER_DAY", "2")
    fe_router.reset_limiter()

    for _ in range(2):
        assert client.post("/api/electro/fe-error", json={"message": "boom"}).status_code == 204
    r = client.post("/api/electro/fe-error", json={"message": "boom"})
    assert r.status_code == 429
    assert r.headers["Retry-After"]


def test_does_not_write_to_database():
    """只进日志。写入数据库意味着匿名可以无限灌表，且会污染用量/记录统计。"""
    before = store.count_guides()
    client.post(
        "/api/electro/fe-error",
        json={"message": "boom", "route": "/run/s_x", "stack": "at foo()"},
    )
    assert store.count_guides() == before
