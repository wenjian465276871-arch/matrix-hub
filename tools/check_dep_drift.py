#!/usr/bin/env python3
"""依赖漂移巡检：在 CI 红之前，先看"上游发了新版、镜像还没同步"。

## 为什么需要它

同一类事故已经发生**五次**（`requirements.txt` 里逐条记着）：

| 时间 | 包 | 现象 |
|---|---|---|
| 2026-10-30 | pydantic / pydantic-core | PyPI 有、阿里云镜像没有 → 镜像构建失败 |
| 2026-11-01 | anyio | CI 解析到新版 → 锁文件比对失败 |
| 2026-11-04 | typing-inspection | 同上 |
| 2026-11-07 | click | 同上 |
| 2026-11-18 | annotated-doc | 同上（这次还叠了"我改了 package.json 没同步 lock"的误判） |

每一次的模式完全一样：**PyPI 先发版 → `uv pip compile` 解析到新版 →
CI 的锁文件门禁红 → 排查 10 分钟 → 钉回旧版**。区别只是包名不同。

`solutions` 不是"再记一次"，而是**把发现时机提前**：CI 红之前，
用一条命令看清哪些包已经漂了、镜像同步了没有。

## 判据

对 `requirements.lock` 里每个包：

- `OK`：锁定版本 == PyPI 最新
- `可升`：PyPI 有新版，且**阿里云镜像已同步** → 安全升级窗口
- `卡住`：PyPI 有新版，但**镜像还没有** → 现在升级必然让 CI 与构建二选一失败

退出码：默认 0（巡检不改行为）；`--strict` 时有 `卡住` 就返回 1（给 CI/脚本用）。

用法：

    python tools/check_dep_drift.py
    python tools/check_dep_drift.py --strict
    python tools/check_dep_drift.py --json
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.request
from pathlib import Path

LOCK = Path(__file__).resolve().parents[1] / "apps" / "electro-assist" / "api" / "requirements.lock"
PYPI = "https://pypi.org/pypi/{name}/json"
MIRROR = "https://mirrors.aliyun.com/pypi/simple/{name}/"
TIMEOUT = 15


def _get(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": "ai2work-dep-drift/1"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:  # noqa: S310 - 固定 https 域名
        return resp.read().decode("utf-8", errors="replace")


def locked_versions(path: Path) -> dict[str, str]:
    """解析 lock 里的 `name==version`（忽略 hash 与注释行）。"""
    out: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        m = re.match(r"^([A-Za-z0-9._-]+)==([^\s\\]+)", line)
        if m:
            out[m.group(1).lower()] = m.group(2)
    return out


def pypi_latest(name: str) -> str | None:
    try:
        data = json.loads(_get(PYPI.format(name=name)))
    except Exception:  # noqa: BLE001 - 巡检不该因单包网络失败整体崩
        return None
    version = (data.get("info") or {}).get("version")
    return str(version) if version else None


def parse_mirror_html(html: str, name: str) -> set[str]:
    """从 simple index 的 HTML 里解析出这个包的全部版本。

    **别用 `re.escape(name).replace('_', '[-_]')`**（2026-11-19 第一版就这么写的）：
    `re.escape('typing-inspection')` 得到 `typing\\-inspection`，里面的 `-` 已被转义，
    再 replace 下划线毫无作用 → 正则只认连字符写法，而 PyPI 页面的文件名是
    `typing_inspection-0.4.5-…`（下划线）→ **一律判成"镜像没有"，全是假警报**。
    实测：当时报"4 个卡住"，其中 3 个镜像其实早已同步。

    正确做法是把包名里的分隔符统一归一成 `[-_]`，再拼版本捕获组。

    版本部分也不能写成 `[0-9][^-]*`（2026-11-19 第二版）：文件名后缀 `.tar.gz`
    都是"非连字符"，会把 `0.0.7.tar.gz">annotated` 整段吞进版本里。
    `--selftest` 第 2 条就是这样抓到的。改成只吃点分数字段 + 可选预发布后缀。
    """
    base = re.sub(r"[^A-Za-z0-9]+", "[-_]", name)
    found = re.findall(rf"{base}-([0-9]+(?:\.[0-9]+)*(?:(?:rc|alpha|beta|post)\d*)?)", html, re.IGNORECASE)
    return {v.rstrip(".") for v in found}


def mirror_versions(name: str) -> set[str] | None:
    """阿里云 simple index 里出现的版本集合；None 表示取不到（不代表没有）。"""
    try:
        html = _get(MIRROR.format(name=name))
    except Exception:  # noqa: BLE001
        return None
    return parse_mirror_html(html, name)


def _selftest() -> int:
    """用固定样本验解析逻辑（不联网）。这就是这条巡检的"负例"。"""
    cases = [
        # PyPI/Aliyun 的真实写法：下划线的 wheel 名
        ('<a href="../../x/typing_inspection-0.4.5-py3-none-any.whl">typing_inspection-0.4.5-py3-none-any.whl</a>', "typing-inspection", {"0.4.5"}),
        # 同名包的 sdist 用连字符
        ('<a href="../../x/annotated-doc-0.0.7.tar.gz">annotated-doc-0.0.7.tar.gz</a>', "annotated-doc", {"0.0.7"}),
        # 多版本共存
        ('typing_inspection-0.4.3-py3.whl typing_inspection-0.4.4-py3.whl typing_inspection-0.4.5-py3.whl', "typing-inspection", {"0.4.3", "0.4.4", "0.4.5"}),
        # 页面里没有这个包 → 空集（而不是误匹配别的包）
        ('<a href="../../x/other-1.2.3.tar.gz">other-1.2.3.tar.gz</a>', "typing-inspection", set()),
    ]
    bad = 0
    for html, name, want in cases:
        got = parse_mirror_html(html, name)
        if got != want:
            print(f"[FAIL] {name}: 期望 {sorted(want)}, 实得 {sorted(got)}")
            bad += 1
    print(f"自检 {len(cases) - bad}/{len(cases)} 通过")
    return 1 if bad else 0


def newer(a: str, b: str) -> bool:
    """a 是否比 b 新。用 packaging；解析失败时退回字符串比较（保守）。"""
    try:
        from packaging.version import Version

        return Version(a) > Version(b)
    except Exception:  # noqa: BLE001
        return a != b


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="依赖漂移巡检")
    ap.add_argument("--strict", action="store_true", help="有『卡住』时返回 1")
    ap.add_argument("--json", action="store_true", help="机器可读输出")
    ap.add_argument("--selftest", action="store_true", help="只跑解析逻辑的固定样本自检（不联网）")
    ap.add_argument("--lock", default=str(LOCK))
    args = ap.parse_args(argv)

    if args.selftest:
        return _selftest()

    lock_path = Path(args.lock)
    if not lock_path.exists():
        print(f"[FAIL] 找不到 {lock_path}", file=sys.stderr)
        return 2

    pinned = locked_versions(lock_path)
    rows = []

    for name, current in sorted(pinned.items()):
        latest = pypi_latest(name)
        if latest is None:
            rows.append({"name": name, "pinned": current, "latest": None, "state": "查不到"})
            continue
        if not newer(latest, current):
            rows.append({"name": name, "pinned": current, "latest": latest, "state": "OK"})
            continue
        mirrored = mirror_versions(name)
        if mirrored is None:
            state = "可升(镜像未确认)"
        elif latest in mirrored:
            state = "可升"
        else:
            state = "卡住"
        rows.append(
            {"name": name, "pinned": current, "latest": latest, "state": state, "mirror_has": bool(mirrored and latest in mirrored)}
        )

    stuck = [r for r in rows if r["state"] == "卡住"]
    updatable = [r for r in rows if r["state"].startswith("可升")]

    if args.json:
        print(json.dumps({"rows": rows, "stuck": len(stuck), "updatable": len(updatable)}, ensure_ascii=False, indent=1))
    else:
        for r in rows:
            if r["state"] == "OK":
                continue
            tag = {"卡住": "[!] 卡住", "可升": "[+] 可升", "可升(镜像未确认)": "[?] 可升"}.get(r["state"], "[?] 查不到")
            print(f"{tag:14} {r['name']:22} 锁定 {r['pinned']:12} 最新 {r['latest'] or '—'}")
        ok = sum(1 for r in rows if r["state"] == "OK")
        print(f"\n{len(rows)} 个包：{ok} 个最新、{len(updatable)} 个可升、{len(stuck)} 个卡住")
        if stuck:
            print("\n卡住 = PyPI 已发版但阿里云镜像还没同步。**现在升必然让 CI 或镜像构建失败**；")
            print("按 requirements.txt 既有做法钉住当前版本，等镜像同步（用这条命令复查）。")

    if args.strict and stuck:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
