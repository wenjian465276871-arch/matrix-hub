#!/usr/bin/env python3
"""清理过期运行数据（默认 dry-run）。

为什么需要它：上传目录、会话、记录、任务、用量表只增不减。演示站无所谓，
但真实用户的数据会永久堆在 40G 磁盘上；记录里还有设备号、位置、备注，
没有保留期限本身就是隐私问题。

清理口径（对齐计划 §11.3.3 的保留期表，刻意保守）：
- **已发布指导书永不删除**（产品内容）；**访客草稿默认 30 天**——草稿里可能
  有访客粘的工艺文本，留着就是隐私负债，与"产品内容"不是一回事；
- 上传资产：按目录 mtime 计龄，默认 **30 天**；切图会刷新 mtime；
  **被任何指导书引用的资产永不删除**——否则已发布页面的图会在 30 天后变成裂图；
- 会话 + 其记录：按 `sessions.created_at` 计龄，默认 **180 天**；
- 逐步诊断（run + steps）：与作业记录同口径，默认 **180 天**（进行中的也按创建时间清，避免僵尸会话）；
- 已结束任务：默认 **90 天**（queued/running 不动）；
- 用量明细：默认 **90 天**（计划要求 90；当天预算只依赖当天，删旧行不影响熔断）。

用法（在 `apps/electro-assist/api` 下）：

    python -m scripts.cleanup                 # dry-run，只报告
    python -m scripts.cleanup --apply         # 真删
    python -m scripts.cleanup --apply --uploads-days 30 --drafts-days 30 --sessions-days 180

服务器容器内：

    docker exec matrix-hub python -m scripts.cleanup            # 先看
    docker exec matrix-hub python -m scripts.cleanup --apply    # 再删
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sqlite3
import sys
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

import store  # noqa: E402 - 必须在 sys.path 调整之后导入
from core.assets import ASSET_RE  # noqa: E402 - 与上传/生成/归位共用同一套格式


@dataclass
class Report:
    sessions: list[str] = field(default_factory=list)
    records: int = 0
    diagnose_runs: list[str] = field(default_factory=list)
    diagnose_steps: int = 0
    jobs: list[str] = field(default_factory=list)
    drafts: list[str] = field(default_factory=list)
    usage: int = 0
    usage_cutoff: str = ""
    uploads: list[tuple[str, int]] = field(default_factory=list)

    @property
    def upload_bytes(self) -> int:
        return sum(size for _, size in self.uploads)

    def empty(self) -> bool:
        return not (
            self.sessions
            or self.records
            or self.diagnose_runs
            or self.jobs
            or self.drafts
            or self.usage
            or self.uploads
        )


def _iso(moment: datetime) -> str:
    return moment.isoformat(timespec="seconds")


def _dir_size(path: str) -> int:
    total = 0
    for root, _dirs, files in os.walk(path):
        for name in files:
            try:
                total += os.path.getsize(os.path.join(root, name))
            except OSError:
                pass
    return total


def _referenced_assets(con: sqlite3.Connection) -> set[str]:
    """扫全部指导书，收集被引用的 asset_id。

    直接读 JSON 而不是建引用表：指导书是整份 JSON 落库的，没有第二处真相；
    加一张引用表就要在生成、归位、发布三处同步维护，漏一处就是"图被删了"。
    规模上限是"指导书数量"，演示站几十份，全表扫描的成本可以忽略。
    """
    referenced: set[str] = set()
    for row in con.execute("SELECT json FROM guides"):
        try:
            data = json.loads(row["json"])
        except (TypeError, ValueError):
            continue
        buckets = [data.get("assets") or []]
        buckets += [step.get("assets") or [] for step in data.get("steps") or []]
        for bucket in buckets:
            for item in bucket:
                asset_id = item.get("asset_id") if isinstance(item, dict) else None
                if isinstance(asset_id, str):
                    referenced.add(asset_id)
    return referenced


def plan(
    *,
    now: datetime | None = None,
    uploads_days: int = 30,
    sessions_days: int = 180,
    drafts_days: int = 30,
    jobs_days: int = 90,
    usage_days: int = 90,
    upload_dir: str | None = None,
) -> Report:
    moment = now or datetime.now(timezone.utc)
    report = Report()

    con = sqlite3.connect(store.db_path())
    con.row_factory = sqlite3.Row
    referenced: set[str] = set()
    try:
        sessions_cut = _iso(moment - timedelta(days=sessions_days))
        report.sessions = [
            row["id"]
            for row in con.execute(
                "SELECT id FROM sessions WHERE created_at < ? ORDER BY created_at",
                (sessions_cut,),
            )
        ]
        if report.sessions:
            placeholders = ",".join("?" for _ in report.sessions)
            report.records = con.execute(
                f"SELECT COUNT(*) FROM records WHERE session_id IN ({placeholders})",
                report.sessions,
            ).fetchone()[0]

        report.diagnose_runs = [
            row["id"]
            for row in con.execute(
                "SELECT id FROM diagnose_runs WHERE created_at < ? ORDER BY created_at",
                (sessions_cut,),
            )
        ]
        if report.diagnose_runs:
            placeholders = ",".join("?" for _ in report.diagnose_runs)
            report.diagnose_steps = con.execute(
                f"SELECT COUNT(*) FROM diagnose_steps WHERE run_id IN ({placeholders})",
                report.diagnose_runs,
            ).fetchone()[0]

        # 访客草稿按计划 §11.3.3 的 30 天清；已发布案例永不删（产品内容）。
        # 只看 created_at：没有编辑界面，草稿内容不会变，创建时间就是它的寿命起点。
        drafts_cut = _iso(moment - timedelta(days=drafts_days))
        report.drafts = [
            row["id"]
            for row in con.execute(
                "SELECT id FROM guides WHERE status = 'draft' AND created_at < ? "
                "ORDER BY created_at",
                (drafts_cut,),
            )
        ]

        jobs_cut = _iso(moment - timedelta(days=jobs_days))
        report.jobs = [
            row["id"]
            for row in con.execute(
                "SELECT id FROM jobs WHERE created_at < ? "
                "AND status IN ('succeeded', 'failed', 'timeout') ORDER BY created_at",
                (jobs_cut,),
            )
        ]

        usage_cut = _iso(moment - timedelta(days=usage_days))
        report.usage_cutoff = usage_cut
        report.usage = con.execute(
            "SELECT COUNT(*) FROM usage WHERE created_at < ?", (usage_cut,)
        ).fetchone()[0]

        # 连接关掉之前取引用集：上传目录的扫描在 finally 之后进行。
        referenced = _referenced_assets(con)
    finally:
        con.close()

    root = upload_dir or os.getenv("UPLOAD_DIR", "app_data/uploads")
    if os.path.isdir(root):
        cutoff = (moment - timedelta(days=uploads_days)).timestamp()
        for entry in os.scandir(root):
            if not entry.is_dir() or entry.is_symlink() or not ASSET_RE.match(entry.name):
                continue
            if entry.name in referenced:
                continue
            try:
                if os.path.getmtime(entry.path) >= cutoff:
                    continue
            except OSError:
                continue
            report.uploads.append((entry.name, _dir_size(entry.path)))

    return report


def _remove_uploads(report: Report, upload_dir: str) -> int:
    removed = 0
    root = os.path.realpath(upload_dir)
    for asset_id, _size in report.uploads:
        path = os.path.realpath(os.path.join(root, asset_id))
        # 双保险：只删 upload_dir 下、名字符合资产格式的真实目录。
        if os.path.dirname(path) != root or not ASSET_RE.match(os.path.basename(path)):
            continue
        if os.path.islink(path) or not os.path.isdir(path):
            continue
        shutil.rmtree(path)
        removed += 1
    return removed


def apply(report: Report, upload_dir: str | None = None) -> dict:
    root = upload_dir or os.getenv("UPLOAD_DIR", "app_data/uploads")
    deleted = {
        "sessions": 0,
        "records": 0,
        "diagnose_runs": 0,
        "diagnose_steps": 0,
        "jobs": 0,
        "drafts": 0,
        "usage": 0,
        "uploads": 0,
    }

    con = sqlite3.connect(store.db_path())
    try:
        with con:
            if report.sessions:
                placeholders = ",".join("?" for _ in report.sessions)
                deleted["records"] = con.execute(
                    f"DELETE FROM records WHERE session_id IN ({placeholders})",
                    report.sessions,
                ).rowcount
                deleted["sessions"] = con.execute(
                    f"DELETE FROM sessions WHERE id IN ({placeholders})",
                    report.sessions,
                ).rowcount
            if report.diagnose_runs:
                placeholders = ",".join("?" for _ in report.diagnose_runs)
                deleted["diagnose_steps"] = con.execute(
                    f"DELETE FROM diagnose_steps WHERE run_id IN ({placeholders})",
                    report.diagnose_runs,
                ).rowcount
                deleted["diagnose_runs"] = con.execute(
                    f"DELETE FROM diagnose_runs WHERE id IN ({placeholders})",
                    report.diagnose_runs,
                ).rowcount
            if report.drafts:
                placeholders = ",".join("?" for _ in report.drafts)
                # 再判一次 status：plan 与 apply 之间可能有人把它发布了
                deleted["drafts"] = con.execute(
                    f"DELETE FROM guides WHERE status = 'draft' AND id IN ({placeholders})",
                    report.drafts,
                ).rowcount
            if report.jobs:
                placeholders = ",".join("?" for _ in report.jobs)
                deleted["jobs"] = con.execute(
                    f"DELETE FROM jobs WHERE id IN ({placeholders})", report.jobs
                ).rowcount
            # 用量按时间删，不用 plan 里的行数（并发写入时行数会变）
            if report.usage and report.usage_cutoff:
                deleted["usage"] = con.execute(
                    "DELETE FROM usage WHERE created_at < ?",
                    (report.usage_cutoff,),
                ).rowcount
    finally:
        con.close()

    deleted["uploads"] = _remove_uploads(report, root)
    return deleted


def _fmt_bytes(size: int) -> str:
    value = float(size)
    for unit in ("B", "KB", "MB", "GB"):
        if value < 1024 or unit == "GB":
            return f"{value:.1f}{unit}"
        value /= 1024
    return f"{value:.1f}GB"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="清理过期运行数据（默认 dry-run）")
    parser.add_argument("--apply", action="store_true", help="真正删除；不加则只报告")
    parser.add_argument("--uploads-days", type=int, default=30)
    parser.add_argument("--sessions-days", type=int, default=180)
    parser.add_argument("--drafts-days", type=int, default=30)
    parser.add_argument("--jobs-days", type=int, default=90)
    parser.add_argument("--usage-days", type=int, default=90)
    args = parser.parse_args(argv)

    if not os.path.exists(store.db_path()):
        print(f"[FAIL] 数据库不存在：{store.db_path()}", file=sys.stderr)
        return 1

    report = plan(
        uploads_days=args.uploads_days,
        sessions_days=args.sessions_days,
        drafts_days=args.drafts_days,
        jobs_days=args.jobs_days,
        usage_days=args.usage_days,
    )

    print(f"数据库：{store.db_path()}")
    print(f"上传目录：{os.getenv('UPLOAD_DIR', 'app_data/uploads')}")
    print(
        f"可清理：会话 {len(report.sessions)} / 记录 {report.records} / "
        f"诊断 {len(report.diagnose_runs)}（步骤 {report.diagnose_steps}） / "
        f"任务 {len(report.jobs)} / 草稿 {len(report.drafts)} / 用量 {report.usage} / "
        f"上传 {len(report.uploads)} 个目录（{_fmt_bytes(report.upload_bytes)}）"
    )
    if report.sessions:
        print(f"  会话样例：{', '.join(report.sessions[:5])}")
    if report.uploads:
        print(f"  上传样例：{', '.join(name for name, _ in report.uploads[:5])}")

    if report.empty():
        print("没有需要清理的数据。")
        return 0

    if not args.apply:
        print("\n这是 dry-run。确认无误后加 --apply 执行。")
        return 0

    deleted = apply(report)
    print(
        f"\n已删除：会话 {deleted['sessions']} / 记录 {deleted['records']} / "
        f"诊断 {deleted['diagnose_runs']}（步骤 {deleted['diagnose_steps']}） / "
        f"任务 {deleted['jobs']} / 草稿 {deleted['drafts']} / 用量 {deleted['usage']} / "
        f"上传目录 {deleted['uploads']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
