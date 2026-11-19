"""部署探针脚本的回归测试（2026-11-19）。

## 为什么要测一个 shell 脚本

线上部署 2026-11-19 15:42 无端回滚：三条业务探针的 HTTP 请求全部 200
（Caddy 访问日志可查），脚本却报"业务探针失败（接口非 200 或响应结构不符）"。

根因不在接口，在判首字符的写法：

    printf '%s' "$body" | head -c 1 | grep -q '{'

`head -c 1` 读一个字节就退出，`printf` 还在写剩下的内容 → SIGPIPE（141）；
`deploy.sh` 是 `set -o pipefail`，整条管道被判失败。**触发条件是响应变大**：
知识库从 19 条涨到 397 条，`/diagnose/kb` 从 ~2KB 变成 40KB，从此每次都失败。
小响应（guides 列表 902B）永远不触发，所以这个坑藏了很久。

## 两条防线

1. `test_no_sigpipe_prone_pipe_idiom`：静态禁止 `printf … | …` 与 `head -c 1`
   回到部署脚本里。
2. `test_probe_business_survives_large_body`：真跑一遍 `probe_business`，喂 64KB
   响应。新写法必须通过——不是"看一眼代码觉得对"。

   注意老写法是**时序相关**的：空载时 `printf` 往往能在 `head` 退出前把内容写进
   管道缓冲，侥幸返回 0；部署时机器正忙，就会稳定收到 SIGPIPE。所以这条测试
   只断言新写法通过，不去断言老写法必失败（那样的测试本身会抖）。
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[4]
DEPLOY = ROOT / "deploy"
SCRIPTS = ["probe.sh", "deploy.sh", "postdeploy_watch.sh"]

# 真正的管道（排除 `||`）；用来抓"把变量 printf 进管道"
PIPE_RE = re.compile(r"(?<!\|)\|(?!\|)")


def _find_bash() -> str | None:
    """找一个能干活的 bash。

    Windows 的 `C:\\Windows\\System32\\bash.exe` 与 `WindowsApps\\bash.exe` 都是
    **WSL 启动器**，不是 bash：调它会得到一句看不懂的 WSL 报错（还可能被安全策略拦掉）。
    用 `PROBE_TEST_BASH` 指向 Git Bash（例如 WorkBuddy 自带的
    `D:/ProgramFiles/WorkBuddy/resources/vendor/PortableGit/usr/bin/bash.exe`）即可本地实跑；
    CI 的 Ubuntu 上 `/usr/bin/bash` 直接可用。
    """
    candidates = [os.getenv("PROBE_TEST_BASH"), shutil.which("bash")]
    for candidate in candidates:
        if not candidate:
            continue
        lowered = candidate.lower().replace("\\", "/")
        if "system32" in lowered or "windowsapps" in lowered:
            continue
        return candidate
    return None


BASH = _find_bash()


def test_no_sigpipe_prone_pipe_idiom():
    """部署脚本里不许再把变量 printf 进管道，也不许用 head 截断首字符。"""
    offenders: list[str] = []
    for name in SCRIPTS:
        path = DEPLOY / name
        for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            stripped = line.strip()
            if stripped.startswith("#"):
                continue
            if "head -c 1" in line or re.search(r"\bhead -1\b", line):
                offenders.append(f"{name}:{lineno} 用了 head 截断：{stripped}")
            if stripped.startswith("printf ") and PIPE_RE.search(line):
                offenders.append(f"{name}:{lineno} 把变量 printf 进管道：{stripped}")
    assert not offenders, "SIGPIPE + pipefail 隐患：\n" + "\n".join(offenders)


def test_probe_sh_uses_builtin_first_char():
    """首字符用 bash 内建取，匹配用 here-string —— 两层都不建管道。"""
    text = (DEPLOY / "probe.sh").read_text(encoding="utf-8")
    assert '[ "${list:0:1}" = "{" ]' in text
    assert '[ "${body:0:1}" = "{" ]' in text
    assert 'grep -Eq \'"items":[[:space:]]*\\[\' <<< "$list"' in text
    assert 'grep -Eq \'"count":[[:space:]]*[1-9]\' <<< "$body"' in text


@pytest.mark.skipif(
    sys.platform == "win32",
    reason="Windows 上嵌套 bash 会吃到外层的 sandbox shim（here-string 直接卡住）；行为用例只在 CI(Linux) 跑",
)
@pytest.mark.skipif(BASH is None, reason="没有可用的 bash，跳过脚本实跑")
def test_probe_business_survives_large_body(tmp_path: Path):
    """真跑 probe_business：64KB 响应必须判通过。

    不碰网络、不依赖 curl：把 `probe_curl` 覆盖成从文件读，探针本体（`probe_business`）
    照原样执行。新写法（内建取首字符 + here-string）在 64KB 响应下必须稳定通过。
    """
    pad = "x" * 65536
    (tmp_path / "list.json").write_text(
        json.dumps({"count": 1, "items": [{"id": "g_demo"}], "pad": pad}), encoding="utf-8"
    )
    (tmp_path / "detail.json").write_text(
        json.dumps({"status": "published", "guide": {"id": "g_demo"}, "pad": pad}), encoding="utf-8"
    )
    (tmp_path / "kb.json").write_text(
        json.dumps({"count": 397, "systems": ["door"], "pad": pad}), encoding="utf-8"
    )

    script = f"""
set -uo pipefail
export PROBE_BASE_URL=http://127.0.0.1:1
export SITE_DOMAIN=localhost
. "{DEPLOY / 'probe.sh'}"
probe_curl() {{
  case "$1" in
    */api/electro/guides/g_*) cat "{tmp_path / 'detail.json'}";;
    */api/electro/guides*)    cat "{tmp_path / 'list.json'}";;
    *)                        cat "{tmp_path / 'kb.json'}";;
  esac
}}
if probe_business; then echo PASS; else echo FAIL; fi
"""
    out = subprocess.run(
        [BASH, "-c", script],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=60,
        check=False,
    )
    assert "PASS" in out.stdout, (
        f"probe_business 判失败（64KB 响应）\nstdout={out.stdout!r}\nstderr={out.stderr!r}"
    )
