"""B 模块契约测试：检索命中、未覆盖、参数校验。

评测集与知识库在同一个目录（`knowledge/eval_queries.json`），
改知识库必须同步改题——否则测试会变成"自己出题自己答"的假通过。
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from services import knowledge

from main import app

client = TestClient(app)


def _post(symptom: str, **extra) -> dict:
    body = {"symptom": symptom, **extra}
    r = client.post("/api/electro/diagnose", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def test_golden_queries_hit_top3():
    """10 条现场口吻的提问，Top-3 至少命中 8 条（当前实现 10/10）。"""
    cases = knowledge.load_eval_set()
    hits = 0
    for case in cases.queries:
        result = _post(case.query)
        assert result["matched"] is True, case.query
        ids = [item["id"] for item in result["results"]]
        hits += case.expect in ids
    assert hits >= 8, f"Top-3 命中 {hits}/{len(cases.queries)}"


def test_uncovered_system_is_explicit():
    """问没收录的子系统，必须明确说未覆盖，不能拿车门条目硬套。"""
    for case in knowledge.load_eval_set().uncovered:
        result = _post(case.query)
        assert result["matched"] is False
        assert result["uncovered_reason"] == "system_not_covered"
        assert result["results"] == []
        assert result["message"].startswith("未覆盖")


def test_unknown_symptom_reports_no_match():
    result = _post("今天天气不错，适合出门散步")
    assert result["matched"] is False
    assert result["uncovered_reason"] == "no_match"
    assert "上报" in result["message"]


def test_system_filter_blocks_wrong_subsystem():
    result = _post("门关到一半又自己弹开了", system="hvac")
    assert result["matched"] is False
    assert result["uncovered_reason"] == "system_not_covered"


def test_result_shape_is_actionable():
    result = _post("关门夹到包弹开以后就一直反复开关", top_k=2)
    assert result["count"] == len(result["results"]) <= 2
    assert result["disclaimer"] == "演示数据 · 非实际作业依据"
    assert isinstance(result["took_ms"], int)
    top = result["results"][0]
    assert top["checks"], "排查建议不能只有结论没有动作"
    orders = [c["order"] for c in top["checks"]]
    assert orders == sorted(orders)
    for check in top["checks"]:
        assert check["action"] and check["expect"]
    assert top["escalation"] and top["safety"]


def test_context_is_echoed_for_a1_handoff():
    result = _post(
        "锁闭信号时有时无",
        context={"guide_id": "g_door_switch_formal_001", "step_seq": 7, "criterion_id": "lock_signal"},
    )
    assert result["context"]["step_seq"] == 7
    assert result["context"]["criterion_id"] == "lock_signal"


def test_validation_rejects_short_or_oversized_input():
    assert client.post("/api/electro/diagnose", json={"symptom": "门坏"}).status_code == 422
    assert (
        client.post("/api/electro/diagnose", json={"symptom": "门" * 201}).status_code == 422
    )
    assert (
        client.post("/api/electro/diagnose", json={"symptom": "门关不上", "top_k": 6}).status_code
        == 422
    )


def test_kb_overview_lists_coverage():
    r = client.get("/api/electro/diagnose/kb")
    assert r.status_code == 200
    body = r.json()
    assert body["count"] == len(body["entries"]) == 8
    assert body["systems"] == ["door"]
    assert body["provider"] == "keyword"
