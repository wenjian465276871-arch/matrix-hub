#!/usr/bin/env python3
"""历史指导书的 provenance 回填（一次性运维脚本）。

**为什么要它**：`services/provenance.py` 的回填发生在**生成落库前**，只对新生成
生效。2026-11-08 15:00 之前产生的草稿没有 provenance，页面就一直不显示来源标记。
这个脚本把它们补上，顺带算一次"同一套定位规则在历史真实数据上的命中率"。

三条硬边界（写在代码里，不靠调用者记得）：

1. **跳过 published**：红线是「已发布不可覆盖」。provenance 虽然是元数据、不改判据值，
   但改 published 的 JSON 就是改已过合规确认的内容。
2. **只 UPDATE `json`**：不动 status / updated_at / title / step_count。改 updated_at
   会让所有补过的草稿在「最近更新」里跳到最前，反而误导。
3. **默认 dry-run**：不带 `--apply` 只读不写；带 `--apply` 先做整库备份
   （`sqlite3.Connection.backup`，WAL 下也安全），备份失败即中止。

用法（容器内 WORKDIR=/opt/electro）：
    python scripts/backfill_provenance.py              # 只报告
    python scripts/backfill_provenance.py --apply      # 备份后写库
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(API_DIR))

from models.guide import AssetRef, Guide  # noqa: E402
from services.provenance import backfill  # noqa: E402
from store.db import connect, db_path  # noqa: E402


@dataclass
class Plan:
    """一份指导书的回填计划。`payload` 为空表示这份没有变化。"""

    guide_id: str
    title: str
    status: str
    total: int = 0
    had: int = 0
    filled: int = 0
    ok: int = 0
    suspect: int = 0
    skipped: str = ""
    payload: str | None = None
    applied: bool = False


def _assets_of(guide: Guide) -> list[AssetRef]:
    """本次提交的素材集合（去重）。

    草稿里的素材有两个去处：`guide.assets`（未归位）与 `step.assets`（已归位）。
    回填只关心"一共几张图"，两个都要算——只数前者会把"图都归位了"的草稿误判成
    "0 张图"，那样 `asset_id` 永远不填。
    """
    seen: dict[str, AssetRef] = {}
    for ref in guide.assets:
        seen.setdefault(ref.asset_id, ref)
    for step in guide.steps:
        for ref in step.assets:
            seen.setdefault(ref.asset_id, ref)
    return list(seen.values())


def _source_text(process_id: str | None) -> str:
    if not process_id:
        return ""
    import store

    proc = store.get_process(process_id) or {}
    return proc.get("text") or ""


def build_plan() -> list[Plan]:
    """只读：算出每份指导书能补几条，不写库。"""
    with connect() as conn:
        rows = [
            dict(row)
            for row in conn.execute(
                "SELECT id, title, status, json, process_id FROM guides ORDER BY created_at"
            ).fetchall()
        ]

    plans: list[Plan] = []
    for row in rows:
        plan = Plan(row["id"], row["title"], row["status"])
        plans.append(plan)

        if row["status"] != "draft":
            plan.skipped = "published：已发布不可覆盖"
            continue

        text = _source_text(row.get("process_id"))
        if not text:
            plan.skipped = "没有工艺原文（无 process_id，或原文已过 30 天保留期）"
            continue

        try:
            guide = Guide.model_validate(json.loads(row["json"]))
        except Exception as exc:  # noqa: BLE001 - 单份坏数据不该中断整批
            plan.skipped = f"JSON 不符合当前 schema：{type(exc).__name__}"
            continue

        plan.total = sum(len(step.criteria) for step in guide.steps)
        plan.had = sum(1 for step in guide.steps for c in step.criteria if c.provenance)
        plan.filled = backfill(guide, text, _assets_of(guide))

        for step in guide.steps:
            for criterion in step.criteria:
                prov = criterion.provenance
                if prov is None:
                    continue
                if prov.flag == "ok":
                    plan.ok += 1
                else:
                    plan.suspect += 1

        if plan.filled:
            plan.payload = json.dumps(guide.model_dump(mode="json"), ensure_ascii=False)

    return plans


def _backup() -> Path:
    """整库备份到同目录（app_data 卷内，会被 backup.sh 一并打包）。"""
    source = Path(db_path())
    stamp = datetime.now(timezone.utc).astimezone().strftime("%Y%m%d-%H%M%S")
    dest = source.parent / f"{source.name}.bak-provenance-{stamp}"
    src = sqlite3.connect(source)
    dst = sqlite3.connect(dest)
    try:
        with dst:
            src.backup(dst)
    finally:
        src.close()
        dst.close()
    return dest


def apply_plan(plans: list[Plan]) -> Path:
    backup = _backup()
    with connect() as conn:
        for plan in plans:
            if not plan.payload:
                continue
            cur = conn.execute(
                # 双保险：即使 plan 期间被人发布了，这条 UPDATE 也不会命中
                "UPDATE guides SET json = ? WHERE id = ? AND status = 'draft'",
                (plan.payload, plan.guide_id),
            )
            plan.applied = cur.rowcount == 1
        conn.commit()
    return backup


def report(plans: list[Plan]) -> str:
    lines: list[str] = []
    changed = [p for p in plans if p.payload]
    total_filled = sum(p.filled for p in plans)
    total_ok = sum(p.ok for p in plans)
    total_suspect = sum(p.suspect for p in plans)

    lines.append(f"{'id':<22} {'状态':<10} {'判据':>4} {'已有':>4} {'可补':>4} {'ok':>3} {'待核':>4}  备注")
    lines.append("-" * 96)
    for p in plans:
        note = p.skipped or ("已写" if p.applied else ("待写" if p.payload else "无变化"))
        lines.append(
            f"{p.guide_id:<22} {p.status:<10} {p.total:>4} {p.had:>4} {p.filled:>4} "
            f"{p.ok:>3} {p.suspect:>4}  {note}"
        )
    lines.append("-" * 96)
    lines.append(
        f"共 {len(plans)} 份：可改 {len(changed)} 份，跳过 {len(plans) - len(changed)} 份；"
        f"新增 provenance {total_filled} 条（ok {total_ok} / suspect {total_suspect}）"
    )
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="真写库（默认只报告）")
    parser.add_argument("--json", action="store_true", help="额外输出机器可读汇总")
    args = parser.parse_args()

    plans = build_plan()
    print(report(plans))

    if args.apply:
        backup = apply_plan(plans)
        written = sum(1 for p in plans if p.applied)
        print(f"\n已备份：{backup}")
        print(f"已写入 {written} 份")
    else:
        print("\n（dry-run，未写库；加 --apply 执行）")

    if args.json:
        print(
            json.dumps(
                [
                    {
                        "id": p.guide_id,
                        "status": p.status,
                        "total": p.total,
                        "had": p.had,
                        "filled": p.filled,
                        "ok": p.ok,
                        "suspect": p.suspect,
                        "skipped": p.skipped,
                        "applied": p.applied,
                    }
                    for p in plans
                ],
                ensure_ascii=False,
            )
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
