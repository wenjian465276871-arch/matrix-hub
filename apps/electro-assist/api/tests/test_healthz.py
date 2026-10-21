"""健康检查契约：degraded 必须真的能被部署脚本看见。"""
from __future__ import annotations

from collections import namedtuple

import pytest
from fastapi.testclient import TestClient

from main import app

client = TestClient(app)
Disk = namedtuple("Disk", "total used free")


def test_healthz_ok_with_normal_disk(monkeypatch):
    monkeypatch.setattr("shutil.disk_usage", lambda _p: Disk(100, 50, 50))
    body = client.get("/healthz").json()
    assert body["checks"]["disk"] == "ok"
    assert body["status"] == "ok"


def test_healthz_degraded_when_disk_low(monkeypatch):
    monkeypatch.setattr("shutil.disk_usage", lambda _p: Disk(100, 95, 5))
    body = client.get("/healthz").json()
    assert body["checks"]["disk"] == "error"
    assert body["status"] == "degraded"


def test_healthz_disk_threshold_from_env(monkeypatch):
    monkeypatch.setenv("HEALTHZ_MIN_FREE_RATIO", "0.50")
    monkeypatch.setattr("shutil.disk_usage", lambda _p: Disk(100, 60, 40))
    body = client.get("/healthz").json()
    assert body["checks"]["disk"] == "error"
