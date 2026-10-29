"""演示流程自检：用 API 把 5 分钟演示走一遍，并打印每段耗时。

为什么要有它：
- 演示最怕"临场发现走不通"。这个脚本在开会前 1 分钟跑一次，能提前暴露
  配额用尽、知识库没加载、会话接口 500 之类的问题；
- 它同时是"一遍过"的证据：每一步都有状态码与判定结果。

默认走预生成的正式案例（不消耗生成额度）：
    python scripts/demo_flow.py --base http://127.0.0.1:8001

要从生成开始走（会消耗 1 次配额、约 ¥0.02）：
    python scripts/demo_flow.py --base <演示站> --generate

退出码：0 全通过；1 有步骤失败。
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import httpx

CORPUS = Path(__file__).resolve().parent.parent / "data" / "corpus" / "08_door_full_cycle.txt"
DEFAULT_GUIDE = "g_door_switch_formal_001"

# 按判据 id 给值：演示脚本不猜，值必须与正式案例的判据对得上。
DEFAULT_VALUES: dict[str, object] = {
    "confirm_safe": True,
    "supply_v": 110,
    "self_check": "通过",
    "isolation_state": "正常位",
    "release_state": "已复位",
    "torque": 0.8,
    "close_time": 3.5,
    "anti_pinch": "自动重开",
    "retry_s": 8,
    "lock_signal": "100% 关闭",
    "door_gap": 3.2,
    "restore_ok": True,
}


class StepFailed(Exception):
    pass


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:8001")
    parser.add_argument("--guide-id", default=DEFAULT_GUIDE)
    parser.add_argument("--generate", action="store_true", help="从 /generate 开始走")
    parser.add_argument("--poll-timeout", type=float, default=90.0)
    args = parser.parse_args()

    client = httpx.Client(base_url=args.base, timeout=30.0, trust_env=False)
    rows: list[tuple[str, str, int, str]] = []
    started = time.perf_counter()

    def record(stage: str, ok: bool, ms: int, note: str = "") -> None:
        rows.append((stage, "✅" if ok else "❌", ms, note))
        print(f"{'✅' if ok else '❌'} {stage:<12} {ms:>6}ms  {note}")

    # 1) 健康检查
    t = time.perf_counter()
    r = client.get("/healthz")
    ok = r.status_code == 200 and r.json().get("checks", {}).get("db") == "ok"
    record("healthz", ok, int((time.perf_counter() - t) * 1000), r.text[:60])
    if not ok:
        return 1

    guide_id = args.guide_id

    # 2) 生成（可选）
    if args.generate:
        text = CORPUS.read_text(encoding="utf-8")
        t = time.perf_counter()
        r = client.post("/api/electro/generate", json={"text": text})
        if r.status_code != 202:
            record("generate", False, int((time.perf_counter() - t) * 1000), r.text[:120])
            return 1
        job_id = r.json()["job_id"]
        deadline = time.time() + args.poll_timeout
        status = "queued"
        while time.time() < deadline:
            time.sleep(1.5)
            job = client.get(f"/api/electro/jobs/{job_id}").json()
            status = job["status"]
            if status in ("succeeded", "failed", "timeout"):
                break
        ok = status == "succeeded" and bool(job.get("guide_id"))
        record(
            "generate",
            ok,
            int((time.perf_counter() - t) * 1000),
            f"job={job_id} status={status} guide={job.get('guide_id')}",
        )
        if not ok:
            return 1
        guide_id = job["guide_id"]

    # 3) 读指导书
    t = time.perf_counter()
    detail = client.get(f"/api/electro/guides/{guide_id}")
    ok = detail.status_code == 200
    guide = detail.json()["guide"] if ok else {}
    steps = guide.get("steps", [])
    figures = sum(len(s["figures"]) for s in steps)
    record(
        "guide",
        ok and len(steps) >= 5,
        int((time.perf_counter() - t) * 1000),
        f"{guide.get('title', '-')} · {len(steps)} 步 / {figures} 图",
    )
    if not ok:
        return 1

    # 4) 开始会话
    t = time.perf_counter()
    r = client.post(
        "/api/electro/sessions",
        json={"guide_id": guide_id, "device": "DEMO-01", "location": "演示位"},
    )
    ok = r.status_code == 201
    record("session", ok, int((time.perf_counter() - t) * 1000), f"status={r.status_code}")
    if not ok:
        print(r.text)
        return 1
    sid = r.json()["session"]["id"]

    def submit(seq: int, values: dict, tag: str) -> dict:
        t0 = time.perf_counter()
        resp = client.post(
            f"/api/electro/sessions/{sid}/steps/{seq}",
            json={"values": values},
            headers={"Idempotency-Key": f"{sid}:s{seq:02d}:{tag}"},
        )
        elapsed = int((time.perf_counter() - t0) * 1000)
        body = resp.json()
        verdict = body.get("verdict", "?")
        record(f"step {seq}", resp.status_code == 200, elapsed, f"verdict={verdict}")
        if resp.status_code != 200:
            print(resp.text)
            raise StepFailed
        return body

    try:
        # 5) 前 4 步通过
        for step in steps[:4]:
            values = {
                c["id"]: DEFAULT_VALUES[c["id"]]
                for c in step["criteria"]
                if c["id"] in DEFAULT_VALUES
            }
            submit(step["seq"], values, "pass")

        # 6) 第 5 步故意超差
        step5 = steps[4]
        fail_values = {
            c["id"]: DEFAULT_VALUES[c["id"]]
            for c in step5["criteria"]
            if c["id"] in DEFAULT_VALUES
        }
        fail_values["open_time"] = 4.2
        body = submit(step5["seq"], fail_values, "fail")
        failure_note = "；".join(body.get("messages", []))[:120]

        # 7) 异常 → 排查
        t = time.perf_counter()
        query = f"{step5['title']} — {failure_note or '本步异常'}"
        r = client.post(
            "/api/electro/diagnose",
            json={"symptom": query[:200], "context": {"guide_id": guide_id, "step_seq": step5["seq"]}},
        )
        diag = r.json()
        record(
            "diagnose",
            r.status_code == 200 and diag.get("matched") is True,
            int((time.perf_counter() - t) * 1000),
            f"{diag.get('results', [{}])[0].get('id', diag.get('uncovered_reason'))}",
        )

        # 8) 复测通过，走完剩余步骤
        retest = dict(fail_values)
        retest["open_time"] = 3.1
        submit(step5["seq"], retest, "retest")
        for step in steps[5:]:
            values = {
                c["id"]: DEFAULT_VALUES[c["id"]]
                for c in step["criteria"]
                if c["id"] in DEFAULT_VALUES
            }
            submit(step["seq"], values, "pass")

        # 9) 结束并取记录
        t = time.perf_counter()
        r = client.post(f"/api/electro/sessions/{sid}/finish", json={"status": "done"})
        record("finish", r.status_code == 200, int((time.perf_counter() - t) * 1000), r.json()["session"]["status"])

        t = time.perf_counter()
        r = client.get(f"/api/electro/records/{sid}")
        report = r.json()
        summary = report["summary"]
        record(
            "record",
            r.status_code == 200,
            int((time.perf_counter() - t) * 1000),
            f"{summary['recorded_steps']} 步 / {summary['attempts']} 次尝试 / 异常 {len(report['exceptions'])}",
        )
    except StepFailed:
        return 1

    total = int((time.perf_counter() - started) * 1000)
    print(f"\n合计 {total}ms · 会话 {sid}")
    failures = [row for row in rows if row[1] == "❌"]
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
