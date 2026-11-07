"""来源登记必须覆盖每一条知识库条目（计划 §1.5 / SOURCES.md 规则 1）。

按"文件/批次"登记时，新增一条条目很容易忘记补来源——这里把
「库里有的 id 必须在 SOURCES.md 里出现」变成断言，缺一条直接红。

为什么放在 pytest 而不是 check_metrics.py：这条约束与"数字是否一致"无关，
它是一份合规清单的完整性检查，应该跟业务模型一起跑；CI 的测试 job 天然执行。
"""
from __future__ import annotations

import json
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = API_DIR.parents[2] if len(API_DIR.parents) > 2 else API_DIR
SOURCES = REPO_ROOT / "docs" / "SOURCES.md"
KB_DIR = API_DIR / "data" / "knowledge"


def _entry_ids() -> list[str]:
    ids: list[str] = []
    for path in sorted(KB_DIR.glob("*_faults.json")):
        payload = json.loads(path.read_text(encoding="utf-8"))
        ids.extend(entry["id"] for entry in payload["entries"])
    return ids


def test_every_kb_entry_is_registered_in_sources():
    assert SOURCES.is_file(), f"找不到来源清单：{SOURCES}"
    text = SOURCES.read_text(encoding="utf-8")
    ids = _entry_ids()
    assert ids, "知识库为空，测试前提不成立"
    missing = [entry_id for entry_id in ids if entry_id not in text]
    assert not missing, f"SOURCES.md 未登记以下条目：{missing}"
