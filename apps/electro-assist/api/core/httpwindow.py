"""滚动窗口里的 5xx 统计。

只回答一个问题：**最近 10 分钟真实请求的 5xx 比例是多少**——部署后的看门狗
拿它决定要不要回滚（计划 §9.4 #11）。不引时序库：2C2G 上再养一套 Prometheus
不划算，而这里需要的精度只有"有没有明显变坏"，不是分位数。

三个刻意的口径：

1. **每分钟一个桶，不存逐条事件**。演示站的流量是每小时个位数，逐条存也不占
   内存，但桶让"过期"变成一次头删，不用在请求路径上做时间比较。
2. **只算真实请求**。`/healthz` 由部署脚本与外部探活每 10 分钟打一次、永远 200，
   算进去会把一次真实 502 稀释成 0.3%，看门狗就永远不响。
3. **窗口是左闭右开的一个近似**：桶边界把最老的数据放宽到 window + 60s，
   这是刻意的——宁可多看一分钟，也不要因为桶对齐漏掉故障刚开始的那一段。

进程重启后窗口清零，这是对的：看门狗关心的是"这一版部署之后的表现"。
"""
from __future__ import annotations

import threading
import time
from collections import deque


class HttpWindow:
    def __init__(self, window_s: int = 600, bucket_s: int = 60) -> None:
        if window_s <= 0 or bucket_s <= 0 or bucket_s > window_s:
            raise ValueError("window_s/bucket_s 取值不合法")
        self.window_s = window_s
        self.bucket_s = bucket_s
        self._buckets: deque[tuple[int, int, int]] = deque()  # (桶序号, 请求数, 5xx 数)
        self._lock = threading.Lock()

    def record(self, status: int, now: float | None = None) -> None:
        """记一次请求。4xx 算请求量、不算错误——参数写错不是服务坏了。"""
        moment = time.monotonic() if now is None else now
        index = int(moment // self.bucket_s)
        is_error = 1 if 500 <= status < 600 else 0
        with self._lock:
            self._prune(index)
            if self._buckets and self._buckets[-1][0] == index:
                _, total, errors = self._buckets[-1]
                self._buckets[-1] = (index, total + 1, errors + is_error)
            else:
                self._buckets.append((index, 1, is_error))

    def snapshot(self, now: float | None = None) -> dict:
        moment = time.monotonic() if now is None else now
        index = int(moment // self.bucket_s)
        with self._lock:
            self._prune(index)
            total = sum(bucket[1] for bucket in self._buckets)
            errors = sum(bucket[2] for bucket in self._buckets)
        return {
            "window_s": self.window_s,
            "requests": total,
            "errors_5xx": errors,
            # 4 位小数足够看门狗用（1% = 0.01）；同时给人看时不至于满屏零
            "ratio": round(errors / total, 4) if total else 0.0,
        }

    def _prune(self, current_index: int) -> None:
        # 保留 window 内的桶；边界那个桶可能刚过期一点点，多留一桶
        oldest = current_index - self.window_s // self.bucket_s
        while self._buckets and self._buckets[0][0] < oldest:
            self._buckets.popleft()

    def reset(self) -> None:
        """仅供测试。"""
        with self._lock:
            self._buckets.clear()
