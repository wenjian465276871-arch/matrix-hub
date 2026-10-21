"""配额与预算：访客限流（体验口径）+ 全站日预算（费用口径）。

两个口径刻意分开（决策 #17）：
- **访客配额**不统计 failed/timeout——系统失败不该让用户当天没法再用；
- **全站预算**统计所有实际消耗——失败调用的 token 也已经花掉了。

`retry_of` 是唯一的口子，所以规则必须焊死：同 IP、24h 内、原任务失败态、
且一个失败任务只能被重试一次。缺任何一条，它就变成"无限额度"。
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import store

CST = timezone(timedelta(hours=8))

PER_HOUR_DEFAULT = 2
PER_DAY_DEFAULT = 10
SITE_BUDGET_MICROS_DEFAULT = 3_000_000  # ¥3
# 单次生成的成本上限估算（实测峰值约 ¥0.025，留一倍余量）。
ESTIMATE_MICROS_DEFAULT = 30_000
RETRY_WINDOW = timedelta(hours=24)


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    try:
        return max(1, int(raw))
    except ValueError:
        return default


@dataclass(frozen=True)
class Limits:
    per_hour: int
    per_day: int
    site_budget_micros: int
    estimate_micros: int


def limits() -> Limits:
    return Limits(
        per_hour=_env_int("GENERATE_PER_HOUR", PER_HOUR_DEFAULT),
        per_day=_env_int("GENERATE_PER_DAY", PER_DAY_DEFAULT),
        site_budget_micros=_env_int("GENERATE_DAILY_BUDGET_MICROS", SITE_BUDGET_MICROS_DEFAULT),
        estimate_micros=_env_int("GENERATE_ESTIMATE_MICROS", ESTIMATE_MICROS_DEFAULT),
    )


@dataclass
class Decision:
    ok: bool
    code: str = ""
    message: str = ""
    retry_after: int = 0


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(moment: datetime) -> str:
    return moment.isoformat(timespec="seconds")


def _cst_day(moment: datetime) -> str:
    return moment.astimezone(CST).date().isoformat()


def check(
    client_ip: str,
    retry_of: str | None = None,
    now: datetime | None = None,
    unlimited: bool = False,
) -> Decision:
    """能不能再生成一次。不做扣减——扣减由 `create_job` 落库完成。

    `unlimited=True` 只跳过**每 IP 的时/日配额**（口令通道），
    全站日预算仍然生效：费用口径不能向任何人开口子。
    """
    moment = now or _now()
    lim = limits()

    usage = store.usage_summary(_cst_day(moment))
    if usage["cost_micros"] + lim.estimate_micros > lim.site_budget_micros:
        return Decision(
            False,
            "budget_exhausted",
            "今日全站生成预算已用尽，请明日再试",
            3600,
        )

    if retry_of:
        job = store.get_job(retry_of)
        if job is None:
            return Decision(False, "retry_not_found", "原任务不存在", 0)
        if job["client_ip"] != client_ip:
            return Decision(False, "retry_forbidden", "只能重试自己发起的任务", 0)
        if job["status"] not in ("failed", "timeout"):
            return Decision(False, "retry_not_failed", "只有失败或超时的任务可以免费重试", 0)
        if moment - datetime.fromisoformat(job["created_at"]) > RETRY_WINDOW:
            return Decision(False, "retry_expired", "超过 24 小时，不能免费重试", 0)
        if store.count_jobs_by_retry_of(retry_of) > 0:
            return Decision(False, "retry_used", "该任务已经重试过一次", 0)
        return Decision(True)

    if unlimited:
        return Decision(True)

    hour_start = _iso(moment - timedelta(hours=1))
    # 时间戳只有秒级精度：同一秒内创建的 job 会等于 now，严格 `<` 会把它们漏掉。
    # 统计窗口的右端取 now+1s，等价于"包含当前这一秒"。
    now_iso = _iso(moment + timedelta(seconds=1))
    used_hour = store.count_jobs_between(
        client_ip, hour_start, now_iso, exclude_failed=True
    )
    if used_hour >= lim.per_hour:
        oldest = store.oldest_job_between(client_ip, hour_start, now_iso)
        retry = 60
        if oldest:
            retry = max(
                1,
                int((datetime.fromisoformat(oldest) + timedelta(hours=1) - moment).total_seconds()),
            )
        return Decision(
            False,
            "hour_quota",
            f"每小时最多 {lim.per_hour} 次生成，请 {retry} 秒后再试",
            retry,
        )

    used_day = store.count_jobs_today(client_ip, _cst_day(moment), exclude_failed=True)
    if used_day >= lim.per_day:
        _, day_end = store.day_bounds_utc(_cst_day(moment))
        retry = max(1, int((datetime.fromisoformat(day_end) - moment).total_seconds()))
        return Decision(
            False,
            "day_quota",
            f"今日生成次数已用完（{lim.per_day} 次），请明日再试",
            retry,
        )

    return Decision(True)


def snapshot(client_ip: str, now: datetime | None = None) -> dict:
    """给前端展示的剩余额度。reset_in_s 为 0 表示当前没有占用。"""
    moment = now or _now()
    lim = limits()
    now_iso = _iso(moment + timedelta(seconds=1))
    hour_start = _iso(moment - timedelta(hours=1))
    day = _cst_day(moment)
    day_start, day_end = store.day_bounds_utc(day)

    used_hour = store.count_jobs_between(client_ip, hour_start, now_iso, exclude_failed=True)
    used_day = store.count_jobs_today(client_ip, day, exclude_failed=True)
    oldest_hour = store.oldest_job_between(client_ip, hour_start, now_iso)
    oldest_day = store.oldest_job_between(client_ip, day_start, day_end)

    usage = store.usage_summary(day)
    return {
        "hour": {
            "used": used_hour,
            "limit": lim.per_hour,
            "reset_in_s": (
                max(1, int((datetime.fromisoformat(oldest_hour) + timedelta(hours=1) - moment).total_seconds()))
                if oldest_hour
                else 0
            ),
        },
        "day": {
            "used": used_day,
            "limit": lim.per_day,
            "reset_in_s": (
                max(1, int((datetime.fromisoformat(day_end) - moment).total_seconds()))
                if oldest_day
                else 0
            ),
        },
        "site_budget": {
            "used_micros": usage["cost_micros"],
            "limit_micros": lim.site_budget_micros,
            "used_cny": round(usage["cost_micros"] / 1_000_000, 4),
            "limit_cny": round(lim.site_budget_micros / 1_000_000, 2),
        },
    }
