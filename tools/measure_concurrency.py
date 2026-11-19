#!/usr/bin/env python3
"""测「2 人同时操作」（计划 §1.4 ⑥：演示并发 ≤2 人）。

## 为什么现在才做

`docs/reports/开发情况报告-2026-10-21.md:214` 就写着「LCP/2 并发**未测**」，
一直挂了 30 天。计划 §1.4 把「≤2 人同时操作」写成验收指标，但从来没有证据。

## 测什么、不测什么（口径要说清）

- **测**：两个独立的 A1 会话并发推进（`POST /sessions` → 逐步提交 → 收尾）。
  这是"现场两人各自拿着平板照做"的真实形态，也是并发最容易撞的地方
  （同一份指导书被两个会话同时读、SQLite 写锁、每 IP 的会话限流）。
- **也测**：两个并发只读（`GET /guides/{id}`），看静态路径有没有被拖慢。
- **不测**：两个 A2 生成 job 并发。理由有两条，都是硬的：
  ① A2 是异步 job，两个 job 并发创建的"能力"由队列保证，不是并发瓶颈；
  ② 每 IP 生成配额只有 **2 次/时**，测一次就把当天额度用光，代价大于收益。
  这条取舍要写进报告，不能假装测过。

## 判据

- 全部请求 2xx（4xx 只允许出现在"判据未填"这类业务校验上，且要在输出里点名）
- 并发总耗时 ≤ 单会话耗时 × 1.6 —— 说明真的并行了，而不是被串行化

用法：

    python tools/measure_concurrency.py                      # 线上
    python tools/measure_concurrency.py --base http://127.0.0.1:8001
    python tools/measure_concurrency.py --people 3           # 看 3 人会不会崩（超计划，仅观测）
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
from concurrent.futures import ThreadPoolExecutor

import httpx

API = "/api/electro"


def pick_guide(client: httpx.Client) -> dict:
    """挑一份步数少、判据简单的已发布指导书（避免把测试时间耗在 8 步样例上）。"""
    r = client.get(f"{API}/guides", params={"limit": 20})
    r.raise_for_status()
    items = r.json().get("items", [])
    if not items:
        raise SystemExit("没有已发布指导书，无法测试")
    # 优先 3 步的关闭间隙；否则取步数最少的
    for it in items:
        if it["id"] == "g_door_clearance_001":
            return it
    return min(items, key=lambda i: i.get("steps_count", 99))


def values_for(step: dict) -> dict:
    """按判据类型造合法值——空 values 会被业务校验挡掉，测不出并发。"""
    out: dict = {}
    for c in step.get("criteria", []):
        kind = c.get("type")
        if kind == "manual":
            out[c["id"]] = True
        elif kind == "range":
            lo, hi = c.get("min"), c.get("max")
            out[c["id"]] = round((lo + hi) / 2, 3) if lo is not None and hi is not None else 0
        elif kind == "enum":
            opts = c.get("options") or []
            out[c["id"]] = opts[0] if opts else ""
        else:
            out[c["id"]] = "并发测试"
    return out


def one_person(base: str, steps: list[dict], tag: str) -> dict:
    """一个人的完整流程：开会话 → 逐步提交 → 收尾。返回每步耗时与状态。"""
    log: list[dict] = []
    with httpx.Client(base_url=base, timeout=30.0) as c:
        t0 = time.perf_counter()
        r = c.post(
            f"{API}/sessions",
            json={"guide_id": steps[0]["_guide"], "device": "并发测试", "location": tag},
        )
        log.append({"step": "start", "status": r.status_code, "ms": round((time.perf_counter() - t0) * 1000)})
        if r.status_code != 201:
            return {"tag": tag, "ok": False, "log": log, "error": r.text[:200]}
        # 响应是 {session:{...}, guide, records, progress}，id 在 session 里
        sid = r.json()["session"]["id"]

        for s in steps:
            t = time.perf_counter()
            r = c.post(
                f"{API}/sessions/{sid}/steps/{s['seq']}",
                json={"values": values_for(s), "note": "并发测试"},
                # 契约要求（§3.5）：Idempotency-Key = {sid}:{stepId}。缺了直接 400，
                # 不是 422——第一版没带这个头，6 个提交全 400 还被我判成"通过"。
                headers={"Idempotency-Key": f"{sid}:{s['id']}"},
            )
            log.append(
                {"step": f"submit-{s['seq']}", "status": r.status_code, "ms": round((time.perf_counter() - t) * 1000)}
            )

        t = time.perf_counter()
        r = c.post(f"{API}/sessions/{sid}/finish", json={"status": "aborted", "note": "并发测试收尾"})
        log.append({"step": "finish", "status": r.status_code, "ms": round((time.perf_counter() - t) * 1000)})
        total = round((time.perf_counter() - t0) * 1000)
        return {"tag": tag, "ok": True, "session": sid, "total_ms": total, "log": log}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="2 并发实测")
    ap.add_argument("--base", default="https://www.superplayer007.cn")
    ap.add_argument("--people", type=int, default=2)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)

    with httpx.Client(base_url=args.base, timeout=30.0) as c:
        guide = pick_guide(c)
        detail = c.get(f"{API}/guides/{guide['id']}").json()
        steps = [dict(s, _guide=guide["id"]) for s in detail["guide"]["steps"]]

    print(f"目标   {args.base}")
    print(f"指导书 {guide['id']}（{len(steps)} 步）")
    print(f"人数   {args.people}\n")

    # 先跑一遍单人做基线（顺序执行），再并发跑同规模
    t0 = time.perf_counter()
    solo = one_person(args.base, steps, "solo")
    solo_wall = round((time.perf_counter() - t0) * 1000)

    t0 = time.perf_counter()
    with ThreadPoolExecutor(max_workers=args.people) as pool:
        runs = list(pool.map(lambda i: one_person(args.base, steps, f"p{i + 1}"), range(args.people)))
    conc_wall = round((time.perf_counter() - t0) * 1000)

    bad = [r for r in runs if not r["ok"]]
    # 任何 4xx/5xx 都算失败——上一版只把 ok=False 当失败，导致"提交全 404"还判通过
    soft = [x for r in runs for x in r.get("log", []) if x["status"] >= 400]

    if args.json:
        print(json.dumps({"solo_ms": solo_wall, "concurrent_ms": conc_wall, "runs": runs}, ensure_ascii=False, indent=1))
    else:
        print(f"单人基线   {solo_wall}ms（{len(steps)} 步 + 开会话 + 收尾）")
        for r in runs:
            if r["ok"]:
                codes = " ".join(f"{x['step']}={x['status']}" for x in r["log"])
                print(f"  {r['tag']}  {r['total_ms']}ms  {codes}")
            else:
                print(f"  {r['tag']}  **失败**  {r.get('error', '')}")
        print(f"\n并发墙钟   {conc_wall}ms（{args.people} 人同时）")
        if solo_wall:
            ratio = conc_wall / solo_wall
            print(f"并发/单人  {ratio:.2f}×（≤1.6× 说明真并行；接近 {args.people}× 说明被串行化了）")
        if soft:
            print(f"\n[注意] {len(soft)} 个 4xx：")
            for x in soft:
                print(f"  {x['step']} → {x['status']}")
        print()
        ok = not bad and not soft and conc_wall <= solo_wall * 1.6
        print("判定    " + ("通过（2 人并发无失败、未被串行化）" if ok else "不通过，见上"))
        return 0 if ok else 1
    return 0 if (not bad and not soft) else 1


if __name__ == "__main__":
    sys.exit(main())
