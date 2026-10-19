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
import math
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services import knowledge  # noqa: E402

MIN_HIT_RATE = 0.8


def percentile(values: list[float], p: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    rank = max(1, math.ceil(p / 100 * len(ordered)))
    return ordered[min(rank, len(ordered)) - 1]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repeat", type=int, default=20, help="每条查询重复次数，用于测延迟")
    parser.add_argument("--report", help="输出 Markdown 报告路径")
    parser.add_argument("--min-hit-rate", type=float, default=MIN_HIT_RATE)
    args = parser.parse_args()

    cases = knowledge.load_eval_set()
    provider = knowledge.get_provider()

    rows: list[tuple[str, str, str, bool, float]] = []
    latencies: list[float] = []

    for case in cases.queries:
        started = time.perf_counter()
        result = knowledge.diagnose(case.query)
        elapsed = (time.perf_counter() - started) * 1000
        latencies.append(elapsed)
        ids = [item["id"] for item in result["results"]]
        top = ids[0] if ids else "-"
        rows.append((case.query, case.expect, top, case.expect in ids[:3], result["results"][0]["score"] if result["results"] else 0.0))

    uncovered_rows: list[tuple[str, str, bool]] = []
    for case in cases.uncovered:
        result = knowledge.diagnose(case.query)
        uncovered_rows.append((case.query, result["uncovered_reason"] or "matched", not result["matched"]))

    # 延迟样本：再跑若干轮（检索是确定性的，重复只为统计）
    for _ in range(max(1, args.repeat)):
        for case in cases.queries:
            started = time.perf_counter()
            knowledge.diagnose(case.query)
            latencies.append((time.perf_counter() - started) * 1000)

    hits = sum(1 for row in rows if row[3])
    hit_rate = hits / len(rows)
    uncovered_ok = sum(1 for row in uncovered_rows if row[2])
    p50 = percentile(latencies, 50)
    p95 = percentile(latencies, 95)

    lines = [
        "# B 模块检索评测",
        "",
        f"- 知识库：`{provider.name}`，{len(provider.entries())} 条，v{provider.version}",
        f"- 样本：{len(rows)} 条覆盖类查询 + {len(uncovered_rows)} 条未覆盖查询",
        f"- Top-3 命中：**{hits}/{len(rows)}（{hit_rate:.0%}）**，门槛 ≥{args.min_hit_rate:.0%}",
        f"- 未覆盖识别：**{uncovered_ok}/{len(uncovered_rows)}**",
        f"- 延迟：P50 **{p50:.1f}ms**，P95 **{p95:.1f}ms**（样本 {len(latencies)}）",
        "",
        "## 覆盖类查询",
        "",
        "| 查询 | 期望条目 | Top-1 | 命中 | 分数 |",
        "|---|---|---|---|---|",
    ]
    for query, expect, top, ok, value in rows:
        lines.append(f"| {query} | `{expect}` | `{top}` | {'✅' if ok else '❌'} | {value:.2f} |")
    lines += ["", "## 未覆盖查询", "", "| 查询 | 判定 | 正确 |", "|---|---|---|"]
    for query, reason, ok in uncovered_rows:
        lines.append(f"| {query} | {reason} | {'✅' if ok else '❌'} |")
    report = "\n".join(lines) + "\n"

    print(report)
    if args.report:
        Path(args.report).write_text(report, encoding="utf-8")
        print(f"报告已写入 {args.report}")

    if hit_rate < args.min_hit_rate or uncovered_ok != len(uncovered_rows):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
