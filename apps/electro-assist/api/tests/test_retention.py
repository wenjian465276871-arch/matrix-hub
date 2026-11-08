"""保留期执行：启动清理与每日调度的行为，不依赖真实时钟。"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

import store
from services import library, retention


@pytest.fixture(autouse=True)
def _clean_scheduler(tmp_path, monkeypatch):
    # 状态文件必须隔离：默认路径在数据卷里，测试直接写会污染真实 app_data。
    monkeypatch.setenv("RETENTION_STATE_PATH", str(tmp_path / "retention_state.json"))
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


# ---------------------------------------------------------------- 清理状态与告警

def test_at_time_unparsable_falls_back(monkeypatch):
    """配成非时间格式也要退回默认值，不能让调度线程起不来。"""
    monkeypatch.setenv("RETENTION_AT", "凌晨三点")
    assert retention._at() == (3, 40)


def test_run_once_records_success():
    """成功执行后必须留下 last_success_at，这是"清理还在跑"的唯一凭据。"""
    result = retention.run_once(apply=True)
    assert result["applied"] in (True, False)

    state = retention.read_state()
    assert state["last_success_at"], "成功执行后没有记录 last_success_at"
    assert state["consecutive_failures"] == 0
    assert state["last_error"] == ""


def test_dry_run_does_not_claim_success():
    """dry-run 不能刷新 last_success_at——它没删任何东西，冒充成功会掩盖故障。"""
    retention.run_once(apply=False)
    assert retention.read_state() == {}


def test_failure_accumulates_and_keeps_error():
    """连续失败要累加并留下最后一次错误摘要。"""
    retention._record_failure(RuntimeError("database is locked"))
    first = retention.read_state()
    assert first["consecutive_failures"] == 1
    assert "RuntimeError" in first["last_error"]
    assert "database is locked" in first["last_error"]
    assert first["last_error_at"]

    retention._record_failure(OSError("磁盘满了"))
    second = retention.read_state()
    assert second["consecutive_failures"] == 2, "失败次数没有跨次累计"
    assert "OSError" in second["last_error"]


def test_success_clears_failure_counter():
    """成功一次要清零：否则"曾经失败过"会永远挂着，告警失去意义。"""
    retention._record_failure(RuntimeError("boom"))
    assert retention.read_state()["consecutive_failures"] == 1

    retention.run_once(apply=True)
    assert retention.read_state()["consecutive_failures"] == 0


def test_read_state_tolerates_missing_and_corrupt_file(tmp_path, monkeypatch):
    """状态文件缺失或损坏时返回空字典，不能抛异常——healthz 依赖它。"""
    path = tmp_path / "state.json"
    monkeypatch.setenv("RETENTION_STATE_PATH", str(path))
    assert retention.read_state() == {}

    path.write_text("{ 这不是 JSON", encoding="utf-8")
    assert retention.read_state() == {}


def test_write_state_survives_unwritable_path(tmp_path, monkeypatch):
    """状态写不进去只该记日志，不该把清理本身搞挂。

    这里**不能**用 `Z:/不存在/state.json` 这种写法：Windows 上 `Z:` 不存在会失败，
    但 Linux 上 `Z:不存在` 只是个合法目录名，能建成功——测试就成了"只在 Windows 成立"。
    改成把目录指到一个普通文件下面：`mkdir` 会 ENOTDIR，两个平台行为一致。
    """
    blocker = tmp_path / "blocker"
    blocker.write_text("我是文件，不是目录", encoding="utf-8")
    monkeypatch.setenv("RETENTION_STATE_PATH", str(blocker / "state.json"))

    retention._record_failure(RuntimeError("boom"))  # 不应抛异常
    assert retention.read_state() == {}


# ---------------------------------------------------------------- 失败重试

def test_retry_succeeds_on_first_attempt(monkeypatch):
    """正常情况只跑一次，不做多余重试。"""
    monkeypatch.setenv("RETENTION_RETRY_S", "0.01")
    calls: list[int] = []
    monkeypatch.setattr(retention, "run_once", lambda **_: calls.append(1))

    assert retention.run_with_retry() == 0
    assert len(calls) == 1


def test_retry_gives_up_after_attempts_and_records_count(monkeypatch):
    """连续失败要跑满 RETRY_ATTEMPTS 次，并把累计次数留在状态里。"""
    monkeypatch.setenv("RETENTION_RETRY_S", "0.01")
    calls: list[int] = []

    def boom(**_):
        calls.append(1)
        raise RuntimeError("database is locked")

    monkeypatch.setattr(retention, "run_once", boom)

    assert retention.run_with_retry() == retention.RETRY_ATTEMPTS
    assert len(calls) == retention.RETRY_ATTEMPTS, "没有跑满重试次数"
    state = retention.read_state()
    assert state["consecutive_failures"] == retention.RETRY_ATTEMPTS
    assert "database is locked" in state["last_error"]


def test_retry_recovers_on_second_attempt(monkeypatch):
    """第二次成功就不再重试，且连续失败计数清零——偶发失败不该长期挂着。"""
    monkeypatch.setenv("RETENTION_RETRY_S", "0.01")
    attempts: list[int] = []

    def flaky(**_):
        attempts.append(1)
        if len(attempts) == 1:
            raise RuntimeError("偶发锁冲突")
        return {"applied": False, "candidates": {}, "deleted": {}}

    monkeypatch.setattr(retention, "run_once", flaky)

    assert retention.run_with_retry() == 0
    assert len(attempts) == 2, "第二次成功后不该继续重试"
    # 状态清零由 test_success_clears_failure_counter 验（那里 run_once 是真的），
    # 这里 run_once 被 mock，不负责写状态。


def test_retry_stops_early_when_shutdown_requested(monkeypatch):
    """停止信号到来时不要继续重试——否则容器退出会被拖住。"""
    monkeypatch.setenv("RETENTION_RETRY_S", "0.01")

    def boom(**_):
        raise RuntimeError("boom")

    monkeypatch.setattr(retention, "run_once", boom)
    monkeypatch.setattr(retention._stop, "wait", lambda _t: True)  # 立刻表示"要停了"

    assert retention.run_with_retry() == 1, "收到停止信号后还继续重试了"




def test_startup_run_does_not_claim_scheduled_time():
    """启动清理不能写 `last_scheduled_run_at`。

    容器每重建一次都会跑一次启动清理。如果它也写这个字段，healthz 上永远是
    "刚刚跑过"，而 03:40 那次到底执行没执行反而看不出来——这正是该字段存在的
    唯一理由。所以这里断言的是"**没有**这个东西"，写反了必须红。
    """
    retention.run_once(apply=True, trigger="startup")
    state = retention.read_state()

    assert state["last_trigger"] == "startup"
    assert state["last_success_at"], "成功执行后必须有 last_success_at"
    assert "last_scheduled_run_at" not in state, "启动清理冒充了定时执行"


def test_scheduled_run_records_its_own_timestamp():
    retention.run_once(apply=True, trigger="scheduled")
    state = retention.read_state()

    assert state["last_trigger"] == "scheduled"
    assert state["last_scheduled_run_at"] == state["last_success_at"]


def _age(path, days: int) -> None:
    """把文件 mtime 推到 N 天前，模拟"这么久没写过"。"""
    import os
    import time

    stamp = time.time() - days * 86400
    os.utime(path, (stamp, stamp))


def test_prune_logs_deletes_rotated_and_truncates_stale_active(tmp_path, monkeypatch):
    logs = tmp_path / "logs"
    logs.mkdir()
    monkeypatch.setenv("ACCESS_LOG_DIR", str(logs))
    old_rotated = logs / "access-2026-10-20T03-00-00.000.log"
    fresh_rotated = logs / "access-2026-11-07T03-00-00.000.log"
    active = logs / "access.log"
    for path, text in ((old_rotated, "超期"), (fresh_rotated, "未超期"), (active, "很久没写")):
        path.write_text(text, encoding="utf-8")
    _age(old_rotated, 20)
    _age(fresh_rotated, 2)
    # 15 天没有写入 ⇒ 文件里不可能有保留期内的记录，清空不丢有效数据
    _age(active, 15)

    result = retention.prune_logs()

    assert result == {"rotated": 1, "truncated": True}
    assert not old_rotated.exists(), "超过 14 天的滚动文件必须删"
    assert fresh_rotated.exists(), "保留期内的文件不能被误删"
    assert active.exists(), "当前文件不能 unlink（Caddy 持有 fd）"
    assert active.read_text(encoding="utf-8") == ""


def test_prune_logs_keeps_active_file_with_recent_writes(tmp_path, monkeypatch):
    logs = tmp_path / "logs"
    logs.mkdir()
    monkeypatch.setenv("ACCESS_LOG_DIR", str(logs))
    active = logs / "access.log"
    active.write_text("今天还有请求", encoding="utf-8")

    result = retention.prune_logs()

    assert result == {"rotated": 0, "truncated": False}
    assert active.read_text(encoding="utf-8") == "今天还有请求"


def test_prune_logs_without_log_dir_is_noop(tmp_path, monkeypatch):
    """没有日志目录时不能抛——测试库、开发机都没有这个目录。"""
    monkeypatch.setenv("ACCESS_LOG_DIR", str(tmp_path / "missing"))
    assert retention.prune_logs() == {"rotated": 0, "truncated": False}
