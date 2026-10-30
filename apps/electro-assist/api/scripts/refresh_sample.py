#!/usr/bin/env python3
"""刷新**已发布样例**的内容（默认 dry-run）。

为什么需要它：样例只做「缺了才补」的 seed，发布后内容不可覆盖——这是为了防止
生成流程把案例顶替掉。代价是 `data/samples/*.json` 改了（补图、加动效、修文案），
线上已发布的那几份永远停在上线当天的版本，演示页看到的是旧图。

这个脚本只做一件事：按样例文件重写内容，**保留 id / status / created_at / published_at**。
因为主键没变，`sessions.guide_id` 与 `records.step_id` 继续有效，记录页不会断。
步骤 id 序列变了会直接拒绝——那种情况得人工迁移，不能靠覆盖。

用法（在 `apps/electro-assist/api` 下）：

    python -m scripts.refresh_sample                 # 只报告差异
    python -m scripts.refresh_sample --yes           # 写入
    python -m scripts.refresh_sample --yes --only g_door_switch_formal_001

服务器容器内：

    docker exec matrix-hub python -m scripts.refresh_sample          # 先看
    docker exec matrix-hub python -m scripts.refresh_sample --yes    # 再写
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

import store  # noqa: E402
from services.library import load_fixtures  # noqa: E402

_STAT_KEYS = ("figures", "primitives", "motion")


def _stats(payload: dict) -> dict[str, int]:
    """与 `store.dao._sample_stats` 同口径；dry-run 不能依赖写函数。"""
    figures = [
        figure
        for step in payload.get("steps", [])
        for figure in (step.get("figures") or [])
    ]
    return {
        "figures": len(figures),
        "primitives": len({figure.get("primitive") for figure in figures}),
        "motion": sum(1 for figure in figures if figure.get("motion")),
    }


def _fmt(stats: dict[str, int]) -> str:
    return " / ".join(f"{key} {stats[key]}" for key in _STAT_KEYS)


def main() -> int:
    parser = argparse.ArgumentParser(description="刷新已发布样例内容（默认 dry-run）")
    parser.add_argument("--yes", action="store_true", help="真正写入；不加只报告")
    parser.add_argument(
        "--only",
        action="append",
        default=[],
        metavar="ID",
        help="只处理指定指导书 id，可重复",
    )
    parser.add_argument("--dir", default=None, help="样例目录，默认 data/samples")
    args = parser.parse_args()

    store.init_db()
    guides = load_fixtures(Path(args.dir) if args.dir else None)
    if args.only:
        wanted = set(args.only)
        guides = [guide for guide in guides if guide.id in wanted]
    if not guides:
        print("没有可处理的样例文件")
        return 2

    pending = 0
    done = 0
    failed = 0

    for guide in guides:
        row = store.get_guide(guide.id)
        if row is None:
            print(f"[MISS] {guide.id}：库里没有这份样例（seed 只补缺，先确认是否该新建）")
            failed += 1
            continue
        if row["status"] != "published":
            print(f"[SKIP] {guide.id}：状态 {row['status']}，样例不覆盖草稿")
            continue

        before = _stats(row["guide"])
        after = _stats(guide.model_dump(mode="json"))
        if before == after:
            print(f"[SAME] {guide.id}：{_fmt(before)}")
            continue

        pending += 1
        print(f"[DIFF] {guide.id}：{_fmt(before)} → {_fmt(after)}")
        if not args.yes:
            continue

        try:
            result = store.refresh_sample_guide(guide)
        except (ValueError, LookupError) as exc:
            print(f"  [FAIL] {exc}")
            failed += 1
            continue
        done += 1
        print(f"  [OK] 已写入，updated_at={result['updated_at']}")

    if pending and not args.yes:
        print(f"\n共 {pending} 份有差异；确认无误后加 --yes 写入。")
    if done:
        print(f"\n已刷新 {done} 份；记录与会话未受影响（id 与步骤 id 未变）。")
    if failed:
        print(f"\n{failed} 份未处理，见上面的 FAIL/MISS。")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
