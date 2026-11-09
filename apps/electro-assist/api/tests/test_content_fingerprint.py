"""内容指纹门禁（评审 P3-2）。

H13 的确认绑定 `data/samples/` 与 `data/knowledge/` 的具体内容。以前"改了要重新确认"
只写在文档里，而文档在另一个仓库——改样例的人在改代码时看不到它，于是实际行为是
改完照常合并、确认悄悄过期。这组用例把"内容变没变"变成一条会在 CI 里红的判据。

**指纹红了怎么办（固定动作，不要临时发挥）**：
1. 在管理仓 `docs/status/内容合规确认-2026-11-06.md` 补一条失效记录；
2. 取得本人确认后跑 `python scripts/content_fingerprint.py --write --note "..."`。

所以这条用例不需要"修"，只需要有人做上面两步。它红了就是对的。
"""
from __future__ import annotations

import json
import os
from pathlib import Path

from scripts import content_fingerprint as fp


def test_content_matches_confirmed_baseline():
    """当前内容必须与已确认的基线一致——不一致说明 H13 确认已失效。"""
    current = fp.compute()
    saved = fp.load_snapshot()

    assert saved, "指纹基线缺失：运行 --write --note 建立（并先取得 H13 确认）"
    assert current["sha256"] == saved["sha256"], (
        "data/samples 或 data/knowledge 已变更 → H13 确认失效。\n"
        "按顺序做：① 补失效记录；② 取得本人确认；③ "
        "python scripts/content_fingerprint.py --write --note \"<确认依据>\"。\n"
        f"当前 {current['files']} / 知识库 {current['knowledge_entries']} 条，"
        f"基线 {saved['files']} / 知识库 {saved.get('knowledge_entries')} 条"
    )


def test_baseline_carries_the_confirmation_note():
    """基线必须写明"凭什么可以更新"。

    没有这条约束，日后一次 `--write` 就能让门禁闭嘴，指纹就退化成橡皮图章。
    """
    saved = fp.load_snapshot()
    note = str(saved.get("note") or "").strip()
    assert len(note) >= 20, f"基线缺少确认说明：{note!r}"
    # 只要求可追溯：能定位到确认记录或时间，而不是一句"更新基线"。
    assert "确认" in note or "2026-" in note, f"确认说明看不出依据：{note!r}"


def test_write_refuses_without_note(monkeypatch, tmp_path: Path):
    """`--write` 不带 `--note` 必须拒绝，且不能改动现有基线。"""
    before = fp.SNAPSHOT.read_bytes()
    code = fp.main(["--write"])
    assert code == 2
    assert fp.SNAPSHOT.read_bytes() == before, "拒绝更新时不该写文件"


def test_compute_detects_content_change(tmp_path: Path):
    """改一个字节，指纹就要变——这是它唯一的工作。"""
    root = tmp_path / "data"
    (root / "samples").mkdir(parents=True)
    (root / "knowledge").mkdir(parents=True)
    sample = root / "samples" / "a.json"
    sample.write_text('{"title": "车门"}', encoding="utf-8")
    (root / "knowledge" / "k.json").write_text('{"entries": [{}, {}]}', encoding="utf-8")

    first = fp.compute(root)
    assert first["files"] == {"samples": 1, "knowledge": 1}
    assert first["knowledge_entries"] == 2

    sample.write_text('{"title": "车门 "}', encoding="utf-8")  # 只多一个空格
    assert fp.compute(root)["sha256"] != first["sha256"]


def test_compute_ignores_mtime(tmp_path: Path):
    """指纹不能含时间戳：换台机器 clone 下来 mtime 全是新的，比 mtime 等于永远不一致。"""
    root = tmp_path / "data"
    (root / "samples").mkdir(parents=True)
    target = root / "samples" / "a.json"
    target.write_text('{"a": 1}', encoding="utf-8")

    first = fp.compute(root)["sha256"]
    os.utime(target, (1_000_000_000, 1_000_000_000))
    assert fp.compute(root)["sha256"] == first


def test_compute_ignores_untracked_files(tmp_path: Path):
    """只认 json/md/txt：编辑器临时文件、备份副本不该让门禁红。"""
    root = tmp_path / "data"
    (root / "samples").mkdir(parents=True)
    (root / "samples" / "a.json").write_text("{}", encoding="utf-8")
    first = fp.compute(root)["sha256"]

    (root / "samples" / "a.json.bak").write_text("old", encoding="utf-8")
    (root / "samples" / ".DS_Store").write_bytes(b"\x00\x01")
    assert fp.compute(root)["sha256"] == first


def test_snapshot_is_readable_json():
    """快照本身要能被任何工具读：它是给人查的，不是二进制。"""
    data = json.loads(fp.SNAPSHOT.read_text(encoding="utf-8"))
    assert set(data) >= {"sha256", "files", "knowledge_entries", "note"}
