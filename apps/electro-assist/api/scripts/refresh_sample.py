#!/usr/bin/env python3
"""刷新**已发布样例**的内容（默认 dry-run）。

为什么需要它：样例只做「缺了才补」的 seed，发布后内容不可覆盖——这是为了防止
生成流程把案例顶替掉。代价是 `data/samples/*.json` 改了（补图、加动效、修文案），
线上已发布的那几份永远停在上线当天的版本，演示页看到的是旧图。

这个脚本只做一件事：按样例文件重写内容，**保留 id / status / created_at / published_at**。
因为主键没变，`sessions.guide_id` 与 `records.step_id` 继续有效，记录页不会断。

## 两道闸门（2026-11-13 第六轮评审后补齐）

1. **步骤 id 序列必须一致**——变了，老记录会指向不存在的步骤，只能人工迁移。
2. **有记录的步骤，含义不许变**（标题 / 动作 / 安全提示 / 判据）。只比 id 是不够的：
   `7d79af7` 就把 s02/s03 的内容对调而 id 原地不动，刷新照写成功，于是"在 s02 提交的
   记录"从"上电激活"变成了"MON 屏逐项确认"——记录没变，解读变了。
   确认要覆盖历史解读时加 `--allow-record-rewrite`，它会打印受影响的记录条数。

用法（在 `apps/electro-assist/api` 下）：

    python -m scripts.refresh_sample                 # 只报告差异
    python -m scripts.refresh_sample --yes           # 写入
    python -m scripts.refresh_sample --yes --only g_door_switch_formal_001
    python -m scripts.refresh_sample --yes --allow-record-rewrite   # 明知会改写历史解读

服务器容器内：

    docker exec matrix-hub python -m scripts.refresh_sample          # 先看
    docker exec matrix-hub python -m scripts.refresh_sample --yes    # 再写
"""
from __future__ import annotations

import argparse
import json
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


def _canonical(payload: dict) -> str:
    """规范化后的内容指纹：键序与空白不参与比较。"""
    return json.dumps(payload, ensure_ascii=False, sort_keys=True)


def diff_kind(stored: dict, fresh: dict) -> str | None:
    """判断该不该重写：`None` 相同 / `"stats"` 计数变了 / `"content"` 只是内容变了。

    只比计数是错的：把动效从一张图挪到另一张、给仪表补 `value`、改一句判据文案，
    计数全都不变——旧版会打 `[SAME]` 跳过，于是"刷新了"其实没刷新。
    生产上就是这么漏掉的一次（hvac 的 value 修补被跳过）。
    """
    if _canonical(stored) == _canonical(fresh):
        return None
    return "stats" if _stats(stored) != _stats(fresh) else "content"


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
    parser.add_argument(
        "--allow-record-rewrite",
        action="store_true",
        help="明知会改写已被记录引用的步骤含义时也写入（会打印受影响记录数）",
    )
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
    rewritten = 0

    for guide in guides:
        row = store.get_guide(guide.id)
        if row is None:
            print(f"[MISS] {guide.id}：库里没有这份样例（seed 只补缺，先确认是否该新建）")
            failed += 1
            continue
        if row["status"] != "published":
            print(f"[SKIP] {guide.id}：状态 {row['status']}，样例不覆盖草稿")
            continue

        fresh = guide.model_dump(mode="json")
        before = _stats(row["guide"])
        after = _stats(fresh)
        kind = diff_kind(row["guide"], fresh)
        if kind is None:
            print(f"[SAME] {guide.id}：{_fmt(before)}")
            continue

        pending += 1
        if kind == "stats":
            print(f"[DIFF] {guide.id}：{_fmt(before)} → {_fmt(after)}")
        else:
            # 计数不变也要打 DIFF：内容变了（参数/文案/动效落点），必须重写
            print(f"[DIFF] {guide.id}：内容有变化（计数不变 {_fmt(before)}）")
        if not args.yes:
            continue

        try:
            result = store.refresh_sample_guide(guide, allow_record_rewrite=args.allow_record_rewrite)
        except (ValueError, LookupError) as exc:
            print(f"  [FAIL] {exc}")
            failed += 1
            continue
        done += 1
        print(f"  [OK] 已写入，updated_at={result['updated_at']}")
        if result.get("rewrote_records"):
            rewritten += int(result.get("records_affected") or 0)

    if pending and not args.yes:
        print(f"\n共 {pending} 份有差异；确认无误后加 --yes 写入。")
        print(
            "注意 1：**这些差异不会自动上线**。seed 只在样例的 `meta.revision` 比库里那份高时才刷新，"
            "所以只改 JSON 不提 revision，线上永远停在旧版。"
        )
        print(
            "注意 2：若某一步已有记录，而这次改动了它的标题/动作/安全提示/判据，"
            "会被拒绝（避免老记录被重新解释）；确认要覆盖时加 --allow-record-rewrite。"
        )
    if done:
        tail = f"已刷新 {done} 份；记录与会话未受影响（id 与步骤 id 未变）。"
        if rewritten:
            tail = (
                f"已刷新 {done} 份；**按 --allow-record-rewrite 改写了 {rewritten} 条"
                "历史记录的解读**，请自行确认这些记录是否还需要。"
            )
        print("\n" + tail)
    if failed:
        print(f"\n{failed} 份未处理，见上面的 FAIL/MISS。")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
