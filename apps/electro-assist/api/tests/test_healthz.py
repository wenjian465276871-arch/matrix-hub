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


# ---------- 预算水位（开发计划 §11.6 P1「LLM 计量与额度告警」） ----------


def _fix_usage(monkeypatch, cost_micros: int) -> None:
    from services import quota as quota_service

    monkeypatch.setattr(
        quota_service.store,
        "usage_summary",
        lambda day=None: {"cost_micros": cost_micros, "calls": 1},
    )


def test_budget_level_ok(monkeypatch):
    from services import quota as quota_service

    monkeypatch.setenv("GENERATE_DAILY_BUDGET_MICROS", "1000000")
    _fix_usage(monkeypatch, 100_000)  # 10%
    status = quota_service.budget_status()
    assert status.level == "ok"
    assert status.ratio == pytest.approx(0.1)


def test_budget_level_warn_at_threshold(monkeypatch):
    from services import quota as quota_service

    monkeypatch.setenv("GENERATE_DAILY_BUDGET_MICROS", "1000000")
    _fix_usage(monkeypatch, 800_000)  # 80% 恰好压线
    assert quota_service.budget_status().level == "warn"


def test_budget_level_critical(monkeypatch):
    from services import quota as quota_service

    monkeypatch.setenv("GENERATE_DAILY_BUDGET_MICROS", "1000000")
    _fix_usage(monkeypatch, 950_000)
    assert quota_service.budget_status().level == "critical"


def test_budget_threshold_from_env(monkeypatch):
    from services import quota as quota_service

    monkeypatch.setenv("GENERATE_DAILY_BUDGET_MICROS", "1000000")
    monkeypatch.setenv("BUDGET_WARN_RATIO", "0.50")
    _fix_usage(monkeypatch, 600_000)
    assert quota_service.budget_status().level == "warn"


def test_budget_bad_threshold_falls_back(monkeypatch):
    """阈值写错（>1）不能把告警变成永不触发。"""
    from services import quota as quota_service

    monkeypatch.setenv("GENERATE_DAILY_BUDGET_MICROS", "1000000")
    monkeypatch.setenv("BUDGET_WARN_RATIO", "8")  # 明显写错
    _fix_usage(monkeypatch, 850_000)
    assert quota_service.budget_status().level == "warn"


def test_budget_never_degrades_healthz(monkeypatch):
    """/healthz 必须把预算与存活分开：预算打满也不能让部署脚本回滚正常版本。"""
    from services import quota as quota_service

    monkeypatch.setattr("shutil.disk_usage", lambda _p: Disk(100, 50, 50))
    monkeypatch.setenv("GENERATE_DAILY_BUDGET_MICROS", "1000000")
    _fix_usage(monkeypatch, 999_999)
    quota_service.reset_alerts()
    body = client.get("/healthz").json()
    assert body["budget"]["level"] == "critical"
    assert body["budget"]["used_micros"] == 999_999
    assert body["status"] == "ok"
    assert body["checks"] == {"electro": "ok", "db": "ok", "disk": "ok"}


def test_budget_alert_logged_once_per_day(monkeypatch, caplog):
    from services import quota as quota_service

    monkeypatch.setenv("GENERATE_DAILY_BUDGET_MICROS", "1000000")
    _fix_usage(monkeypatch, 900_000)
    quota_service.reset_alerts()
    status = quota_service.budget_status()
    with caplog.at_level("WARNING", logger="electro.quota"):
        assert quota_service.alert_if_needed(status) is True
        assert quota_service.alert_if_needed(status) is False
    assert sum("日预算" in rec.message for rec in caplog.records) == 1
