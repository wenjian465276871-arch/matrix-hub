"""配额原子性：并发提交不能突破每 IP 的时/日上限。

这是"先查后写"的经典竞态：两个请求同时通过检查，各建一个 job。
单 worker 架构下用一把进程内锁串起来；这个用例是那把锁的回归保护。
"""
from __future__ import annotations

import threading
import uuid

import pytest

from services import generation
from services.jobqueue import job_queue


@pytest.fixture()
def no_queue(monkeypatch):
    """不真的入队：这里只验证"能不能建 job"，不验证 worker 执行。"""
    monkeypatch.setenv("GENERATE_PER_HOUR", "2")
    monkeypatch.setenv("GENERATE_PER_DAY", "10")
    monkeypatch.setattr(job_queue, "capacity_left", lambda: 10)
    monkeypatch.setattr(job_queue, "submit", lambda *_args, **_kwargs: True)


def test_concurrent_submits_cannot_exceed_hour_quota(no_queue):
    ip = f"race-{uuid.uuid4().hex[:8]}"
    ok: list[str] = []
    rejected: list[str] = []
    lock = threading.Lock()

    def worker(index: int) -> None:
        try:
            job_id = generation.submit(
                f"第 {index} 次并发提交：确认断电挂牌后再开始检查主回路接线", ip
            )
            with lock:
                ok.append(job_id)
        except generation.GenerateRejected as exc:
            with lock:
                rejected.append(exc.code)

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert len(ok) == 2, f"每小时上限 2，实际建了 {len(ok)} 个"
    assert rejected.count("hour_quota") == 2
