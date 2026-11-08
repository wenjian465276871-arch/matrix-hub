"""故障注入开关的行为（2026-11-08 加，为演练"看门狗自动回滚"服务）。

这四条断言要钉住的是**开关的边界**，不是 500 本身：

1. 不设变量 ⇒ 完全无影响（生产默认就是这个状态）；
2. 设了前缀 ⇒ 命中前缀的路径返回 500，且响应是纯文本 `fault-injected`；
3. 没命中前缀的路径照常；
4. `/healthz` 永远不被注入——**这是整套演练的前提**：探针必须能过，
   否则回滚会走"探针失败"那条分支，验不到"起来了但请求都 500"这条更难的分支。

第 4 条尤其重要：如果哪天有人把注入范围写成 `/`，看门狗会因为探针不通而回滚，
看起来"演练成功"，实际验的是另一条路径——**假通过比失败更糟**，所以这里直接钉死。
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from main import app

client = TestClient(app)


def test_disabled_by_default(monkeypatch):
    monkeypatch.delenv("FAULT_5XX_PATHS", raising=False)
    r = client.get("/api/electro/diagnose/kb")
    assert r.status_code == 200


def test_hits_configured_prefix(monkeypatch):
    monkeypatch.setenv("FAULT_5XX_PATHS", "/api/electro/diagnose")
    r = client.get("/api/electro/diagnose/kb")
    assert r.status_code == 500
    assert r.text == "fault-injected"
    # ref 仍要回写：演练时靠它把 500 与日志对上
    assert r.headers.get("X-Request-Id")


def test_other_paths_unaffected(monkeypatch):
    monkeypatch.setenv("FAULT_5XX_PATHS", "/api/electro/diagnose")
    r = client.get("/api/electro/guides")
    assert r.status_code == 200


def test_healthz_never_injected(monkeypatch):
    """哪怕把注入范围写成根路径，/healthz 也必须活——否则演练验的是另一条分支。"""
    monkeypatch.setenv("FAULT_5XX_PATHS", "/")
    assert client.get("/healthz").status_code == 200
    assert client.get("/healthz", params={"scope": "live"}).status_code == 200
