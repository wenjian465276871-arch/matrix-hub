"""判据校验延迟基准（计划 §1.4：判据校验响应 ≤500ms）。

为什么走 HTTP 而不是直接调 `criteria.evaluate`：
计划里的指标是"判据校验响应"，现场感受来自
`POST /api/electro/sessions/{sid}/steps/{seq}` 这一整条链路——路由、幂等查询、
顺序校验、判据求值、SQLite 写事务、JSON 序列化。只测纯函数会把事务与 fsync 漏掉，
数字好看但不算数。

采样路径（不伪造流量，走真实状态机）：
1. 建 1 个会话（默认 `g_door_clearance_001`，3 步），第 1 步人工确认通过；
2. 第 2 步故意提交超差值 → verdict=fail，服务端**不推进** current_seq，可反复复测；
   每次换 Idempotency-Key，attempt 递增——这是一条真实写路径，不是打桩；
3. 丢掉前 `--warmup` 次，取 `--samples` 次，报 P50/P95/max。

用法（先起服务，用临时库，别碰 app_data）：
    DB_PATH=/tmp/bench.db UPLOAD_DIR=/tmp/bench-uploads \\
      .venv/Scripts/python.exe -m uvicorn main:app --port 8011
    .venv/Scripts/python.exe scripts/bench_criteria.py --base http://127.0.0.1:8011

退出码：0 达标；1 未达标或请求失败；2 输入问题。
"""

from __future__ import annotations

import argparse
import math
import os
import statistics
import sys
import time

import httpx

DEFAULT_GUIDE = "g_door_clearance_001"
DEFAULT_BUDGET_MS = 500.0
# 第 2 步的两个判据允许 1.0–3.0 / 1.5–4.0 mm，9.9 必然超差。
FAILING_VALUES = {"gap_mid": 9.9, "gap_end": 9.9}


def percentile(values: list[float], p: float) -> float:
    """与 eval_diagnose 同口径：最近秩，不插值。"""
    if not values:
        return 0.0
    ordered = sorted(values)
    rank = max(1, math.ceil(p / 100 * len(ordered)))
    return ordered[min(rank, len(ordered)) - 1]


def _fail(message: str) -> int:
    print(f"[FAIL] {message}", file=sys.stderr)
    return 1


def run(base: str, guide_id: str, samples: int, warmup: int, timeout: float) -> int:
    url = base.rstrip("/")
    with httpx.Client(timeout=timeout) as client:
        try:
            health = client.get(f"{url}/healthz?scope=live")
            health.raise_for_status()
        except httpx.HTTPError as exc:
            return _fail(f"服务不可达（{url}/healthz）：{exc}")

        started = client.post(f"{url}/api/electro/sessions", json={"guide_id": guide_id})
        if started.status_code == 429:
            return _fail("会话创建被限流（每小时 10 次），换一个 --guide 或重启服务")
        if started.status_code != 201:
            return _fail(f"建会话失败：{started.status_code} {started.text}")
        session_id = started.json()["session"]["id"]

        # 第 1 步是 manual 判据，确认后 current_seq 前进到 2。
        first = client.post(
            f"{url}/api/electro/sessions/{session_id}/steps/1",
            json={"values": {"confirm_safe": "确认"}},
            headers={"Idempotency-Key": f"bench:{session_id}:1"},
        )
        if first.status_code != 200:
            return _fail(f"第 1 步提交失败：{first.status_code} {first.text}")

        timings: list[float] = []
        total = warmup + samples
        for index in range(total):
            began = time.perf_counter()
            response = client.post(
                f"{url}/api/electro/sessions/{session_id}/steps/2",
                json={"values": dict(FAILING_VALUES)},
                headers={"Idempotency-Key": f"bench:{session_id}:2:{index}"},
            )
            elapsed_ms = (time.perf_counter() - began) * 1000
            if response.status_code != 200:
                return _fail(f"第 {index + 1} 次提交失败：{response.status_code} {response.text}")
            body = response.json()
            if body.get("verdict") != "fail":
                return _fail(f"预期 fail，实际 {body.get('verdict')!r}（采样路径失效）")
            if index >= warmup:
                timings.append(elapsed_ms)

    p50 = percentile(timings, 50)
    p95 = percentile(timings, 95)
    print(f"判据校验延迟 · POST /sessions/{{sid}}/steps/2 · guide={guide_id}")
    print(
        f"样本 {len(timings)}（预热丢弃 {warmup}）｜"
        f"P50 {p50:.1f}ms · P95 {p95:.1f}ms · "
        f"max {max(timings):.1f}ms · min {min(timings):.1f}ms · "
        f"mean {statistics.fmean(timings):.1f}ms"
    )
    budget = float(os.getenv("CRITERIA_BUDGET_MS", DEFAULT_BUDGET_MS))
    if p95 <= budget:
        print(f"[PASS] P95 {p95:.1f}ms ≤ 预算 {budget:.0f}ms")
        return 0
    print(f"[FAIL] P95 {p95:.1f}ms > 预算 {budget:.0f}ms", file=sys.stderr)
    return 1


def main() -> int:
    parser = argparse.ArgumentParser(description="判据校验延迟基准（计划 §1.4）")
    parser.add_argument("--base", default="http://127.0.0.1:8011", help="服务地址")
    parser.add_argument("--guide", default=DEFAULT_GUIDE, help="用于采样的样例 id")
    parser.add_argument("--samples", type=int, default=30, help="有效样本数")
    parser.add_argument("--warmup", type=int, default=5, help="预热次数（丢弃）")
    parser.add_argument("--timeout", type=float, default=10.0, help="单请求超时（秒）")
    args = parser.parse_args()
    if args.samples < 5:
        print("--samples 至少 5 次，否则 P95 没有意义", file=sys.stderr)
        return 2
    if args.warmup < 0:
        print("--warmup 不能为负", file=sys.stderr)
        return 2
    return run(args.base, args.guide, args.samples, args.warmup, args.timeout)


if __name__ == "__main__":
    raise SystemExit(main())
