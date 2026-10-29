"""测试级隔离。

限流器是进程内单例：不重置的话，用例执行顺序会决定谁被 429，
表现为"单独跑绿、全量跑红"这类最难查的假故障。

数据库同理：绝不能让测试写到仓库里的 `app_data/electro.db`——
那会把开发数据和生产表结构混在一起，出问题时分不清是谁写坏的。
"""
from __future__ import annotations

import os

import pytest

from core import ratelimit
import store


@pytest.fixture(autouse=True)
def _reset_rate_limiter():
    from routers import diagnose as diagnose_router

    ratelimit.reset_limiter()
    diagnose_router.reset_limiter()
    yield
    ratelimit.reset_limiter()
    diagnose_router.reset_limiter()


@pytest.fixture(scope="session", autouse=True)
def _isolated_db(tmp_path_factory):
    path = tmp_path_factory.mktemp("db") / "electro.db"
    previous = os.environ.get("DB_PATH")
    os.environ["DB_PATH"] = str(path)
    store.init_db()
    yield
    if previous is None:
        os.environ.pop("DB_PATH", None)
    else:
        os.environ["DB_PATH"] = previous
