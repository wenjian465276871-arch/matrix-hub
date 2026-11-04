"""B 模块检索评测：命中率与延迟。

为什么要写成脚本而不是只留测试：
测试只能说"过了"，说不出"Top-3 命中 10/10、P95 1.2ms"。
作品集里需要的正是后一种句子，而它必须是跑出来的，不是估出来的。

用法：
    python scripts/eval_diagnose.py                 # 默认 12 条题、每条跑 20 次测延迟
    python scripts/eval_diagnose.py --repeat 50
    python scripts/eval_diagnose.py --report eval-diagnose.md

退出码：0 达标；1 未达标；2 输入问题。
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services import knowledge  # noqa: E402

MIN_HIT_RATE = 0.8


def _env_rate() -> float:
    """部署闸门的门槛可由 .env 调，避免为了改一个数重发镜像。"""
    try:
        value = float(os.getenv("EVAL_MIN_TOP3", "") or MIN_HIT_RATE)
    except ValueError:
        return MIN_HIT_RATE
    return value if 0 < value <= 1 else MIN_HIT_RATE


def percentile(values: list[float], p: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    rank = max(1, math.ceil(p / 100 * len(ordered)))
    return ordered[min(rank, len(ordered)) - 1]


def _ids_quick(query: str, top_k: int) -> tuple[list[str], str | None]:
    hits, _info, reason = knowledge.search_entries(
        query, top_k=top_k, use_rerank=False
    )
    return [hit.entry.id for hit in hits], reason


def _ids_full(query: str) -> tuple[list[str], str | None]:
    result = knowledge.diagnose(query)
    return [item["id"] for item in result["results"]], result["uncovered_reason"]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repeat", type=int, default=20, help="每条查询重复次数，用于测延迟")
    parser.add_argument("--report", help="输出 Markdown 报告路径")
    parser.add_argument("--min-hit-rate", type=float, default=_env_rate())
    parser.add_argument("--provider", choices=["hybrid", "keyword", "full"],
                        help="临时切换检索实现，用于对比（默认读 KNOWLEDGE_PROVIDER）")
    parser.add_argument("--quick", action="store_true",
                        help="不调模型、不测延迟：部署后自检用")
    parser.add_argument("--json", action="store_true", help="只输出一行 JSON（部署闸门用）")
    args = parser.parse_args()

    if args.provider:
        os.environ["KNOWLEDGE_PROVIDER"] = args.provider
        knowledge.reset_provider()

    cases = knowledge.load_eval_set()
    provider = knowledge.get_provider()
    run = _ids_quick if args.quick else _ids_full

    rows: list[tuple[str, str, str, bool, float]] = []
    latencies: list[float] = []
    started_all = time.perf_counter()

    for case in cases.queries:
        started = time.perf_counter()
        ids, _reason = run(case.query, 3) if args.quick else run(case.query)
        elapsed = (time.perf_counter() - started) * 1000
        latencies.append(elapsed)
        top = ids[0] if ids else "-"
        rows.append((case.query, case.expect, top, case.expect in ids[:3], 0.0))

    uncovered_rows: list[tuple[str, str, bool]] = []
    for case in cases.uncovered:
        ids, reason = run(case.query, 3) if args.quick else run(case.query)
        uncovered_rows.append((case.query, reason or "matched", not ids))

    # 延迟样本：quick 只测检索；完整模式才重复跑（含重排的网络等待）。
    if not args.quick:
        for _ in range(max(1, args.repeat)):
            for case in cases.queries:
                started = time.perf_counter()
                knowledge.diagnose(case.query)
                latencies.append((time.perf_counter() - started) * 1000)

    hits = sum(1 for row in rows if row[3])
    top1 = sum(1 for row in rows if row[1] == row[2])
    hit_rate = hits / len(rows) if rows else 0.0
    uncovered_ok = sum(1 for row in uncovered_rows if row[2])
    p50 = percentile(latencies, 50)
    p95 = percentile(latencies, 95)
    passed = hit_rate >= args.min_hit_rate and uncovered_ok == len(uncovered_rows)
    took_ms = int((time.perf_counter() - started_all) * 1000)

    if args.json:
        print(json.dumps({
            "provider": provider.name,
            "kb_version": provider.version,
            "mode": "quick" if args.quick else "full",
            "total": len(rows),
            "top1": top1,
            "top3": hits,
            "hit_rate": round(hit_rate, 3),
            "uncovered_ok": uncovered_ok,
            "uncovered_total": len(uncovered_rows),
            "min_hit_rate": args.min_hit_rate,
            "took_ms": took_ms,
            "passed": passed,
        }, ensure_ascii=False, separators=(",", ":")))
        return 0 if passed else 1

    lines = [
        "# B 模块检索评测",
        "",
        f"- 知识库：`{provider.name}`，{len(provider.entries())} 条，v{provider.version}",
        f"- 模式：{'quick（仅检索，不调模型）' if args.quick else '完整（含重排）'}",
        f"- 样本：{len(rows)} 条覆盖类查询 + {len(uncovered_rows)} 条未覆盖查询",
        f"- Top-1：**{top1}/{len(rows)}**；Top-3 命中：**{hits}/{len(rows)}（{hit_rate:.0%}）**，门槛 ≥{args.min_hit_rate:.0%}",
        f"- 未覆盖识别：**{uncovered_ok}/{len(uncovered_rows)}**",
        f"- 延迟：P50 **{p50:.1f}ms**，P95 **{p95:.1f}ms**（样本 {len(latencies)}）",
        "",
        "## 覆盖类查询",
        "",
        "| 查询 | 期望条目 | Top-1 | 命中 |",
        "|---|---|---|---|",
    ]
    for query, expect, top, ok, _value in rows:
        lines.append(f"| {query} | `{expect}` | `{top}` | {'✅' if ok else '❌'} |")
    lines += ["", "## 未覆盖查询", "", "| 查询 | 判定 | 正确 |", "|---|---|---|"]
    for query, reason, ok in uncovered_rows:
        lines.append(f"| {query} | {reason} | {'✅' if ok else '❌'} |")
    report = "\n".join(lines) + "\n"

    print(report)
    if args.report:
        Path(args.report).write_text(report, encoding="utf-8")
        print(f"报告已写入 {args.report}")

    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
