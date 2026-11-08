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

**启动那次不能冒充定时那次**（2026-11-08 修）：`last_success_at` 原来被启动清理覆盖，
容器每重建一次就刷新，于是"每日 03:40 到底跑没跑"在 healthz 上永远看不出来——这不是
功能缺陷，但没有证据就等于没验证。现在分开记：`last_trigger` 标明这次是谁触发的，
`last_scheduled_run_at` **只由定时那次写**。
"""
from __future__ import annotations

import json
import logging
import os
import threading
from datetime import datetime, timedelta
from pathlib import Path

log = logging.getLogger("electro.retention")

DEFAULT_AT = "03:40"
START_DELAY_S = 3.0
# 访问日志保留天数（计划 §11.3.3，与 Caddyfile 的 roll_keep_for 336h 同一口径）。
LOG_RETENTION_DAYS = 14
# 失败不再硬等 24 小时：临时性原因（锁冲突、磁盘瞬时满）等一天就是白等一天。
RETRY_ATTEMPTS = 3
DEFAULT_RETRY_S = 1800.0

_stop = threading.Event()
_thread: threading.Thread | None = None
_run_lock = threading.Lock()


def _now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _state_path() -> Path:
    """清理状态文件。默认放在数据库同目录，跟着数据卷走。"""
    raw = (os.getenv("RETENTION_STATE_PATH") or "").strip()
    if raw:
        return Path(raw)
    from store import db as _store_db

    return Path(_store_db.db_path()).parent / "retention_state.json"


def read_state() -> dict:
    """读最近一次清理状态。

    文件不存在、内容损坏、权限不足都返回 `{}`——`/healthz` 不能因为
    读不到一个状态文件就变成不健康。
    """
    try:
        return json.loads(_state_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _write_state(**fields) -> None:
    """原子写状态。写入失败只记日志——记不下状态不该让清理本身失败。"""
    path = _state_path()
    try:
        current = read_state()
        current.update(fields)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(current, ensure_ascii=False), encoding="utf-8")
        # 原子替换：healthz 可能正在读，不能让它读到半个 JSON
        tmp.replace(path)
    except OSError as exc:
        log.warning("保留期状态写入失败：%s", exc)


def _log_dir() -> Path:
    """访问日志目录。默认跟着数据卷走，测试可用 `ACCESS_LOG_DIR` 注入。"""
    raw = (os.getenv("ACCESS_LOG_DIR") or "").strip()
    if raw:
        return Path(raw)
    from store import db as _store_db

    return Path(_store_db.db_path()).parent / "logs"


def prune_logs(days: int = LOG_RETENTION_DAYS, now: datetime | None = None) -> dict:
    """按保留期处理访问日志，返回 `{"rotated": n, "truncated": bool}`。

    为什么不能只靠 Caddy 的 `roll_keep_for`：它是**滚动时**才删，而滚动由 `roll_size`
    触发。零流量（或极低流量）站点永远达不到阈值，于是"保留 14 天"在那种站点上等于
    不存在——日志会一直留着，里面的 IP 与路径也一直留着。

    两种文件分开处理：

    - 已滚动出来的 `access-*.log`：mtime 超过 `days` 直接删；
    - 当前的 `access.log`：**只有 mtime 也超过 `days`**（证明这段时间一次写入都没有）
      才清空。这条判断是安全的：文件里不可能存在比 mtime 更新的记录，所以清空不会
      丢掉"还在保留期内"的数据。反过来，只要有任何流量，mtime 就会刷新，绝不动它。
    """
    directory = _log_dir()
    if not directory.is_dir():
        return {"rotated": 0, "truncated": False}

    moment = now or datetime.now()
    # 用本地时间的 timestamp 比较：mtime 是 epoch，跟时区无关，这里只求"多久以前"。
    cutoff = moment.timestamp() - days * 86400
    rotated = 0
    truncated = False

    for path in sorted(directory.glob("access-*.log")):
        try:
            if path.stat().st_mtime < cutoff:
                path.unlink()
                rotated += 1
        except OSError as exc:  # 单个文件删不掉不该让整轮清理失败
            log.warning("访问日志删除失败 %s：%s", path, exc)

    active = directory / "access.log"
    try:
        if active.is_file() and active.stat().st_mtime < cutoff:
            # 用 'w' 截断而不是 unlink：Caddy 持有这个文件的 fd，删掉会让后续写入
            # 落到已 unlink 的 inode 上，日志静默消失。
            active.write_text("", encoding="utf-8")
            truncated = True
    except OSError as exc:
        log.warning("访问日志清空失败 %s：%s", active, exc)

    if rotated or truncated:
        log.warning(
            "访问日志保留期执行：删除 %d 个滚动文件，清空当前文件=%s（>%d 天）",
            rotated,
            truncated,
            days,
        )
    return {"rotated": rotated, "truncated": truncated}


def _retry_delay() -> float:
    raw = os.getenv("RETENTION_RETRY_S")
    if raw is None or not raw.strip():
        return DEFAULT_RETRY_S
    try:
        return max(1.0, float(raw))
    except ValueError:
        log.warning("RETENTION_RETRY_S=%r 无法解析，退回 %s", raw, DEFAULT_RETRY_S)
        return DEFAULT_RETRY_S


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


def _success_state(trigger: str) -> dict:
    """成功执行的落账字段。

    `last_scheduled_run_at` 只在定时那次写：启动清理每重建一次容器就跑一次，
    如果它也写这个字段，平台上就无法回答"03:40 那次到底跑没跑"。
    """
    stamp = _now_iso()
    state = {
        "last_success_at": stamp,
        "last_trigger": trigger,
        "consecutive_failures": 0,
        "last_error": "",
    }
    if trigger == "scheduled":
        state["last_scheduled_run_at"] = stamp
    return state


def run_once(
    *,
    apply: bool = True,
    now: datetime | None = None,
    trigger: str = "manual",
) -> dict:
    """执行一轮清理。`apply=False` 只统计，给测试与人工核对用。

    `trigger` 只影响状态记录（`startup` / `scheduled` / `manual`），不影响删什么。

    返回结构固定，调用方（启动日志 / 测试）不需要理解 `Report` 的内部字段。
    """
    # 延迟导入：`scripts.cleanup` 在导入时会调整 sys.path，放在模块顶层
    # 会让服务层的导入顺序依赖脚本目录结构。
    from scripts import cleanup

    with _run_lock:
        report = cleanup.plan(now=now)
        # 访问日志与数据库是两套保留期，不能因为"库里没东西可删"就跳过日志。
        logs = prune_logs() if apply else {"rotated": 0, "truncated": False}
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
            if apply:
                # 没有过期数据也是一次**成功执行**：`last_success_at` 必须刷新，
                # 否则"长期没有可删数据"会被 healthz 误读成"清理一直没跑"。
                _write_state(**_success_state(trigger))
            return {
                "applied": False,
                "candidates": candidates,
                "deleted": {},
                "logs": logs,
            }

        deleted = cleanup.apply(report)
        log.warning("保留期清理已执行：候选=%s 实删=%s", candidates, deleted)
        _write_state(**_success_state(trigger))
        return {"applied": True, "candidates": candidates, "deleted": deleted, "logs": logs}


def _record_failure(exc: BaseException) -> int:
    """记一次失败并返回累计连续失败次数。失败次数跨天累计。"""
    failures = int(read_state().get("consecutive_failures") or 0) + 1
    _write_state(
        last_error_at=_now_iso(),
        last_error=f"{type(exc).__name__}: {exc}"[:200],
        consecutive_failures=failures,
    )
    return failures


def run_with_retry() -> int:
    """跑一轮清理，失败按 `RETRY_ATTEMPTS` 重试。返回连续失败次数（0 = 成功）。

    为什么抽成独立函数：重试策略如果埋在调度线程里，就只能靠"起线程 + sleep +
    等状态"去测——那种测试又慢又容易 flaky，最后没人写。
    抽出来之后它是同步的、可断言的，`_loop` 只剩"等时间 + 调用"。
    """
    for attempt in range(1, RETRY_ATTEMPTS + 1):
        try:
            run_once(apply=True, trigger="scheduled")
            return 0
        except Exception as exc:  # noqa: BLE001 - 定时任务失败不能杀死进程
            failures = _record_failure(exc)
            if attempt >= RETRY_ATTEMPTS:
                log.exception(
                    "保留期清理连续失败 %d 次，本轮放弃，明日再试", failures
                )
                return failures
            delay = _retry_delay()
            log.exception(
                "保留期清理失败（第 %d/%d 次），%.0f 秒后重试",
                attempt,
                RETRY_ATTEMPTS,
                delay,
            )
            if _stop.wait(delay):
                return failures
    return 0


def _loop() -> None:
    hour, minute = _at()
    log.info("保留期每日清理已启用：%02d:%02d（本地时间）", hour, minute)
    while not _stop.is_set():
        wait = _seconds_until(hour, minute)
        if _stop.wait(wait):
            break
        run_with_retry()


def _run_startup() -> None:
    # 给 readiness 与首个请求让路：启动瞬间不该同时扫库与扫上传目录。
    if _stop.wait(START_DELAY_S):
        return
    try:
        result = run_once(apply=True, trigger="startup")
        if result["applied"]:
            log.warning("启动清理完成：%s", result["deleted"])
    except Exception as exc:  # noqa: BLE001 - 启动清理失败不该让容器起不来
        _record_failure(exc)
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
