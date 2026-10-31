"""发布闸门：草稿允许留空，发布前必须补齐（计划 §12.4）。

为什么单列一个测试文件：这条规则不是"数据是否合法"，而是"什么时候允许离开
草稿箱"。之前 `publish.py` 只跑 `Guide.model_validate`，而 `Step.criteria`
默认是空列表——于是一条没有任何验收判据的步骤可以发布上线，现场照着做却
没有"做到什么程度算对"的依据。这是本项目唯一一处"合法但危险"的缺口。
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

import store
from models.guide import Guide
from scripts import publish
from services import library

SAMPLES = Path(__file__).resolve().parent.parent / "data" / "samples"


@pytest.fixture()
def db(tmp_path, monkeypatch):
    """独立库 + 不 seed：这里要自己控制库里有什么。"""
    monkeypatch.setenv("DB_PATH", str(tmp_path / "electro.db"))
    monkeypatch.setenv("GUIDE_DIR", str(SAMPLES))
    monkeypatch.setenv("SEED_GUIDES", "0")
    store.init_db()
    return tmp_path


def _sample() -> dict:
    return json.loads((SAMPLES / "door_clearance.json").read_text(encoding="utf-8"))


def _draft_without_criteria() -> Guide:
    """一份"结构完全合法、但第 2 步没有判据"的草稿。"""
    data = _sample()
    data["id"] = "g_gate_draft_001"
    data["steps"][1]["criteria"] = []
    return Guide.model_validate(data)


def test_blockers_name_each_unfilled_step():
    guide = _draft_without_criteria()
    blockers = guide.publish_blockers()
    assert len(blockers) == 1
    assert guide.steps[1].id in blockers[0]
    assert guide.steps[1].title in blockers[0]


def test_all_samples_are_publishable():
    """样例是"已发布"内容，必须自己先过这道闸门。"""
    for guide in library.load_fixtures(SAMPLES):
        assert guide.publish_blockers() == [], guide.id


def test_publish_cli_refuses_and_keeps_draft(db, capsys):
    guide = _draft_without_criteria()
    store.save_guide(guide, status="draft")

    assert publish.main(["--publish", guide.id]) == 2
    err = capsys.readouterr().err
    assert "发布前必须补齐" in err
    assert guide.steps[1].id in err
    # 关键：拒绝之后仍是草稿，不能"部分发布"
    assert store.get_guide(guide.id)["status"] == "draft"


def test_publish_cli_goes_through_after_filling(db):
    guide = _draft_without_criteria()
    store.save_guide(guide, status="draft")

    data = guide.model_dump(mode="json")
    data["steps"][1]["criteria"] = [
        {
            "id": "gap",
            "label": "门扇间隙",
            "type": "range",
            "unit": "mm",
            "min": 2,
            "max": 6,
        }
    ]
    store.save_guide(Guide.model_validate(data), status="draft")

    assert publish.main(["--publish", guide.id]) == 0
    assert store.get_guide(guide.id)["status"] == "published"


def test_refresh_refuses_sample_without_criteria(db):
    """刷新等于重新发布一次内容，同样要过闸门。"""
    guide = Guide.model_validate(_sample())
    store.save_guide(guide, status="published")

    broken = _draft_without_criteria()
    broken.id = guide.id

    with pytest.raises(ValueError, match="发布前未补齐"):
        store.refresh_sample_guide(broken)


def test_seed_skips_sample_without_criteria(tmp_path, monkeypatch):
    """样例进库即 published；缺判据的样例宁可不上架，也不能"已发布但没依据"。"""
    good = _sample()
    bad = _sample()
    bad["id"] = "g_gate_seed_001"
    bad["steps"][0]["criteria"] = []

    monkeypatch.setenv("DB_PATH", str(tmp_path / "electro.db"))
    monkeypatch.setenv("GUIDE_DIR", str(tmp_path))
    monkeypatch.setenv("SEED_GUIDES", "1")
    (tmp_path / "good.json").write_text(json.dumps(good, ensure_ascii=False), encoding="utf-8")
    (tmp_path / "bad.json").write_text(json.dumps(bad, ensure_ascii=False), encoding="utf-8")
    store.init_db()

    assert library.ensure_seeded() == 1
    assert store.get_guide(good["id"]) is not None
    assert store.get_guide("g_gate_seed_001") is None
