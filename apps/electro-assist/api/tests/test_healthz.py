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


# ---------- 分级口径（计划 §2.4） ----------


def test_healthz_live_only_checks_process():
    """liveness 不碰 DB：DB 挂了也要能回答"进程还在"。"""
    body = client.get("/healthz?scope=live").json()
    assert body == {"status": "ok", "scope": "live", "checks": {"process": "ok"}}


def test_healthz_ready_ok(monkeypatch):
    monkeypatch.setattr("shutil.disk_usage", lambda _p: Disk(100, 50, 50))
    r = client.get("/healthz?scope=ready")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"
    assert "budget" not in r.json()  # readiness 每次探测都读用量太贵


def test_healthz_ready_degraded_returns_503(monkeypatch):
    """ready 必须用状态码表达失败：探针只看 HTTP，不看 JSON 正文。"""
    monkeypatch.setattr("shutil.disk_usage", lambda _p: Disk(100, 95, 5))
    r = client.get("/healthz?scope=ready")
    assert r.status_code == 503
    assert r.json()["status"] == "degraded"
    assert r.json()["checks"]["disk"] == "error"


def test_healthz_electro_is_readiness_alias(monkeypatch):
    monkeypatch.setattr("shutil.disk_usage", lambda _p: Disk(100, 95, 5))
    assert client.get("/healthz?scope=electro").status_code == 503


def test_healthz_all_aggregates_caddy(monkeypatch):
    monkeypatch.setattr("shutil.disk_usage", lambda _p: Disk(100, 50, 50))
    monkeypatch.setenv("HEALTHZ_CADDY_PORT", "1")  # 必然连不上
    r = client.get("/healthz?scope=all")
    assert r.status_code == 503
    body = r.json()
    assert body["checks"]["caddy"] == "error"
    assert body["checks"]["db"] == "ok"
    # 默认报告口径的附加信息仍在，scope 只加不减
    assert "budget" in body and "http" in body


def test_healthz_default_keeps_200_even_degraded(monkeypatch):
    """默认口径不能改状态码：uptime 用它读预算，200→503 会误报整站宕机。"""
    monkeypatch.setattr("shutil.disk_usage", lambda _p: Disk(100, 95, 5))
    r = client.get("/healthz")
    assert r.status_code == 200
    assert r.json()["status"] == "degraded"


def test_healthz_bad_scope_uses_error_envelope():
    r = client.get("/healthz?scope=bogus")
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "invalid_request"
    assert r.json()["detail"]["errors"][0]["field"] == "scope"


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


# ---------- 保留期清理状态：只报告，不改判定 ----------


def test_healthz_reports_retention_state(tmp_path, monkeypatch):
    """清理状态要能在 /healthz 上被看到——这是"失败了有人知道"的唯一出口。"""
    path = tmp_path / "state.json"
    path.write_text(
        '{"last_success_at": "2026-11-06T03:40:00+08:00", "consecutive_failures": 0}',
        encoding="utf-8",
    )
    monkeypatch.setenv("RETENTION_STATE_PATH", str(path))
    monkeypatch.setattr("shutil.disk_usage", lambda _p: Disk(100, 50, 50))

    body = client.get("/healthz").json()
    assert body["retention"]["last_success_at"].startswith("2026-11-06")
    assert body["status"] == "ok"


def test_retention_failure_does_not_degrade_readiness(tmp_path, monkeypatch):
    """清理连续失败，站点依然是 ok / 200。

    这是刻意的设计保证：清理失败意味着数据没按期删，但站点完全可用。
    若让它触发 503，一次凌晨清理失败就会让部署脚本失败、看门狗回滚掉
    一个正常版本——代价远大于"数据多留几天"。
    """
    path = tmp_path / "state.json"
    path.write_text(
        '{"consecutive_failures": 3, "last_error": "RuntimeError: boom"}',
        encoding="utf-8",
    )
    monkeypatch.setenv("RETENTION_STATE_PATH", str(path))
    monkeypatch.setattr("shutil.disk_usage", lambda _p: Disk(100, 50, 50))

    body = client.get("/healthz").json()
    assert body["status"] == "ok", "清理失败把整站判成 degraded 了"
    assert body["retention"]["consecutive_failures"] == 3

    ready = client.get("/healthz?scope=ready")
    assert ready.status_code == 200, "清理失败导致 readiness 503，会让部署回滚"


def test_healthz_without_retention_state_has_no_field(tmp_path, monkeypatch):
    """从来没跑过清理时不显示该字段，避免给一个空壳让人误读。"""
    monkeypatch.setenv("RETENTION_STATE_PATH", str(tmp_path / "missing.json"))
    monkeypatch.setattr("shutil.disk_usage", lambda _p: Disk(100, 50, 50))

    body = client.get("/healthz").json()
    assert "retention" not in body
