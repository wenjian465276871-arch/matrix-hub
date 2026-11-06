"""脚本共用引导：默认路径与 `.env` 读取。

为什么单独一个模块：
- `.env` 解析原先在两个脚本里各写了一遍，改一处漏一处；
- `eval_generate.py` 的默认值曾经是 `../../../../AI2Work/.env`——**公开仓不该知道
  同级私有仓叫什么**，克隆到别处也会静默读不到（不报错，只是没有 Key）。

约定：
1. 默认只在**本仓**找 `.env`：`api/.env` → 仓库根 `.env`，都没有就返回 None；
2. 解析只认 `KEY=VALUE`，**不覆盖**已存在的环境变量（CI / shell 注入优先）；
3. 找不到文件不抛错，由调用方决定是提示还是继续（只读脚本可以不配 Key）。
"""
from __future__ import annotations

import os
from pathlib import Path

API_DIR = Path(__file__).resolve().parent.parent
# apps/electro-assist/api → apps/electro-assist → apps → 仓库根
#
# 但容器里不是这个层级：Dockerfile 把 api/ 整个 COPY 到 `/opt/electro`，
# 于是 `parents[2]` 直接越界（`/` 之上没有了）。2026-11-06 实测：
# `docker exec matrix-hub python -m scripts.eval_generate --dry-run`
# 在导入阶段就 IndexError，`eval_generate` 与 `smoke_llm` 两个脚本因此在
# 生产里**从来没有真正跑起来过**——本地结构正常，永远测不到。
#
# 兜底成 API_DIR：容器里 `.env` 本就在 `/opt/electro/.env`（或由 compose 注入
# 环境变量），取不到仓库根也不该让脚本起不来。
try:
    REPO_ROOT = API_DIR.parents[2]
except IndexError:  # 容器内层级更浅
    REPO_ROOT = API_DIR


def default_env_files() -> list[Path]:
    """默认候选，按优先级从高到低。"""
    return [API_DIR / ".env", REPO_ROOT / ".env"]


def find_env_file(explicit: str | None = None) -> Path | None:
    """显式路径优先；否则按 `default_env_files()` 找第一个存在的文件。"""
    if explicit:
        return Path(explicit).expanduser().resolve()
    for candidate in default_env_files():
        if candidate.is_file():
            return candidate
    return None


def load_env_file(path: Path | None) -> bool:
    """把文件里的 `KEY=VALUE` 写进 `os.environ`（不覆盖已有值）。

    返回是否真的读到了文件。空行、注释、没有 `=` 的行一律跳过，
    值两侧的单双引号会去掉——这三点是 `.env` 最常见的三种写法。
    """
    if path is None or not path.is_file():
        return False
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))
    return True
