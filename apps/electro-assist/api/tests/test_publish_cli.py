"""发布 CLI 的契约测试。

只验证三件事：
1. `--list` 只列草稿；
2. `--publish` 把草稿变成已发布，且重复执行幂等；
3. 不存在的 id 返回非零退出码，不静默成功。

不测 argparse 的报错文案——那是 Python 标准库的行为，测了只会锁死版本。
"""
from __future__ import annotations

import json
from pathlib import Path

import store
from models.guide import Guide
from scripts import publish

SAMPLES = Path(__file__).resolve().parent.parent / "data" / "samples"


def _draft(guide_id: str) -> Guide:
    raw = json.loads((SAMPLES / "door_clearance.json").read_text(encoding="utf-8"))
    raw["id"] = guide_id
    return Guide.model_validate(raw)


def test_list_only_shows_drafts(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "electro.db"))
    store.init_db()
    store.save_guide(_draft("g_publish_draft_001"), status="draft")
    store.save_guide(_draft("g_publish_live_001"), status="published")

    assert publish.main(["--list"]) == 0
    out = capsys.readouterr().out
    assert "g_publish_draft_001" in out
    assert "g_publish_live_001" not in out
    assert "草稿 1 份" in out


def test_publish_moves_draft_to_public_list(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "electro.db"))
    store.init_db()
    store.save_guide(_draft("g_publish_cli_001"), status="draft")

    assert publish.main(["--publish", "g_publish_cli_001"]) == 0
    assert store.get_guide("g_publish_cli_001")["status"] == "published"
    assert "[OK]" in capsys.readouterr().out

    # 幂等：再执行一次不报错、不改变发布时间
    before = store.get_guide("g_publish_cli_001")["published_at"]
    assert publish.main(["--publish", "g_publish_cli_001"]) == 0
    assert "[SKIP]" in capsys.readouterr().out
    assert store.get_guide("g_publish_cli_001")["published_at"] == before


def test_publish_unknown_id_fails(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "electro.db"))
    store.init_db()

    assert publish.main(["--publish", "g_does_not_exist"]) == 1
    assert "[FAIL]" in capsys.readouterr().err
