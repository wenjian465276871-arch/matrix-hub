#!/usr/bin/env python
"""门禁：测试里不许用"等时间"当判据（规则 R2）。

## 为什么有这个脚本

三天里为让 CI 变绿，改了 6 次阈值：点击闸门 700ms→3s、用例时限 180→300s、
首屏容差 +0.06kB、E2E 作业 15→30min……**没有一次消除根因**。
根因是 CI 用软件渲染跑 1–2 fps，而断言按本地 60 fps 写——**用时间当判据，必然随机器速度漂**。

所以把"读状态"这条纪律**做成机检**：`waitForTimeout(N)` 且 N ≥ 200ms 的，视为"用时间当判据"。

## 为什么用基线而不是一刀切清零

仓库里已有 12 处历史写法（多为"等动画播完"），一次全改风险大于收益。
本脚本只**禁止新增**：基线文件记每个文件当前的处数，任何文件**变多**即失败。
数值只能通过 `--freeze` 显式下调（改少了要冻结），避免"悄悄放宽"。

用法：
  python tools/check_test_timing.py            # 检查（CI / 提交前）
  python tools/check_test_timing.py --freeze   # 把当前状态写成新基线（只应减少）
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
WEB = os.path.join(ROOT, "apps", "electro-assist", "web")
BASELINE = os.path.join(HERE, "test_timing_baseline.json")

# 只看测试与验收脚本：单元测试里等 1ms 不算问题，这里抓的是"等动画/等渲染"
PATTERNS = [
    re.compile(r"waitForTimeout\(\s*(\d+)\s*\)"),
    re.compile(r"new\s+Promise\([^)]*setTimeout\([^)]*?(\d{3,})"),
]
SKIP_DIRS = {"node_modules", "dist", "coverage", ".git", "cov-r11", "cov-215445"}
EXTS = (".ts", ".mjs", ".js")


def iter_files():
    for base, dirs, files in os.walk(WEB):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not d.startswith("cov")]
        for f in files:
            if not f.endswith(EXTS):
                continue
            if "spec" not in f and "e2e" not in base:
                continue
            yield os.path.join(base, f)


def scan() -> dict[str, int]:
    hits: dict[str, int] = {}
    for path in iter_files():
        try:
            text = open(path, encoding="utf-8", errors="ignore").read()
        except OSError:
            continue
        n = 0
        for pat in PATTERNS:
            for m in pat.finditer(text):
                try:
                    if int(m.group(1)) >= 200:
                        n += 1
                except (IndexError, ValueError):
                    pass
        if n:
            hits[os.path.relpath(path, ROOT).replace("\\", "/")] = n
    return hits


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--freeze", action="store_true", help="把当前状态写成新基线")
    args = ap.parse_args()

    current = scan()

    if args.freeze:
        if os.path.exists(BASELINE):
            old = json.load(open(BASELINE, encoding="utf-8"))
            regress = {k: (old.get(k, 0), v) for k, v in current.items() if v > old.get(k, 0)}
            if regress:
                print("拒绝冻结：以下文件处数比旧基线**变多**，先把写法改掉：")
                for k, (o, n) in regress.items():
                    print(f"  {k}: {o} → {n}")
                return 1
        json.dump(current, open(BASELINE, "w", encoding="utf-8"), indent=2, ensure_ascii=False, sort_keys=True)
        print(f"基线已写入 {os.path.relpath(BASELINE, ROOT)}（共 {sum(current.values())} 处）")
        return 0

    if not os.path.exists(BASELINE):
        print("缺基线文件，先跑 --freeze")
        return 2

    base = json.load(open(BASELINE, encoding="utf-8"))
    bad = []
    for path, n in sorted(current.items()):
        was = base.get(path, 0)
        if n > was:
            bad.append((path, was, n))
    # 基线里记着、实际变少的：提示可以下调（不失败）
    shrank = [(p, n, current.get(p, 0)) for p, n in base.items() if current.get(p, 0) < n]

    if shrank:
        print("可下调基线（不失败，建议 --freeze）：")
        for p, n, now in shrank:
            print(f"  {p}: {n} → {now}")

    if bad:
        print("\n违反 R2（用时间当判据）新增：")
        for p, was, now in bad:
            print(f"  {p}: {was} → {now} 处")
        print("\n改法：等一个**可观察状态**（元素属性 / 场景字段 / __dbg 暴露量），不要等时长。")
        return 1

    print(f"通过：{len(current)} 个文件、共 {sum(current.values())} 处，均未超过基线")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
