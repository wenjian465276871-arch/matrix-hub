"""进程内生成队列：单 worker、有界、FIFO。

为什么不用 FastAPI 的 BackgroundTasks：
- BackgroundTasks 跟着请求走，且没有并发上限。两个请求同时进来就是两次
  模型调用 + 两次解码，2C2G 的机器会直接抖起来；
- 队列满时要能明确回 503，而不是无限堆线程等信号量。

为什么不用 Redis/Celery：单容器、单 worker、日预算 ¥3。引入 broker 的运维成本
远大于它解决的问题。将来多实例时必须替换——注释写在这里，免得后人踩。
"""
from __future__ import annotations

import logging
import queue
import threading

log = logging.getLogger("electro.jobs")

DEFAULT_MAXSIZE = 5


class JobQueue:
    def __init__(self, maxsize: int = DEFAULT_MAXSIZE) -> None:
        self.maxsize = maxsize
        self._q: queue.Queue = queue.Queue(maxsize=maxsize)
        self._handler = None
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._lock = threading.Lock()

    # ------------------------------------------------------------------ 生命周期

    def start(self, handler) -> None:
        """handler(job_id, text) 在 worker 线程里执行。重复调用无副作用。"""
        with self._lock:
            self._handler = handler
            if self._thread is not None and self._thread.is_alive():
                return
            self._stop.clear()
            self._thread = threading.Thread(
                target=self._loop, name="electro-job-worker", daemon=True
            )
            self._thread.start()
            log.info("job worker 已启动（队列上限 %d）", self.maxsize)

    def stop(self) -> None:
        self._stop.set()
        try:
            self._q.put_nowait(None)
        except queue.Full:  # worker 会在下一轮看到 stop 标志
            pass

    # ------------------------------------------------------------------ 入队

    def capacity_left(self) -> int:
        return max(0, self.maxsize - self._q.qsize())

    def pending(self) -> int:
        return self._q.qsize()

    def submit(self, job_id: str, text: str) -> bool:
        try:
            self._q.put_nowait((job_id, text))
            return True
        except queue.Full:
            return False

    def reset(self) -> None:
        """仅供测试：清空未消费的任务，避免用例之间互相占额度。"""
        while True:
            try:
                self._q.get_nowait()
                self._q.task_done()
            except queue.Empty:
                return

    # ------------------------------------------------------------------ 内部

    def _loop(self) -> None:
        while not self._stop.is_set():
            item = self._q.get()
            if item is None:
                self._q.task_done()
                break
            job_id, text = item
            try:
                if self._handler is not None:
                    self._handler(job_id, text)
            except Exception:  # noqa: BLE001 - worker 线程不能因为单个 job 死掉
                log.exception("job worker 未捕获异常：%s", job_id)
            finally:
                self._q.task_done()


job_queue = JobQueue()
