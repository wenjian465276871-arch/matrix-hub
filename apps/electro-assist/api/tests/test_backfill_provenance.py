"""历史回填脚本的三条边界：只动 draft、只改 json、默认不写。

这个脚本会改生产数据，所以每条边界都单独钉一次。特别是"published 不碰"——
它有两道防线（plan 阶段跳过 + UPDATE 带 status 条件），测试两道都验：
只验 plan 阶段的话，将来有人为了"批量修一下"把 skip 去掉，第二道防线还在不在
就没人知道了。
"""
from __future__ import annotations

import json

import pytest

import store
from models.guide import AssetRef, Guide
from scripts import backfill_provenance as bp
from services.jobqueue import job_queue

TEXT = "1. 中部间隙 1.0–3.0mm\n2. 端部间隙 1.5–4.0mm"


@pytest.fixture()
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "electro.db"))
    store.init_db()
    job_queue.reset()
    yield


def _guide(guide_id: str = "g_test00000000001") -> Guide:
    return Guide(
        id=guide_id,
        title="客室侧门关闭间隙检查",
        summary="用于测试的历史回填指导书摘要",
        meta={"system": "door", "source_note": "公开资料改写（演示）", "model": "stub"},
        steps=[
            {
                "id": "s01",
                "seq": 1,
                "title": "测量间隙",
                "action": "在门扇中部与两端各测一次密封间隙",
                "criteria": [
                    {"id": "mid_gap", "label": "中部间隙", "type": "range", "unit": "mm", "min": 1.0, "max": 3.0},
                    {"id": "end_gap", "label": "端部间隙", "type": "range", "unit": "mm", "min": 1.5, "max": 4.0},
                ],
            }
        ],
    )


def _seed(guide: Guide, text: str = TEXT, status: str = "draft", with_process: bool = True) -> None:
    process_id = None
    if with_process:
        process_id = store.create_process(text=text, title="测量间隙")["id"]
    store.save_guide(guide, status=status, process_id=process_id)  # type: ignore[arg-type]


def test_dry_run_reports_without_writing(env) -> None:
    guide = _guide()
    _seed(guide)

    plans = bp.build_plan()
    assert len(plans) == 1
    assert plans[0].filled == 2
    assert plans[0].payload is not None

    # 库里的 JSON 一个字都没变
    row = store.get_guide(guide.id)
    assert row["guide"]["steps"][0]["criteria"][0]["provenance"] is None


def test_apply_writes_provenance_but_not_metadata(env) -> None:
    guide = _guide()
    _seed(guide)
    before = store.get_guide(guide.id)

    plans = bp.build_plan()
    backup = bp.apply_plan(plans)

    after = store.get_guide(guide.id)
    prov = after["guide"]["steps"][0]["criteria"][0]["provenance"]
    assert prov["flag"] == "ok"
    assert prov["line"] == 0
    # 只改 json：时间戳与状态保持原样，否则「最近更新」列表会被这 14 份挤满
    assert after["updated_at"] == before["updated_at"]
    assert after["status"] == before["status"]
    assert after["title"] == before["title"]
    assert backup.exists() and backup.stat().st_size > 0


def test_published_is_skipped_at_plan_stage(env) -> None:
    _seed(_guide(), status="published")
    plan = bp.build_plan()[0]
    assert plan.skipped.startswith("published")
    assert plan.payload is None


def test_apply_cannot_touch_published_even_if_forced(env) -> None:
    """第二道防线：把 published 强行塞进 plan，UPDATE 也不能命中。"""
    guide = _guide()
    _seed(guide, status="published")
    payload = json.dumps({"id": guide.id, "tampered": True})
    forced = [bp.Plan(guide.id, guide.title, "published", filled=1, payload=payload)]

    bp.apply_plan(forced)

    assert forced[0].applied is False
    row = store.get_guide(guide.id)
    assert "tampered" not in row["guide"]


def test_missing_source_text_is_skipped(env) -> None:
    _seed(_guide(), with_process=False)
    plan = bp.build_plan()[0]
    assert "没有工艺原文" in plan.skipped


def test_assets_of_merges_top_level_and_step_level() -> None:
    """素材可能都归位到步骤里了，只数顶层会误判成「0 张图」而永远不填 asset_id。"""
    guide = _guide()
    guide.assets = [AssetRef(asset_id="a_0123456789abcdef", caption="现场照片")]
    guide.steps[0].assets = [AssetRef(asset_id="a_fedcba9876543210", caption="另一张")]

    assets = bp._assets_of(guide)
    assert {a.asset_id for a in assets} == {"a_0123456789abcdef", "a_fedcba9876543210"}


def test_single_asset_gets_asset_id(env) -> None:
    guide = _guide()
    guide.assets = [AssetRef(asset_id="a_0123456789abcdef", caption="现场照片")]
    _seed(guide)

    bp.apply_plan(bp.build_plan())

    prov = store.get_guide(guide.id)["guide"]["steps"][0]["criteria"][0]["provenance"]
    assert prov["asset_id"] == "a_0123456789abcdef"
