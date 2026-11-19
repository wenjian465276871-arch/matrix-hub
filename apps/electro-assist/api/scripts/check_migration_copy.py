#!/usr/bin/env python3
"""在生产库**副本**上预演一次迁移：源库只读，改的是拷贝，验的是数据。

## 为什么需要它

CI 跑的是空库：建表语句全过，不等于 `ALTER TABLE` 在线上那份库上也能过。
2026-11-19 的知识库扩容把 `guides` 之外的数据量翻了一个量级，而部署链里
唯一碰数据库的动作是"新容器启动时自动迁移"——**它失败时，旧容器已经被换掉了**。
健康检查只能看见"进程起没起"，看不见"迁移把表锁住了/把行弄丢了"。

所以把迁移提前到 `docker compose up` 之前：拿线上卷里那份库的**只读快照**，
在临时目录里跑到最新版本，验三件事——版本到位、行数不变、`integrity_check` 通过。

## 三条边界

1. **源库只用只读连接**：以 `mode=ro` 打开，再用 `sqlite3.Connection.backup()` 取快照
   （WAL 下也能拿到一致视图）；之后所有操作只碰临时文件。
   **卷必须读写挂载**——WAL 库的 `-shm` 需要写权限，只读挂载会 `unable to open database file`
   （2026-11-19 在服务器上实测）。脚本对主库不发任何写语句。
2. **失败必须非零退出**：部署脚本靠退出码决定"切不切"。任何异常都转成非零，
   不把"检查没跑成"当成"检查通过"。
3. **不猜业务语义**：只比行数与版本，不解释某张表"应该"有多少行。行数变化
   一律失败——迁移只该改结构，不该动数据。

## 用法

容器内（部署前，源卷只读挂到 /src）：

    python -m scripts.check_migration_copy --source /src/electro.db

本地（拿开发库或备份试跑）：

    python -m scripts.check_migration_copy --source app_data/electro.db --keep

退出码：0 通过；1 迁移失败/数据异常；2 输入问题（源不存在、不是 SQLite）。
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from store import db as store_db  # noqa: E402

# 这些表在迁移里会被**重建**（迁移 3 的 records_v3），行数必须逐表对上。
# 不写死表名清单：从 sqlite_master 现取，新增表自动纳入，避免"加了表忘了加检查"。
SKIP_TABLES = {"schema_migrations"}


def _open_ro(path: Path) -> sqlite3.Connection:
    """只读打开：路径里的特殊字符用 URI 转义，避免 `?` / `#` 把参数截断。"""
    uri = path.resolve().as_uri() + "?mode=ro"
    conn = sqlite3.connect(uri, uri=True, timeout=10)
    conn.row_factory = sqlite3.Row
    return conn


def _table_counts(conn: sqlite3.Connection) -> dict[str, int]:
    names = [
        row[0]
        for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        )
        if row[0] not in SKIP_TABLES and not row[0].startswith("sqlite_")
    ]
    return {name: int(conn.execute(f'SELECT COUNT(*) FROM "{name}"').fetchone()[0]) for name in names}


def _integrity(conn: sqlite3.Connection) -> str:
    return str(conn.execute("PRAGMA integrity_check").fetchone()[0])


def _copy(src: Path, dst: Path) -> None:
    """用 SQLite 自己的备份 API 取快照：WAL 下也一致，不依赖文件级 cp。"""
    with _open_ro(src) as source, sqlite3.connect(dst) as target:
        source.backup(target)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="在生产库副本上预演迁移")
    parser.add_argument("--source", required=True, help="源库路径（只读打开）")
    parser.add_argument("--keep", action="store_true", help="保留临时副本，便于失败后排查")
    parser.add_argument(
        "--allow-missing",
        action="store_true",
        help="源库不存在时按“首次部署”放行（默认失败，避免挂错卷却静默跳过）",
    )
    args = parser.parse_args(argv)

    source = Path(args.source).expanduser()
    if not source.exists():
        if args.allow_missing:
            print(f"[WARN] 源库不存在：{source}（按首次部署跳过）")
            return 0
        print(f"[FAIL] 源库不存在：{source}", file=sys.stderr)
        return 2
    if not source.is_file():
        print(f"[FAIL] 源路径不是文件：{source}", file=sys.stderr)
        return 2

    tmpdir = Path(tempfile.mkdtemp(prefix="migcheck-"))
    copy = tmpdir / "electro.db"
    try:
        _copy(source, copy)
    except sqlite3.DatabaseError as exc:
        print(f"[FAIL] 源库无法读取或不是 SQLite：{exc}", file=sys.stderr)
        return 2

    try:
        before_version = store_db.schema_version(copy)
        with sqlite3.connect(copy) as conn:
            before_counts = _table_counts(conn)
            before_integrity = _integrity(conn)

        applied = store_db.init_db(copy)
        after_version = store_db.schema_version(copy)
        with sqlite3.connect(copy) as conn:
            after_counts = _table_counts(conn)
            after_integrity = _integrity(conn)
    except Exception as exc:  # noqa: BLE001 - 迁移失败的原因必须原样带出去
        print(f"[FAIL] 迁移执行失败：{type(exc).__name__}: {exc}", file=sys.stderr)
        if args.keep:
            print(f"       副本保留在：{copy}", file=sys.stderr)
        return 1

    expected = max(version for version, _ in store_db.MIGRATIONS)
    problems: list[str] = []

    if after_version < expected:
        problems.append(f"版本未到顶：{after_version} < {expected}")
    if after_integrity != "ok":
        problems.append(f"迁移后 integrity_check={after_integrity!r}")

    for name, count in before_counts.items():
        if name not in after_counts:
            problems.append(f"表 {name} 在迁移后消失（迁移前 {count} 行）")
        elif after_counts[name] != count:
            problems.append(f"表 {name} 行数变化：{count} → {after_counts[name]}")

    new_tables = sorted(set(after_counts) - set(before_counts))
    print(f"源库：{source}（只读快照，未修改）")
    print(f"版本：{before_version} → {after_version}（目标 {expected}）")
    print(f"本次应用迁移：{applied or '无（已是最新）'}")
    print(f"完整性：{before_integrity} → {after_integrity}")
    print(f"业务表：{len(before_counts)} → {len(after_counts)}" + (f"，新增 {new_tables}" if new_tables else ""))
    for name in sorted(before_counts):
        after = after_counts.get(name, "缺失")
        mark = "=" if after == before_counts[name] else "!"
        print(f"  {mark} {name}: {before_counts[name]} → {after}")

    result = {
        "ok": not problems,
        "source": str(source),
        "version_before": before_version,
        "version_after": after_version,
        "expected": expected,
        "applied": applied,
        "problems": problems,
    }
    print("MIGRATION_CHECK " + json.dumps(result, ensure_ascii=False))

    if problems:
        for problem in problems:
            print(f"[FAIL] {problem}", file=sys.stderr)
        if args.keep:
            print(f"       副本保留在：{copy}", file=sys.stderr)
        return 1

    if args.keep:
        print(f"副本保留在：{copy}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
