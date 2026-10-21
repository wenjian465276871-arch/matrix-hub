"""受限重排的契约测试（不调用模型、不花钱）。

重排是"唯一让模型参与 B 模块"的地方，也是最需要回归保护的地方：
- 模型只能排序，不能新增条目；
- 越界 id 必须丢弃，漏掉的候选必须补回；
- 失败/超时/预算耗尽必须回退检索顺序，而不是报错或返回空。
"""
from __future__ import annotations

import json

import pytest

from llm.base import Completion, Usage
from models.knowledge import KnowledgeEntry
from services import rerank


def _entry(entry_id: str, title: str) -> KnowledgeEntry:
    return KnowledgeEntry.model_validate(
        {
            "id": entry_id,
            "system": "door",
            "title": title,
            "symptoms": ["门关不上", "门反复开关"],
            "keywords": ["门关不上", "反复开关"],
            "likely_causes": ["限位偏移", "气压不足"],
            "checks": [
                {"order": 1, "action": "读取故障指示灯", "expect": "闪 2 次"},
                {"order": 2, "action": "检查限位开关", "expect": "可靠触发"},
            ],
            "escalation": "仍不解决时按门控器故障上报，禁止短接限位。",
            "safety": "调整前断电挂牌，门区禁止站人。",
            "sources": ["D-05"],
        }
    )


ENTRIES = [_entry("kb_door_a", "门关不上"), _entry("kb_door_b", "门反复开关")]


class StubProvider:
    """只实现 structured()，并记录被调用次数。"""

    name = "stub"

    def __init__(self, payload: dict | None = None, boom: bool = False) -> None:
        self.payload = payload
        self.boom = boom
        self.calls = 0

    def structured(self, **_kwargs) -> Completion:
        self.calls += 1
        if self.boom:
            raise RuntimeError("模型不可用")
        return Completion(
            text=json.dumps(self.payload, ensure_ascii=False),
            model="stub",
            usage=Usage(prompt_tokens=1000, completion_tokens=1000),
            latency_ms=7,
        )

    def close(self) -> None:
        pass


@pytest.fixture(autouse=True)
def _reset(monkeypatch):
    rerank.reset_state()
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key")
    monkeypatch.setenv("DIAGNOSE_RERANK", "1")
    monkeypatch.delenv("RERANK_DAY_MICROS", raising=False)

    class Ok:
        ok = True
        code = ""
        message = ""
        retry_after = 0

    monkeypatch.setattr(rerank.quota, "check", lambda *a, **k: Ok())
    monkeypatch.setattr(rerank.store, "record_usage", lambda **k: None)
    yield
    rerank.reset_state()


def _use(monkeypatch, provider: StubProvider) -> StubProvider:
    monkeypatch.setattr(rerank, "get_provider", lambda: provider)
    return provider


def test_unknown_ids_are_dropped_and_missing_appended(monkeypatch):
    """模型只许排序：不存在的 id 丢弃，漏掉的候选按原序补回。"""
    provider = _use(
        monkeypatch,
        StubProvider({"order": ["kb_hallucinated", "kb_door_b", "kb_door_b", 42], "reason": "b 更像"}),
    )
    result = rerank.rerank("门关不上", ENTRIES)

    assert provider.calls == 1
    assert result is not None
    # 非法 id 与重复项被去掉，漏掉的 kb_door_a 补在末尾
    assert result["order"] == ["kb_door_b", "kb_door_a"]
    assert result["reason"] == "b 更像"
    assert result["cached"] is False


def test_empty_order_is_treated_as_failure(monkeypatch):
    """模型只返回越界 id，等于没排；必须回退，不能把候选全丢掉。"""
    _use(monkeypatch, StubProvider({"order": ["kb_nope"], "reason": "乱答"}))
    assert rerank.rerank("门关不上", ENTRIES) is None


def test_provider_failure_falls_back(monkeypatch):
    _use(monkeypatch, StubProvider(boom=True))
    assert rerank.rerank("门关不上", ENTRIES) is None


def test_result_is_cached_for_repeated_query(monkeypatch):
    """同一句话重复问，第二次必须走缓存：0 次调用、0 成本、立即返回。"""
    provider = _use(monkeypatch, StubProvider({"order": ["kb_door_b", "kb_door_a"], "reason": "ok"}))
    first = rerank.rerank("门关不上", ENTRIES)
    second = rerank.rerank("  门关不上  ", ENTRIES)

    assert provider.calls == 1
    assert first is not None and second is not None
    assert second["cached"] is True
    assert second["order"] == first["order"]


def test_budget_exhausted_skips_call(monkeypatch):
    """重排花自己的预算：预算为 0 时一次都不该发。"""
    monkeypatch.setenv("RERANK_DAY_MICROS", "0")
    provider = _use(monkeypatch, StubProvider({"order": ["kb_door_b"], "reason": "x"}))
    assert rerank.rerank("门关不上", ENTRIES) is None
    assert provider.calls == 0


def test_spend_accumulates_and_blocks_after_limit(monkeypatch):
    # 单次成本 ≈5000–10000 micros（峰谷价不同）；上限只够一次，
    # 第二次必须被预算挡住，与"缓存未命中"叠加验证。
    monkeypatch.setenv("RERANK_DAY_MICROS", "5000")
    provider = _use(monkeypatch, StubProvider({"order": ["kb_door_b", "kb_door_a"], "reason": "x"}))

    assert rerank.rerank("第一次", ENTRIES) is not None
    assert rerank.spent_today() > 0
    # 预算只够一次：第二次换查询（绕过缓存）必须被预算挡住
    assert rerank.rerank("第二次", ENTRIES) is None
    assert provider.calls == 1


def test_disabled_without_key(monkeypatch):
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    provider = _use(monkeypatch, StubProvider({"order": ["kb_door_b"], "reason": "x"}))
    assert rerank.rerank("门关不上", ENTRIES) is None
    assert provider.calls == 0


def test_single_candidate_never_calls_model(monkeypatch):
    provider = _use(monkeypatch, StubProvider({"order": ["kb_door_a"], "reason": "x"}))
    assert rerank.rerank("门关不上", ENTRIES[:1]) is None
    assert provider.calls == 0
