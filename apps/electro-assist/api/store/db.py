"""SQLite 连接与迁移。

几个刻意的选择：

1. **不用 ORM**。五张表、没有任何需要懒加载的关系，ORM 换来的只是多一个依赖和
   一层看不见的 SQL。这里每一条语句都直白可读，出问题能直接对着 SQL 调。
2. **每次操作一个连接**。uvicorn 单 worker，但同步端点跑在线程池里，
   sqlite3 连接不能跨线程复用。连接开销在毫秒级，比连接池的复杂度便宜。
3. **WAL + busy_timeout**。读不阻塞写，偶发并发写等待 5s 而不是立刻报错。
4. **写事务用 BEGIN IMMEDIATE**。延迟事务在两个写者同时升级时会死锁成 SQLITE_BUSY，
   直接拿写锁可以把这个坑从"偶发"变成"不存在"。
5. **金额存整数（1e-6 元）**。REAL 累加会出现 0.1+0.2 那种误差，
   预算熔断是按"是否超限"做判断的，差一分钱就可能少拦一次或误拦一次。
"""
from __future__ import annotations

import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterator

# 中国无夏令时，固定 +08:00 比 zoneinfo 少一个"系统有没有 tzdata"的前提。
CST = timezone(timedelta(hours=8))

DEFAULT_DB_PATH = "app_data/electro.db"

# 迁移只增不改：已经在线上跑过的版本，语句一个字都不能动。
# 改 schema 必须追加新版本号，让老库也能平滑升上来。
MIGRATIONS: list[tuple[int, list[str]]] = [
    (
        1,
        [
            """
            CREATE TABLE guides (
              id             TEXT PRIMARY KEY,
              schema_version TEXT NOT NULL,
              title          TEXT NOT NULL,
              system         TEXT NOT NULL,
              status         TEXT NOT NULL CHECK (status IN ('draft', 'published')),
              json           TEXT NOT NULL,
              job_id         TEXT,
              step_count     INTEGER NOT NULL DEFAULT 0,
              duration_s     INTEGER NOT NULL DEFAULT 0,
              created_at     TEXT NOT NULL,
              updated_at     TEXT NOT NULL,
              published_at   TEXT
            )
            """,
            "CREATE INDEX idx_guides_status ON guides(status, updated_at DESC)",
            """
            CREATE TABLE jobs (
              id                TEXT PRIMARY KEY,
              kind              TEXT NOT NULL CHECK (kind IN ('generate', 'extract')),
              status            TEXT NOT NULL
                                CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'timeout')),
              client_ip         TEXT NOT NULL DEFAULT '',
              input_sha256      TEXT NOT NULL DEFAULT '',
              input_chars       INTEGER NOT NULL DEFAULT 0,
              guide_id          TEXT,
              retry_of          TEXT,
              error_code        TEXT,
              error_detail      TEXT,
              created_at        TEXT NOT NULL,
              started_at        TEXT,
              finished_at       TEXT,
              duration_ms       INTEGER,
              prompt_tokens     INTEGER NOT NULL DEFAULT 0,
              completion_tokens INTEGER NOT NULL DEFAULT 0,
              reasoning_tokens  INTEGER NOT NULL DEFAULT 0,
              cost_micros       INTEGER NOT NULL DEFAULT 0
            )
            """,
            # 配额按「IP + 当天」统计，没有这个索引每次生成都要全表扫。
            "CREATE INDEX idx_jobs_ip_created ON jobs(client_ip, created_at)",
            "CREATE INDEX idx_jobs_status ON jobs(status, created_at)",
            """
            CREATE TABLE usage (
              id                INTEGER PRIMARY KEY AUTOINCREMENT,
              day               TEXT NOT NULL,
              job_id            TEXT,
              model             TEXT NOT NULL,
              prompt_tokens     INTEGER NOT NULL DEFAULT 0,
              completion_tokens INTEGER NOT NULL DEFAULT 0,
              reasoning_tokens  INTEGER NOT NULL DEFAULT 0,
              cost_micros       INTEGER NOT NULL DEFAULT 0,
              created_at        TEXT NOT NULL
            )
            """,
            "CREATE INDEX idx_usage_day ON usage(day)",
            """
            CREATE TABLE sessions (
              id          TEXT PRIMARY KEY,
              guide_id    TEXT NOT NULL,
              status      TEXT NOT NULL CHECK (status IN ('active', 'done', 'aborted')),
              current_seq INTEGER NOT NULL DEFAULT 1,
              created_at  TEXT NOT NULL,
              updated_at  TEXT NOT NULL,
              finished_at TEXT
            )
            """,
            "CREATE INDEX idx_sessions_guide ON sessions(guide_id, created_at DESC)",
            """
            CREATE TABLE records (
              id              TEXT PRIMARY KEY,
              session_id      TEXT NOT NULL,
              step_id         TEXT NOT NULL,
              seq             INTEGER NOT NULL,
              verdict         TEXT NOT NULL
                              CHECK (verdict IN ('pass', 'warn', 'fail', 'manual', 'skipped')),
              payload_json    TEXT NOT NULL,
              idempotency_key TEXT NOT NULL UNIQUE,
              created_at      TEXT NOT NULL,
              -- 双保险：客户端换一个 Idempotency-Key 重投同一步，也不能产生第二条记录
              UNIQUE (session_id, step_id)
            )
            """,
            "CREATE INDEX idx_records_session ON records(session_id, seq)",
        ],
    ),
    (
        2,
        [
            # 列表页需要 summary/source_note/generated_at，但不该为了三个字段
            # 把整份 JSON 读出来解析——列表接口会被轮询与翻页反复调用。
            "ALTER TABLE guides ADD COLUMN summary TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE guides ADD COLUMN source_note TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE guides ADD COLUMN generated_at TEXT",
            # 计价审计：缓存命中价与未命中价差 20 倍以上，只存总 token 无法复核成本。
            "ALTER TABLE usage ADD COLUMN cached_tokens INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE usage ADD COLUMN price_version TEXT NOT NULL DEFAULT ''",
        ],
    ),
]


def db_path() -> Path:
    """运行时读取，便于测试注入。"""
    return Path(os.getenv("DB_PATH", DEFAULT_DB_PATH))


def now_iso() -> str:
    """统一用 UTC + 秒级精度。全库同一时区同一格式，字符串比较才等价于时间比较。"""
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def today_cst() -> str:
    return datetime.now(CST).date().isoformat()


def day_bounds_utc(day: str) -> tuple[str, str]:
    """把「北京时间某一天」转成 UTC 的起止，用于按天统计。"""
    start = datetime.fromisoformat(day).replace(tzinfo=CST)
    return start.astimezone(timezone.utc).isoformat(timespec="seconds"), (
        start + timedelta(days=1)
    ).astimezone(timezone.utc).isoformat(timespec="seconds")


@contextmanager
def connect(path: Path | str | None = None) -> Iterator[sqlite3.Connection]:
    target = Path(path) if path else db_path()
    target.parent.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(target, timeout=5.0, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    conn.execute("PRAGMA synchronous=NORMAL")
    try:
        yield conn
    finally:
        conn.close()


@contextmanager
def tx(conn: sqlite3.Connection) -> Iterator[sqlite3.Connection]:
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield conn
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise


def init_db(path: Path | str | None = None) -> list[int]:
    """建表并执行未应用的迁移，返回本次实际应用的版本号。

    幂等：重复调用不会重复执行。版本记录与建表语句在同一个事务里，
    中途失败不会留下「表建了但版本没记」的半截状态。
    """
    applied_now: list[int] = []
    with connect(path) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS schema_migrations (
              version    INTEGER PRIMARY KEY,
              applied_at TEXT NOT NULL
            )
            """
        )
        done = {row["version"] for row in conn.execute("SELECT version FROM schema_migrations")}

        for version, statements in MIGRATIONS:
            if version in done:
                continue
            with tx(conn):
                for statement in statements:
                    conn.execute(statement)
                conn.execute(
                    "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)",
                    (version, now_iso()),
                )
            applied_now.append(version)
    return applied_now


def schema_version(path: Path | str | None = None) -> int:
    with connect(path) as conn:
        row = conn.execute("SELECT MAX(version) AS v FROM schema_migrations").fetchone()
        return int(row["v"] or 0)


def ping(path: Path | str | None = None) -> None:
    """健康检查用：真正打开一次连接并读一次。

    只判"进程还在"没有意义——数据库打不开时，所有业务端点都是废的，
    但进程照样活着。
    """
    with connect(path) as conn:
        conn.execute("SELECT 1").fetchone()
