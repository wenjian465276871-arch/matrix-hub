"""样例刷新契约：能覆盖已发布内容，但不能碰草稿、不能改步骤 id。

这三条各自对应一次真实会出的事故：
- 覆盖草稿 → 用户/生成结果的草稿被样例顶掉；
- 改步骤 id → 老记录的 `step_id` 找不到对应步骤，记录页拼不出来；
- 换主键 → `sessions.guide_id` 悬空，现场会话直接 404。
"""
from __future__ import annotations

import pytest

import store
from models.guide import Guide
from services.library import load_fixtures


def make_guide(guide_id: str, *, drop_first_step_figures: bool = False) -> Guide:
    """取一份真实样例改成测试 id：样例本身是校验过的，不必手搓 Guide。"""
    source = {guide.id: guide for guide in load_fixtures()}["g_door_switch_formal_001"]
    guide = source.model_copy(deep=True)
    guide.id = guide_id
    if drop_first_step_figures:
        guide.steps[0].figures = []
    return guide


def test_refresh_replaces_content_and_keeps_identity():
    original = make_guide("g_test_refresh_a")
    store.save_guide(original, status="published")
    before = store.get_guide(original.id)
    assert before is not None

    updated = make_guide("g_test_refresh_a", drop_first_step_figures=True)
    result = store.refresh_sample_guide(updated)

    after = store.get_guide(original.id)
    assert after is not None
    assert result["after"]["figures"] < result["before"]["figures"]
    assert after["status"] == "published"
    # 身份不动：created_at / published_at 原样保留，只有 updated_at 前进
    assert after["created_at"] == before["created_at"]
    assert after["published_at"] == before["published_at"]
    assert after["guide"]["steps"][0]["figures"] == []


def test_refresh_refuses_draft():
    draft = make_guide("g_test_refresh_b")
    store.save_guide(draft, status="draft")
    with pytest.raises(ValueError, match="只刷新已发布样例"):
        store.refresh_sample_guide(make_guide("g_test_refresh_b", drop_first_step_figures=True))


def test_refresh_refuses_unknown_id():
    with pytest.raises(LookupError):
        store.refresh_sample_guide(make_guide("g_test_refresh_c"))


def test_refresh_refuses_changed_step_ids():
    published = make_guide("g_test_refresh_d")
    store.save_guide(published, status="published")

    changed = make_guide("g_test_refresh_d")
    changed.steps[0].id = "s99"
    with pytest.raises(ValueError, match="步骤 id"):
        store.refresh_sample_guide(changed)


def test_refresh_keeps_session_and_record_alive():
    guide = make_guide("g_test_refresh_e")
    store.save_guide(guide, status="published")
    session_id = store.create_session(guide.id)
    first_step = guide.steps[0].id

    record_id, deduped, code, _attempt = store.submit_step(
        session_id=session_id,
        step_id=first_step,
        seq=1,
        verdict="manual",
        payload={"note": "刷新前提交"},
        idempotency_key=f"{session_id}:s1:a1",
    )
    assert record_id and not deduped and code is None

    store.refresh_sample_guide(make_guide("g_test_refresh_e", drop_first_step_figures=True))

    session = store.get_session(session_id)
    assert session is not None
    assert session["guide_id"] == guide.id
    assert store.get_record(record_id) is not None


# ---------- SAME/DIFF 判定：只比计数会漏掉内容变化 ----------


def test_diff_kind_none_when_identical():
    from scripts.refresh_sample import diff_kind

    guide = make_guide("g_diff_same")
    payload = guide.model_dump(mode="json")
    assert diff_kind(payload, payload) is None


def test_diff_kind_detects_content_change_without_count_change():
    """把动效从一张图挪到另一张、给仪表补 value——计数全不变，必须仍判 DIFF。

    生产上真漏过一次：hvac 的 value 修补因为 8/4/2 三个计数都一样被标 `[SAME]` 跳过。
    """
    from scripts.refresh_sample import diff_kind

    guide = make_guide("g_diff_content")
    stored = guide.model_dump(mode="json")
    fresh = guide.model_dump(mode="json")
    # 只改一个参数值，不动任何计数
    fresh["steps"][0]["figures"][0]["params"]["label"] = "改写后的标签"
    assert diff_kind(stored, fresh) == "content"


def test_diff_kind_reports_stats_when_counts_change():
    from scripts.refresh_sample import diff_kind

    guide = make_guide("g_diff_stats")
    stored = guide.model_dump(mode="json")
    fresh = guide.model_dump(mode="json")
    fig = dict(fresh["steps"][0]["figures"][0])
    fresh["steps"][0]["figures"].append(fig)
    assert diff_kind(stored, fresh) == "stats"


# ---------- SAME/DIFF 判定：只比计数会漏掉内容变化 ----------


def test_diff_kind_none_when_identical():
    from scripts.refresh_sample import diff_kind

    guide = make_guide("g_diff_same")
    payload = guide.model_dump(mode="json")
    assert diff_kind(payload, payload) is None


def test_diff_kind_detects_content_change_without_count_change():
    """把动效从一张图挪到另一张、给仪表补 value——计数全不变，必须仍判 DIFF。

    生产上真漏过一次：hvac 的 value 修补因为 8/4/2 三个计数都一样被标 `[SAME]` 跳过。
    """
    from scripts.refresh_sample import diff_kind

    guide = make_guide("g_diff_content")
    stored = guide.model_dump(mode="json")
    fresh = guide.model_dump(mode="json")
    # 只改一个参数值，不动任何计数
    fresh["steps"][0]["figures"][0]["params"]["label"] = "改写后的标签"
    assert diff_kind(stored, fresh) == "content"


def test_diff_kind_reports_stats_when_counts_change():
    from scripts.refresh_sample import diff_kind

    guide = make_guide("g_diff_stats")
    stored = guide.model_dump(mode="json")
    fresh = guide.model_dump(mode="json")
    fig = dict(fresh["steps"][0]["figures"][0])
    fresh["steps"][0]["figures"].append(fig)
    assert diff_kind(stored, fresh) == "stats"
