"""滚动 5xx 统计：部署后回滚判据的数据源。

两条边界最要紧：
1. **4xx 不是服务坏了**——参数写错、链接过期都会 4xx，把它们算进错误率，
   看门狗会在有人乱点链接时回滚一个完全正常的版本；
2. **探针不能稀释比例**——`/healthz` 每 10 分钟一次、永远 200，
   算进去的话一次真实 502 会被稀释到 0.3%，阈值永远碰不到。
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

import main
from core.httpwindow import HttpWindow
from main import app


def test_empty_window_has_zero_ratio():
    snap = HttpWindow().snapshot()
    assert snap["requests"] == 0
    assert snap["errors_5xx"] == 0
    assert snap["ratio"] == 0.0


def test_counts_5xx_only_as_errors():
    window = HttpWindow(window_s=600, bucket_s=60)
    base = 100.0 * 60
    for i in range(98):
        window.record(200, now=base + i)
    window.record(404, now=base + 98)
    window.record(302, now=base + 99)
    window.record(500, now=base + 100)

    snap = window.snapshot(now=base + 101)
    assert snap["requests"] == 101
    assert snap["errors_5xx"] == 1
    assert snap["ratio"] == 0.0099


def test_old_buckets_are_evicted():
    window = HttpWindow(window_s=600, bucket_s=60)
    base = 500.0 * 60
    window.record(500, now=base)
    window.record(200, now=base + 60)
    assert window.snapshot(now=base + 61)["errors_5xx"] == 1

    # 12 分钟之后：两个桶都出窗，只剩新的一条。
    # 边界桶会多留一桶（见 HttpWindow 的注释），所以推到 12 分钟而不是 11 分钟。
    window.record(200, now=base + 720)
    snap = window.snapshot(now=base + 721)
    assert snap["requests"] == 1
    assert snap["errors_5xx"] == 0


def test_rejects_bad_window():
    with pytest.raises(ValueError):
        HttpWindow(window_s=0)
    with pytest.raises(ValueError):
        HttpWindow(window_s=60, bucket_s=120)


@pytest.fixture()
def boom_route():
    """临时挂一条必 500 的路由，用完立刻摘掉。

    不用现成端点凑 500：那要么依赖模型调用（测试里不跑 worker），
    要么依赖某个数据坏掉，都是在测"恰好"而不是测统计。
    """

    @app.get("/__test_boom")
    def _boom() -> dict:  # pragma: no cover - 只在测试里被请求
        raise RuntimeError("boom")

    yield
    app.router.routes = [
        route for route in app.router.routes if getattr(route, "path", "") != "/__test_boom"
    ]


def test_middleware_counts_5xx_and_skips_healthz(boom_route):
    main.http_window.reset()
    client = TestClient(app, raise_server_exceptions=False)

    assert client.get("/healthz").status_code == 200
    assert client.get("/healthz").status_code == 200
    # 探针不进统计
    assert main.http_window.snapshot()["requests"] == 0

    assert client.get("/__test_boom").status_code == 500
    snap = main.http_window.snapshot()
    assert snap["requests"] == 1
    assert snap["errors_5xx"] == 1
    assert snap["ratio"] == 1.0

    assert client.get("/api/electro/guides/g_notthere_0000").status_code == 404
    snap = main.http_window.snapshot()
    assert snap["requests"] == 2
    assert snap["errors_5xx"] == 1
    assert snap["ratio"] == 0.5

    # healthz 自己也要带上这一段：看门狗只读一个端点
    body = client.get("/healthz").json()
    assert body["http"]["requests"] == 2
    assert body["http"]["errors_5xx"] == 1
