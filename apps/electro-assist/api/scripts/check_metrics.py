#!/usr/bin/env python3
"""核对文档里的关键数字与代码事实是否一致（CI 门禁）。

为什么需要它：同一个数字（测试条数、端点数）散布在 5–8 份文档里，
改代码不改文档、或只改一半，都会让"可复现"变成"看起来可复现"。
此前已经漂移过一次（代码 25 端点、文档写 20），所以把比对做成脚本。

只核对**能从代码直接算出来**的数字；体积、延迟这类需要跑构建/压测的，
留给各自的脚本，不在这里假装核对。

用法（在 apps/electro-assist/api 下）：

    python scripts/check_metrics.py

不一致时退出码 1，并打印「文件 / 期望 / 实际」。
"""
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]
ROOT = API_DIR.parents[2]


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

    business = len([r for r in app.routes if getattr(r, "path", "").startswith("/api")])
    health = len([r for r in app.routes if getattr(r, "path", "") == "/healthz"])
    return business, business + health


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
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
