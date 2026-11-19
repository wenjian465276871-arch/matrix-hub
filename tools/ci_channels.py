#!/usr/bin/env python3
"""推送前先看：现在能不能查到 CI。

## 为什么需要它

2026-11-16 的 `2315e16` 把 `ci.yml` 退回上一次成功部署的状态。原因写在 body 里：
**两次推送都没部署，而本机看不到 CI 日志**（`api.github.com` 不可达、SSH 被拦）。
当时没有观测手段，"先 revert 保可部署"是合理选择——但那个 revert 本身是盲操作。

通道的通断是**间歇性**的：11-19 全天 `gh` 正常（查了十几次 run），11-16 却完全不通。
既然不可预测，就在推送前花 3 秒探一次，而不是推完才发现自己是瞎的。

## 三条通道

1. `gh` CLI —— 走 `api.github.com`，带认证，最完整（能看日志、能 watch）
2. 匿名 REST —— 同一个域名，无认证，有速率限制；只用来判断"域名通不通"
3. 网页 —— 不同 CDN，有时 API 被限流但网页能开

## 判据

- 至少一条通 → 可以查 CI，正常推
- 全不通 → **盲区**：推送后若失败，你拿不到失败原因。这时候：
  ① 先在 `docs/status/待办清单.md` 记下当前线上 tag 当回滚锚点；
  ② 优先推小改动，别一次堆多个；
  ③ 或者等通道恢复再推。

用法：

    python tools/ci_channels.py
    python tools/ci_channels.py --json
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import urllib.error
import urllib.request

OWNER_REPO = "wenjian465276871-arch/matrix-hub"
TIMEOUT = 10


def probe_gh() -> tuple[bool, str]:
    try:
        out = subprocess.run(
            ["gh", "run", "list", "--limit", "1", "--repo", OWNER_REPO],
            capture_output=True,
            text=True,
            timeout=TIMEOUT + 10,
            check=False,
        )
    except FileNotFoundError:
        return False, "gh 未安装"
    except subprocess.TimeoutExpired:
        return False, "gh 超时"
    if out.returncode != 0:
        first = (out.stderr or out.stdout or "").strip().splitlines()
        return False, first[0][:90] if first else f"exit {out.returncode}"
    line = out.stdout.strip().splitlines()
    return True, line[0][:90] if line else "ok"


def probe_http(url: str, headers: dict[str, str] | None = None) -> tuple[bool, str]:
    req = urllib.request.Request(url, headers=headers or {"User-Agent": "ai2work-ci-probe/1"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:  # noqa: S310 - 固定 https
            return True, f"HTTP {resp.status}"
    except urllib.error.HTTPError as exc:
        # 403/429 是限流，说明域名通（能拿到响应），对"能不能查"仍有意义的一半
        return exc.code in (403, 429), f"HTTP {exc.code}（域名通，被限流/拒绝）"
    except Exception as exc:  # noqa: BLE001
        return False, f"{type(exc).__name__}: {str(exc)[:70]}"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="CI 通道自检")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)

    results = []
    ok_gh, msg_gh = probe_gh()
    results.append({"channel": "gh CLI", "ok": ok_gh, "detail": msg_gh})

    ok_api, msg_api = probe_http(f"https://api.github.com/repos/{OWNER_REPO}/actions/runs?per_page=1")
    results.append({"channel": "匿名 REST", "ok": ok_api, "detail": msg_api})

    ok_web, msg_web = probe_http(f"https://github.com/{OWNER_REPO}/actions")
    results.append({"channel": "网页", "ok": ok_web, "detail": msg_web})

    alive = [r for r in results if r["ok"]]

    if args.json:
        print(json.dumps({"results": results, "alive": len(alive)}, ensure_ascii=False, indent=1))
    else:
        for r in results:
            print(f"{'[ OK ]' if r['ok'] else '[FAIL]'} {r['channel']:10} {r['detail']}")
        print()
        if alive:
            print(f"能查 CI（{len(alive)}/3 条通道）。首选 gh 看失败日志：`gh run view <id> --log-failed`。")
        else:
            print("**盲区**：三条通道全不通。推送后若失败，你拿不到失败原因。")
            print("建议：① 先把当前线上 tag 记进待办清单当回滚锚点（swas_exec 查 docker inspect）；")
            print("     ② 只推小改动；③ 或等通道恢复再推。")

    # 全盲才返回 1——这样它可以被当成"推送前检查"用在脚本里
    return 0 if alive else 1


if __name__ == "__main__":
    raise SystemExit(main())
