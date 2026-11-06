"""JobQueue 的边界分支测试。

为什么单独建这个文件：原来 `jobqueue.py` 的 80% 覆盖率全部来自 API 层测试的
**间接覆盖**——成功路径被走过，但边界分支一次都没走：

- 队列满时 `submit` 返回 False（调用方据此回 503）
- 重复 `start` 不新建线程（当前置守卫失灵会起两个 worker 抢同一队列）
- `handler` 抛异常后 worker 继续处理后续任务（**worker 线程死了不会报错**，
  只会让队列越积越满，最终所有生成请求 503——这类故障只能靠测试发现）
- `stop()` 在队列满时不能抛 `queue.Full`

这些分支的共同点：**错了不会在正常路径上暴露**。
"""
from __future__ import annotations

import threading
import time

from services.jobqueue import JobQueue


def wait_until(predicate, timeout: float = 2.0) -> bool:
    """轮询等待。不用固定 sleep：慢机器上会假失败，快机器上白等。"""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.005)
    return False


def test_submit_rejects_when_full_and_capacity_tracks_queue():
    """队列满要明确返回 False，不能阻塞也不能静默丢弃。"""
    q = JobQueue(maxsize=1)
    assert q.capacity_left() == 1

    assert q.submit("j1", "文本") is True
    assert q.pending() == 1
    assert q.capacity_left() == 0

    # 满了：返回 False，由路由层翻译成 503，而不是无限堆线程
    assert q.submit("j2", "文本") is False
    assert q.pending() == 1
    q.reset()
    assert q.pending() == 0


def test_capacity_left_never_goes_negative():
    """容量不能因为并发探测而算出负数。"""
    q = JobQueue(maxsize=2)
    assert q.capacity_left() == 2
    q.submit("j1", "a")
    q.submit("j2", "b")
    assert q.capacity_left() == 0
    assert q.capacity_left() == 0
    q.reset()


def test_handler_exception_does_not_kill_worker():
    """单个 job 抛异常，worker 必须继续处理后面的任务。

    这是最重要的一条：worker 线程静默死掉时，接口仍然返回 202，
    用户看到"已排队"，但队列永远不动。只能靠这条测试发现。
    """
    q = JobQueue(maxsize=4)
    seen: list[str] = []
    second_done = threading.Event()

    def handler(job_id: str, _text: str) -> None:
        seen.append(job_id)
        if job_id == "boom":
            raise RuntimeError("模拟生成过程中的未捕获异常")
        second_done.set()

    q.start(handler)
    q.submit("boom", "x")  # 先丢一个会炸的
    q.submit("ok", "y")  # 再丢一个正常的

    assert second_done.wait(2.0), "handler 抛异常后 worker 没有再处理队列"
    assert seen == ["boom", "ok"], "任务顺序被改变或第二个任务丢失"
    q.stop()


def test_start_is_idempotent():
    """重复 start 不该起第二个 worker（两个 worker 会抢同一队列）。"""
    q = JobQueue()
    q.start(lambda _i, _t: None)
    first = q._thread
    assert first is not None

    q.start(lambda _i, _t: None)
    assert q._thread is first, "重复 start 新建了线程"
    q.stop()


def test_stop_when_queue_full_does_not_raise():
    """`stop()` 里 put_nowait(None) 在队列满时会 Full，必须被吞掉。"""
    q = JobQueue(maxsize=1)
    assert q.submit("j1", "占满队列") is True

    q.stop()  # 不 start 过，队列满 → 走 queue.Full 分支
    assert q._stop.is_set(), "stop 没有设置停止标志"
    q.reset()


def test_stop_lets_worker_exit():
    """stop 之后 worker 线程要真的退出，否则进程无法优雅关闭。"""
    q = JobQueue()
    ran = threading.Event()
    q.start(lambda _i, _t: ran.set())
    q.submit("j1", "t")
    assert ran.wait(2.0), "worker 没有处理已入队的任务"

    q.stop()
    assert wait_until(lambda: not q._thread.is_alive()), "stop 后 worker 线程仍在运行"
