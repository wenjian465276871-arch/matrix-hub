#!/usr/bin/env python3
"""内容指纹：`data/samples/` 与 `data/knowledge/` 一改，门禁就红。

## 为什么需要它

H13（零内部资料）是**人工确认**，而确认绑定具体内容：样例或知识库任何改动都会
使它失效，需要用重新过目。但"任何改动"这件事以前只写在文档里靠人记——文档在另一个
仓库，改样例的人在改代码时看不到它。于是实际行为是：改完照常合并，确认悄悄过期。

这个脚本把"内容变没变"变成一条机械判据：

    python scripts/content_fingerprint.py --check     # CI 用；不一致即退出 1

不一致时的动作是**固定的两步**，不是"看着办"：
1. 在确认记录里补一条失效记录（时间 + 具体改了哪几份 + 增删行数）；
2. 取得本人确认后，用 `--write` 更新基线，**必须带 `--note`** 写明依据。

`--write` 强制要求 `--note`，是因为"更新基线"正是最容易被顺手做掉的一步：
不加这条约束，日后一次 `--write` 就能让门禁闭嘴，指纹就会变成橡皮图章。

## 指纹怎么算

按相对路径排序，把 `路径\\0内容\\0` 依次喂进 sha256。不含文件修改时间（不同机器
clone 下来 mtime 全是新的，比 mtime 等于永远不一致），也不含大小（内容变了大小
可能不变）。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]
DATA_DIR = API_DIR / "data"
SNAPSHOT = DATA_DIR / "CONTENT_FINGERPRINT.json"

# 只覆盖**内容**目录：代码与脚本改动不需要人工过目，样例与知识库才需要。
WATCHED_DIRS = ("samples", "knowledge")
SUFFIXES = (".json", ".md", ".txt")


def _watched_files(root: Path = DATA_DIR) -> list[Path]:
    files: list[Path] = []
    for name in WATCHED_DIRS:
        base = root / name
        if not base.is_dir():
            continue
        files.extend(p for p in base.rglob("*") if p.is_file() and p.suffix in SUFFIXES)
    return sorted(files, key=lambda p: p.relative_to(root).as_posix())


def _knowledge_entries(path: Path) -> int:
    """知识库文件的条目数（`entries` 数组长度）。只用于让人一眼看出规模变化。"""
    if path.suffix != ".json":
        return 0
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        return 0
    entries = data.get("entries") if isinstance(data, dict) else None
    return len(entries) if isinstance(entries, list) else 0


def compute(root: Path = DATA_DIR) -> dict[str, object]:
    """`root` 可换：测试要在临时目录里验"改了内容哈希就变"，不必碰真实样例。"""
    digest = hashlib.sha256()
    per_dir: dict[str, int] = {name: 0 for name in WATCHED_DIRS}
    entries = 0
    for path in _watched_files(root):
        rel = path.relative_to(root).as_posix()
        digest.update(rel.encode("utf-8"))
        digest.update(b"\0")
        # 按**内容**算，不按检出格式：CRLF / LF 是 checkout 的产物，不是作者改了什么。
        # 否则 `core.autocrlf` 不同的两台机器会算出两个哈希，门禁变成误报机器。
        digest.update(path.read_bytes().replace(b"\r\n", b"\n"))
        digest.update(b"\0")
        head = rel.split("/", 1)[0]
        per_dir[head] = per_dir.get(head, 0) + 1
        if head == "knowledge":
            entries += _knowledge_entries(path)
    return {"sha256": digest.hexdigest(), "files": per_dir, "knowledge_entries": entries}


def load_snapshot() -> dict[str, object]:
    if not SNAPSHOT.is_file():
        return {}
    return json.loads(SNAPSHOT.read_text(encoding="utf-8"))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="内容指纹（H13 绑定的机械判据）")
    parser.add_argument("--check", action="store_true", help="不一致则退出 1（CI 用）")
    parser.add_argument("--write", action="store_true", help="更新基线（必须带 --note）")
    parser.add_argument("--note", help="为什么可以更新基线：确认依据、时间、改了什么")
    args = parser.parse_args(argv)

    current = compute()
    if args.write:
        if not args.note:
            print("拒绝更新：--write 必须带 --note（写明确认依据），否则门禁就没有意义了。")
            return 2
        payload = {
            **current,
            "note": args.note,
        }
        SNAPSHOT.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        print(f"written {SNAPSHOT.relative_to(API_DIR)}")
        print(f"  sha256 = {current['sha256']}")
        print(f"  files  = {current['files']}（知识库 {current['knowledge_entries']} 条）")
        return 0

    saved = load_snapshot()
    same = saved.get("sha256") == current["sha256"]
    print(f"current  {current['sha256']}  {current['files']} 条目 {current['knowledge_entries']}")
    print(f"baseline {saved.get('sha256')}  {saved.get('files')} 条目 {saved.get('knowledge_entries')}")
    if same:
        print("ok 内容未变，H13 确认仍然有效")
        return 0

    # 不一致的两种情形要分开说：没基线（第一次）和真改了内容。
    if not saved:
        print("基线缺失：第一次启用请用 --write --note 建立。")
        return 1
    print(
        "\n内容已变更 → H13 确认失效。按顺序做两件事，不要跳过第 2 步的确认：\n"
        "  1. 在管理仓 docs/status/内容合规确认-2026-11-06.md 补一条失效记录\n"
        "     （改了什么、增删行数、为什么仍合规）；\n"
        "  2. 取得本人确认后，运行\n"
        "     python scripts/content_fingerprint.py --write --note \"<确认依据>\"\n"
    )
    # 不加 --check 也返回 1：不一致是事实，不该因为少敲一个参数就变成"通过"。
    return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
