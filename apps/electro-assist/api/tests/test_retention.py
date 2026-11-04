"""保留期执行：启动清理与每日调度的行为，不依赖真实时钟。"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

import store
from services import library, retention


@pytest.fixture(autouse=True)
def _clean_scheduler():
    retention.reset_for_tests()
    yield
    retention.reset_for_tests()


def test_run_once_deletes_expired_draft():
    guide = library.load_fixtures()[0]
    guide.id = "g_retention_probe_001"
    store.save_guide(guide, status="draft")

    # 把"现在"推到 31 天后：草稿的 30 天保留期已过，会话 180 天未到。
    future = datetime.now(timezone.utc) + timedelta(days=31)
    result = retention.run_once(now=future)

    assert result["applied"] is True
    assert result["candidates"]["drafts"] >= 1
    assert store.get_guide(guide.id) is None


def test_dry_run_reports_without_deleting():
    guide = library.load_fixtures()[0]
    guide.id = "g_retention_probe_002"
    store.save_guide(guide, status="draft")

    future = datetime.now(timezone.utc) + timedelta(days=31)
    result = retention.run_once(apply=False, now=future)

    assert result["applied"] is False
    assert result["deleted"] == {}
    assert store.get_guide(guide.id) is not None

    # 收尾：真的删掉，避免影响后续用例的列表断言
    retention.run_once(now=future)


@pytest.mark.parametrize(
    ("now", "expected"),
    [
        (datetime(2026, 1, 1, 3, 0, 0), 40 * 60),           # 当天 03:40
        (datetime(2026, 1, 1, 4, 0, 0), 23 * 3600 + 40 * 60),  # 次日 03:40
        (datetime(2026, 1, 1, 3, 40, 0), 24 * 3600),        # 恰好整点 → 次日
    ],
)
def test_seconds_until_next_run(now, expected):
    assert retention._seconds_until(3, 40, now) == expected


def test_disabled_outside_prod_by_default(monkeypatch):
    monkeypatch.delenv("APP_ENV", raising=False)
    monkeypatch.delenv("RETENTION_ENABLED", raising=False)
    monkeypatch.delenv("RETENTION_ON_START", raising=False)
    assert retention.start() is False


def test_at_time_bad_value_falls_back(monkeypatch):
    monkeypatch.setenv("RETENTION_AT", "25:99")
    assert retention._at() == (3, 40)
