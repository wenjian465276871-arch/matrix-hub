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
    """显式指定子系统时，不能用别的子系统的条目凑答案。"""
    result = _post("门关到一半又自己弹开了", system="hvac")
    assert result["matched"] is False
    assert result["results"] == []


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
    """覆盖范围要能被前端如实展示：三个子系统、条数与实际一致。"""
    r = client.get("/api/electro/diagnose/kb")
    assert r.status_code == 200
    body = r.json()
    assert body["count"] == len(body["entries"]) >= 15
    assert body["systems"] == ["door", "hvac", "pantograph"]
    assert body["provider"] == "hybrid"
    assert {entry["system"] for entry in body["entries"]} == {"door", "hvac", "pantograph"}


def test_multi_candidate_query_surfaces_signals_and_rerank_slot():
    """混合召回要能给出多候选，且每个候选都带分项信号——否则重排无从发挥。"""
    result = _post("门关到一半又自己弹开了", top_k=3)
    assert result["count"] >= 2
    ids = [item["id"] for item in result["results"]]
    assert ids[0] == "kb_door_anti_pinch"
    for item in result["results"]:
        assert set(item["signals"]) == {"keyword", "vector", "combined"}
        assert item["signals"]["combined"] > 0
    # 未配置 Key 时重排自动关闭：必须回退检索顺序，而不是报错或空结果
    assert result["rerank"] is None


def test_measure_check_is_declared_in_quick_result():
    """快速检索也要标出哪些检查需要回填实测值，前端才能提前提示。"""
    result = _post("门到关闭位不锁闭")
    checks = result["results"][0]["checks"]
    measure = [c for c in checks if c["kind"] == "measure"]
    assert measure, "气压类条目的首项应为实测值检查"
    assert measure[0]["unit"] == "MPa"
    assert measure[0]["min"] < measure[0]["max"]


def test_result_carries_weights_and_match_confidence():
    """计划 §2.3：可能原因带权重，结果带置信度。"""
    result = _post("门关到一半又自己弹开了")
    top = result["results"][0]
    assert 0.0 <= result["confidence"] <= 1.0
    assert 0.0 <= top["confidence"] <= 1.0

    causes = top["likely_causes"]
    assert causes and all({"text", "weight"} <= set(cause) for cause in causes)
    weights = [cause["weight"] for cause in causes]
    # 旧知识库是字符串数组：按人工顺序补默认权重，必须递减
    assert weights == sorted(weights, reverse=True)


def test_uncovered_has_zero_confidence():
    result = _post("今天天气不错，适合出门散步")
    assert result["confidence"] == 0.0
    assert result["results"] == []


def test_full_injection_provider_is_switchable(monkeypatch):
    """计划 §2.3：保留全量注入实现，可与混合召回切换、对比。"""
    monkeypatch.setenv("KNOWLEDGE_PROVIDER", "full")
    knowledge.reset_provider()
    try:
        provider = knowledge.get_provider()
        assert provider.name == "full"
        door_total = len([e for e in provider.entries() if e.system.value == "door"])

        hits, reason = knowledge.recall("门关不上", system="door", top_k=3)
        assert reason is None
        # 召回不淘汰：所有车门条目都进重排 prompt
        assert len(hits) == door_total
        assert door_total > 3

        # 对外仍只回 top_k，不能把整库倒给页面
        capped, _, _ = knowledge.search_entries(
            "门关不上", system="door", top_k=3, use_rerank=False
        )
        assert len(capped) == 3
    finally:
        monkeypatch.delenv("KNOWLEDGE_PROVIDER", raising=False)
        knowledge.reset_provider()
        assert knowledge.get_provider().name == "hybrid"
