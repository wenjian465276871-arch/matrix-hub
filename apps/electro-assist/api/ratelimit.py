"""进程内滑动窗口限流。

适用前提（重要）：**单容器 + 单 uvicorn worker**（见 `docker/supervisord.conf`）。
进程重启即清零，这是可接受的——限流的作用是抬高滥用成本，不是精确计费；
精确计量在 SQLite `usage` 表（P1a-W2 落地）。

一旦改成多 worker / 多实例，本模块必须替换（各进程各记一份，等于额度翻倍）。
届时的最小改法是换成 Redis 或直接在 Caddy 层做，不要在应用层加锁硬撑。

为什么按 IP 限上传而不只限生成：上传是唯一无需任何参数就能触发磁盘写入与
CPU 解码（最大 40MP）的端点。只限生成等于把最便宜的攻击面留空。
"""
from __future__ import annotations

import os
import threading
import time
from collections import deque

HOUR = 3600
DAY = 86400

# 单 IP 每小时 6 次 = 两次生成所需的最多 3 张图；每日 20 次留出正常调试余量。
DEFAULT_PER_HOUR = 6
DEFAULT_PER_DAY = 20
# 全站每日上限：防止换 IP 绕过。按 40G 磁盘与 5MB/张估算，200 张/日约 1G，可控。
DEFAULT_SITE_PER_DAY = 200


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    try:
        return max(1, int(raw))
    except ValueError:
        return default


def client_ip(request) -> str:
    """取真实客户端 IP。

    只信任**最右**一段 X-Forwarded-For：本项目的唯一入口是容器内 Caddy，
    它会把真实对端追加到链尾。客户端自带的伪造值只会出现在左侧。
    注意：这个结论依赖「Caddy 是唯一入口」——若将来 CDN 前置，需重新确认。
    """
    xff = request.headers.get("x-forwarded-for")
    if xff:
        parts = [p.strip() for p in xff.split(",") if p.strip()]
        if parts:
            return parts[-1]
    return request.client.host if request.client else "unknown"


class Limiter:
    """二维（时/日）+ 全站日上限的滑窗计数器。"""

    def __init__(self, per_hour: int, per_day: int, site_per_day: int) -> None:
        self.per_hour = per_hour
        self.per_day = per_day
        self.site_per_day = site_per_day
        self._hits: dict[str, deque[float]] = {}
        self._site: deque[float] = deque()
        self._lock = threading.Lock()

    @classmethod
    def from_env(cls) -> "Limiter":
        return cls(
            per_hour=_env_int("UPLOAD_RATE_PER_HOUR", DEFAULT_PER_HOUR),
            per_day=_env_int("UPLOAD_RATE_PER_DAY", DEFAULT_PER_DAY),
            site_per_day=_env_int("UPLOAD_SITE_PER_DAY", DEFAULT_SITE_PER_DAY),
        )

    def hit(self, key: str) -> tuple[bool, int]:
        """尝试记一次。返回 (是否放行, Retry-After 秒)。被拒时不计数。"""
        now = time.monotonic()
        with self._lock:
            events = self._hits.get(key)
            if events is None:
                events = deque()
                self._hits[key] = events

            while events and now - events[0] >= DAY:
                events.popleft()
            while self._site and now - self._site[0] >= DAY:
                self._site.popleft()

            allowed, retry = self._decide(events, now)
            if allowed:
                events.append(now)
                self._site.append(now)
                self._maybe_sweep(now)
            return allowed, retry

    def _decide(self, events: deque[float], now: float) -> tuple[bool, int]:
        in_hour = [t for t in events if now - t < HOUR]
        if len(in_hour) >= self.per_hour:
            return False, max(1, int(in_hour[0] + HOUR - now) + 1)
        if len(events) >= self.per_day:
            return False, max(1, int(events[0] + DAY - now) + 1)
        if len(self._site) >= self.site_per_day:
            return False, max(1, int(self._site[0] + DAY - now) + 1)
        return True, 0

    def _maybe_sweep(self, now: float) -> None:
        """键数量异常增长时清掉空桶，避免长期运行的字典泄漏。"""
        if len(self._hits) <= 1024:
            return
        dead = [k for k, v in self._hits.items() if not v or now - v[-1] >= DAY]
        for k in dead:
            self._hits.pop(k, None)

    def reset(self) -> None:
        """仅供测试与本地调试使用。"""
        with self._lock:
            self._hits.clear()
            self._site.clear()


_limiter: Limiter | None = None


def get_limiter() -> Limiter:
    global _limiter
    if _limiter is None:
        _limiter = Limiter.from_env()
    return _limiter


def reset_limiter() -> None:
    global _limiter
    _limiter = None
