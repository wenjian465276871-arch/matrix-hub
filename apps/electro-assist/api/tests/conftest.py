"""测试级隔离。

限流器是进程内单例：不重置的话，用例执行顺序会决定谁被 429，
表现为"单独跑绿、全量跑红"这类最难查的假故障。
"""
from __future__ import annotations

import pytest

import ratelimit


@pytest.fixture(autouse=True)
def _reset_rate_limiter():
    ratelimit.reset_limiter()
    yield
    ratelimit.reset_limiter()
