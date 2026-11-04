"""保留期执行：启动时一次 + 每日一次（计划 §11.3.3）。

为什么进程里还要跑一遍：此前只有服务器上的 cron。cron 没装、装错时间、容器换了
宿主而 crontab 没跟过去——任何一种情况都表现为"保留期写在文档里，数据一直不删"。
把执行点放进应用，至少保证**每次部署启动**都会校验一次；cron 留作冗余，不是唯一通道。

三条边界：

1. **删除逻辑复用 `scripts/cleanup`**，不复制一份。清理口径（草稿 30 天、会话 180 天、
   被引用的上传永不删）已经在那边有测试，抄一遍就等于制造第二份真相。
2. **默认只在 prod 开**。开发机与测试库上自动删数据是灾难；显式
   `RETENTION_ENABLED=1` 才在非 prod 生效。
3. **启动那次延后 3 秒、放到后台线程**。它可能扫上传目录，不该把 readiness 拖住；
   但也不能因为进程退出就不跑——daemon 线程在容器里会活到进程结束。

时间取 **03:40**，不是计划原文的 03:00：备份 cron 在 03:17，先备份后删是运维铁律
（`OPERATIONS.md` §14）。把清理放到备份之前，等于每天先毁掉恢复点再谈保留期。
"""
from __future__ import annotations

import logging
import os
import threading
from datetime import datetime, timedelta

log = logging.getLogger("electro.retention")

DEFAULT_AT = "03:40"
START_DELAY_S = 3.0

_stop = threading.Event()
_thread: threading.Thread | None = None
_run_lock = threading.Lock()


def _flag(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


def _prod_default() -> bool:
    return os.getenv("APP_ENV", "dev").strip().lower() == "prod"


def _at() -> tuple[int, int]:
    raw = (os.getenv("RETENTION_AT") or DEFAULT_AT).strip()
    try:
        hour, minute = raw.split(":", 1)
        value = (int(hour), int(minute))
    except (ValueError, TypeError):
        log.warning("RETENTION_AT=%r 无法解析，退回 %s", raw, DEFAULT_AT)
        return 3, 40
    if not (0 <= value[0] <= 23 and 0 <= value[1] <= 59):
        log.warning("RETENTION_AT=%r 越界，退回 %s", raw, DEFAULT_AT)
        return 3, 40
    return value


def _seconds_until(hour: int, minute: int, now: datetime | None = None) -> float:
    """距离下一个本地 HH:MM 的秒数。用本地时间是因为调度看的是墙上时钟。"""
    moment = now or datetime.now()
    target = moment.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if target <= moment:
        target += timedelta(days=1)
    return max(1.0, (target - moment).total_seconds())


def run_once(*, apply: bool = True, now: datetime | None = None) -> dict:
    """执行一轮清理。`apply=False` 只统计，给测试与人工核对用。

    返回结构固定，调用方（启动日志 / 测试）不需要理解 `Report` 的内部字段。
    """
    # 延迟导入：`scripts.cleanup` 在导入时会调整 sys.path，放在模块顶层
    # 会让服务层的导入顺序依赖脚本目录结构。
    from scripts import cleanup

    with _run_lock:
        report = cleanup.plan(now=now)
        candidates = {
            "sessions": len(report.sessions),
            "records": report.records,
            "diagnose_runs": len(report.diagnose_runs),
            "diagnose_steps": report.diagnose_steps,
            "jobs": len(report.jobs),
            "drafts": len(report.drafts),
            "usage": report.usage,
            "uploads": len(report.uploads),
        }
        if not apply or report.empty():
            if any(candidates.values()) and not apply:
                log.info("保留期清理 dry-run：%s", candidates)
            return {"applied": False, "candidates": candidates, "deleted": {}}

        deleted = cleanup.apply(report)
        log.warning("保留期清理已执行：候选=%s 实删=%s", candidates, deleted)
        return {"applied": True, "candidates": candidates, "deleted": deleted}


def _loop() -> None:
    hour, minute = _at()
    log.info("保留期每日清理已启用：%02d:%02d（本地时间）", hour, minute)
    while not _stop.is_set():
        wait = _seconds_until(hour, minute)
        if _stop.wait(wait):
            break
        try:
            run_once(apply=True)
        except Exception:  # noqa: BLE001 - 定时任务失败不能杀死进程
            log.exception("保留期每日清理失败，明日重试")


def _run_startup() -> None:
    # 给 readiness 与首个请求让路：启动瞬间不该同时扫库与扫上传目录。
    if _stop.wait(START_DELAY_S):
        return
    try:
        result = run_once(apply=True)
        if result["applied"]:
            log.warning("启动清理完成：%s", result["deleted"])
    except Exception:  # noqa: BLE001 - 启动清理失败不该让容器起不来
        log.exception("保留期启动清理失败")


def start() -> bool:
    """按环境变量拉起启动清理与每日调度。返回是否启用了每日调度。"""
    global _thread
    prod = _prod_default()
    if _thread is None and _flag("RETENTION_ENABLED", prod):
        _stop.clear()
        _thread = threading.Thread(target=_loop, name="retention-daily", daemon=True)
        _thread.start()
    if _flag("RETENTION_ON_START", prod):
        threading.Thread(target=_run_startup, name="retention-startup", daemon=True).start()
    return _thread is not None


def stop() -> None:
    """停止调度线程。容器退出与测试用；不等待正在跑的 SQL（最坏由进程回收）。"""
    global _thread
    _stop.set()
    if _thread is not None:
        _thread.join(timeout=2.0)
        _thread = None


def reset_for_tests() -> None:
    stop()
    _stop.clear()
