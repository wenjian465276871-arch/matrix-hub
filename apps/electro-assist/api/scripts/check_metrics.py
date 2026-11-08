#!/usr/bin/env python3
"""核对文档里的关键数字与代码事实是否一致（CI 门禁）。

为什么需要它：同一个数字（测试条数、端点数）散布在 5–8 份文档里，
改代码不改文档、或只改一半，都会让"可复现"变成"看起来可复现"。
此前已经漂移过一次（代码 25 端点、文档写 20），所以把比对做成脚本。

只核对**能从代码直接算出来**的数字；体积、延迟这类需要跑构建/压测的，
留给各自的脚本，不在这里假装核对。

**另外打印两条「到点该复查」的提示**（2026-11-08 加，不影响退出码）：
① 知识库条目超过 100 条 → 该评估从进程内稀疏向量切到 embedding（决策 #19 的触发条件）；
② Lighthouse 基线超过 30 天没复测 → 按 UI.md §8 的复查条件再看一次。
两者的共同问题都是「条件写在文档里，只有人记得才会触发」，所以把它们变成 CI 的输出。
故意不设成 FAIL：超阈值说明该做一次决策，不说明代码错了。

用法（在 apps/electro-assist/api 下）：

    python scripts/check_metrics.py

不一致时退出码 1，并打印「文件 / 期望 / 实际」。
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from datetime import date
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]
ROOT = API_DIR.parents[2]

# 两条「到点该复查」的阈值（2026-11-08 加）。它们**不参与门禁判定**：
# 超阈值说明该做一件决策，不说明代码错了，算进 exit code 会让它变成"随机红"。
KB_ENTRY_HINT = 100  # 决策 #19：条目上千才切 embedding，先按 100 提醒一次
PERF_STALE_DAYS = 30  # UI.md §8：中位 <90 或 TBT 中位 >400ms 即需处理


def collected_tests() -> int:
    result = subprocess.run(
        [sys.executable, "-m", "pytest", "--collect-only", "-q", "-p", "no:cacheprovider"],
        cwd=API_DIR,
        capture_output=True,
        text=True,
    )
    match = re.search(r"(\d+) tests? collected", result.stdout)
    if not match:
        raise SystemExit("[FAIL] 无法解析 pytest 收集结果：\n" + result.stdout[-500:])
    return int(match.group(1))


def endpoint_counts() -> tuple[int, int]:
    sys.path.insert(0, str(API_DIR))
    from main import app  # noqa: PLC0415 - 延迟导入，避免 argparse/help 时建 app

    # fastapi 0.162 起，include_router 不再把子路由摊平进 app.routes，而是塞一个
    # 没有 path 属性的 _IncludedRouter 壳子（2026-11-06 实测：13 个 router 全成壳，
    # 直接遍历会数出「端点 0 个」）。改成读公开契约 openapi()["paths"]，它不受内部
    # 实现影响；实测 paths 35 / 端点 36 / 业务 35，与升级前基线一致。
    paths = app.openapi()["paths"]
    methods = {"get", "post", "put", "patch", "delete"}
    business = sum(
        1 for p, ops in paths.items() if p.startswith("/api") for m in ops if m in methods
    )
    health = sum(
        1 for p, ops in paths.items() if p == "/healthz" for m in ops if m in methods
    )
    return business, business + health


def review_hints() -> list[str]:
    """到点该复查的两件事。不参与门禁，只在 CI 日志里说话。"""
    out: list[str] = []
    kb_files = sorted((API_DIR / "data" / "knowledge").glob("*_faults.json"))
    kb = sum(len(json.loads(p.read_text(encoding="utf-8"))["entries"]) for p in kb_files)
    if kb > KB_ENTRY_HINT:
        out.append(
            f"知识库已 {kb} 条（提醒线 {KB_ENTRY_HINT}）：评估把进程内稀疏向量换成 embedding"
            "（决策 #19 的触发条件）。换之前先跑 eval_diagnose 留基线，否则无法证明换完更好。"
        )
    ui_path = ROOT / "docs" / "UI.md"
    ui = ui_path.read_text(encoding="utf-8") if ui_path.exists() else ""
    m = re.search(r"Lighthouse Mobile.*?(\d{4}-\d{2}-\d{2})", ui)
    if m is None:
        out.append("UI.md 里找不到 Lighthouse 基线日期，性能复查条件算不出来——把日期补进 §8。")
    else:
        days = (date.today() - date.fromisoformat(m.group(1))).days
        if days > PERF_STALE_DAYS:
            out.append(
                f"Lighthouse 基线采于 {m.group(1)}（{days} 天前，提醒线 {PERF_STALE_DAYS} 天）："
                "按 UI.md §8 复测一次；中位 <90 或 TBT 中位 >400ms 才需要处理。"
            )
    return out


def main() -> int:
    tests = collected_tests()
    business, total = endpoint_counts()

    rows: list[tuple[str, str, int, int]] = []

    def check(rel: str, pattern: str, actual: int, label: str, group: int = 1) -> None:
        path = ROOT / rel
        if not path.exists():
            return
        match = re.search(pattern, path.read_text(encoding="utf-8"))
        if match is None:
            print(f"[WARN] {rel} 里找不到「{label}」的数字（模式：{pattern}）")
            return
        rows.append((rel, label, int(match.group(group)), actual))

    check("README.md", r"\*\*(\d+) 条通过\*\*", tests, "后端测试")
    check("README.md", r"\*\*(\d+) 个业务端点\*\*", business, "业务端点")
    check("docs/README.md", r"(\d+) 端点（业务", total, "端点总数")
    check("docs/README.md", r"端点（业务 (\d+) \+", business, "业务端点")
    check("docs/DEVELOPMENT.md", r"(\d+) 个业务端点", business, "业务端点")
    check("docs/DEVELOPMENT.md", r"(\d+) 条契约测试", tests, "后端测试")

    bad = [row for row in rows if row[2] != row[3]]
    for rel, label, documented, actual in rows:
        mark = "OK  " if documented == actual else "FAIL"
        print(f"[{mark}] {rel:<22} {label:<6} 文档 {documented:>4} / 实际 {actual:>4}")

    if bad:
        print("\n文档与代码不一致。改完代码记得同步上面这些文件（或反过来）。")
        return 1
    print(f"\n一致：{tests} 条测试、{business} 个业务端点（共 {total} 个端点）。")

    hints = review_hints()
    if hints:
        print(f"\n[提示] {len(hints)} 条到点该复查（不影响本次门禁结果）：")
        for item in hints:
            print(f"  - {item}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
