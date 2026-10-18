"""计费模型测试。

重点不是算得对（乘法），而是**分档与缓存命中不混淆**：
把缓存 token 按未命中价计费，成本会高 20 倍，日预算会提前熔断；
反过来按命中价算全部输入，预算就形同虚设。
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from llm.base import Usage
from llm.pricing import CST, cost_micros, is_peak

PEAK = datetime(2026, 10, 19, 10, 0, tzinfo=CST)      # 周一上午
IDLE_EVENING = datetime(2026, 10, 19, 20, 0, tzinfo=CST)
IDLE_LUNCH = datetime(2026, 10, 19, 12, 30, tzinfo=CST)
WEEKEND = datetime(2026, 10, 18, 10, 0, tzinfo=CST)   # 周日


def test_peak_windows():
    assert is_peak(PEAK) is True
    assert is_peak(IDLE_EVENING) is False
    assert is_peak(IDLE_LUNCH) is False
    assert is_peak(WEEKEND) is False


def test_utc_input_is_converted_to_cst():
    # UTC 02:00 == 北京 10:00，属高峰
    utc = datetime(2026, 10, 19, 2, 0, tzinfo=timezone.utc)
    assert is_peak(utc) is True


def test_micros_equals_tokens_times_price():
    usage = Usage(prompt_tokens=1_000_000, completion_tokens=0)
    assert cost_micros(usage, PEAK) == 2_000_000    # ¥2 / 百万 token
    assert cost_micros(usage, IDLE_EVENING) == 1_000_000


def test_cached_tokens_use_cache_price():
    usage = Usage(prompt_tokens=1_000_000, completion_tokens=0, cached_tokens=1_000_000)
    assert cost_micros(usage, PEAK) == 300_000
    assert cost_micros(usage, IDLE_EVENING) == 40_000


def test_mixed_cache_and_miss():
    usage = Usage(prompt_tokens=1_000_000, completion_tokens=0, cached_tokens=400_000)
    # 600k × 2 + 400k × 0.3 = 1_200_000 + 120_000
    assert cost_micros(usage, PEAK) == 1_320_000


def test_reasoning_counts_as_output():
    usage = Usage(prompt_tokens=0, completion_tokens=1_000_000, reasoning_tokens=800_000)
    assert cost_micros(usage, IDLE_EVENING) == 4_000_000


def test_zero_usage_costs_zero():
    assert cost_micros(Usage(), PEAK) == 0


@pytest.mark.parametrize("hours", [9, 11, 14, 17])
def test_peak_hours(hours: int):
    assert is_peak(datetime(2026, 10, 19, hours, 0, tzinfo=CST)) is True


@pytest.mark.parametrize("hours", [8, 12, 13, 18, 23])
def test_idle_hours(hours: int):
    assert is_peak(datetime(2026, 10, 19, hours, 0, tzinfo=CST)) is False


def test_boundary_minute_is_idle():
    eleven_fifty_nine = datetime(2026, 10, 19, 11, 59, tzinfo=CST) + timedelta(minutes=1)
    assert is_peak(eleven_fifty_nine) is False
