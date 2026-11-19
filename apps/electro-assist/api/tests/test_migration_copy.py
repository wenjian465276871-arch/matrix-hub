"""迁移预演脚本的回归：旧库副本能升到最新，且源库一个字节都不动。

为什么值得单独测：
- 这个脚本会在**部署前**跑，它误判"通过"= 放一个坏迁移上线；误判"失败"= 挡住正常发布。
- 两类误判都不是单测能靠 mock 证明的——必须真的造一份旧库、真的跑一遍 `init_db`。
"""
from __future__ import annotations

import hashlib
import os
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest

import store.db as store_db
from scripts import check_migration_copy

API_DIR = Path(__file__).resolve().parent.parent
OLD_VERSION = 3


def _make_old_db(path: Path) -> None:
    """造一份 v3 的库 + 每张业务表都有数据。"""
    original = store_db.MIGRATIONS
    store_db.MIGRATIONS = original[:OLD_VERSION]
    try:
        store_db.init_db(path)
    finally:
        store_db.MIGRATIONS = original

    with sqlite3.connect(path) as conn:
        for i in (1, 2):
            conn.execute(
                "INSERT INTO guides (id, schema_version, title, system, status, json,"
                " step_count, duration_s, created_at, updated_at)"
                " VALUES (?, '1.2', ?, 'door', 'published', '{}', 3, 60, '2026-11-01', '2026-11-01')",
                (f"g{i}", f"样例 {i}"),
            )
        conn.execute(
            "INSERT INTO jobs (id, kind, status, client_ip, input_sha256, input_chars, created_at)"
            " VALUES ('j1', 'generate', 'succeeded', '127.0.0.1', 'x', 10, '2026-11-01')"
        )
        conn.execute(
            "INSERT INTO sessions (id, guide_id, status, current_seq, created_at, updated_at)"
            " VALUES ('s1', 'g1', 'active', 2, '2026-11-01', '2026-11-01')"
        )
        for attempt in (1, 2):
            conn.execute(
                "INSERT INTO records (id, session_id, step_id, seq, attempt, verdict,"
                " payload_json, idempotency_key, created_at)"
                " VALUES (?, 's1', 'st1', 1, ?, 'fail', '{}', ?, '2026-11-01')",
                (f"r{attempt}", attempt, f"key-{attempt}"),
            )
        conn.execute(
            "INSERT INTO usage (day, model, created_at) VALUES ('2026-11-01', 'deepseek-flash', '2026-11-01')"
        )


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _run(source: Path, *extra: str) -> subprocess.CompletedProcess[str]:
    env = {
        **os.environ,
        "PYTHONPATH": str(API_DIR),
        # 子进程默认按 Windows 本地代码页输出，中文会被父进程按 UTF-8 解码失败。
        "PYTHONIOENCODING": "utf-8",
    }
    return subprocess.run(
        [sys.executable, "-m", "scripts.check_migration_copy", "--source", str(source), *extra],
        cwd=API_DIR,
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=60,
    )


def test_old_db_is_migrated_on_copy_and_source_untouched(tmp_path):
    db = tmp_path / "old.db"
    _make_old_db(db)
    before = _sha(db)

    result = _run(db)

    assert result.returncode == 0, result.stderr
    assert f"版本：{OLD_VERSION} → {max(v for v, _ in store_db.MIGRATIONS)}" in result.stdout
    assert "MIGRATION_CHECK " in result.stdout
    # 源库必须还是 v3，且字节级未变——这是"只读快照"的硬证据。
    assert store_db.schema_version(db) == OLD_VERSION
    assert _sha(db) == before
    # 行数逐表保持：样例 2 / 作业 1 / 记录 2。
    assert "  = guides: 2 → 2" in result.stdout
    assert "  = records: 2 → 2" in result.stdout


def test_missing_source_is_an_input_error(tmp_path):
    result = _run(tmp_path / "nope.db")
    assert result.returncode == 2
    assert "源库不存在" in result.stderr


def test_allow_missing_only_when_explicitly_requested(tmp_path):
    result = _run(tmp_path / "nope.db", "--allow-missing")
    assert result.returncode == 0
    assert "首次部署" in result.stdout


def test_corrupt_file_is_rejected(tmp_path):
    broken = tmp_path / "broken.db"
    broken.write_bytes(b"not a sqlite database" * 10)
    result = _run(broken)
    assert result.returncode == 2
    assert "不是 SQLite" in result.stderr


def test_row_loss_is_detected(tmp_path, monkeypatch, capsys):
    """迁移只该改结构。任何一张表掉行，都必须判失败——这是脚本存在的理由。"""
    db = tmp_path / "old.db"
    _make_old_db(db)
    real_init = store_db.init_db

    def lossy_init(path=None):
        applied = real_init(path)
        with sqlite3.connect(path) as conn:
            conn.execute("DELETE FROM guides WHERE id = 'g1'")
        return applied

    monkeypatch.setattr(store_db, "init_db", lossy_init)
    code = check_migration_copy.main(["--source", str(db)])
    captured = capsys.readouterr()

    assert code == 1
    assert "行数变化" in captured.err
