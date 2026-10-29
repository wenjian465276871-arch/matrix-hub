"""视觉原语契约：13 个原语的可接受参数与拒绝理由。

为什么单独一个文件：原语是"构建期固定"的枚举，新增一个就要同时改
后端枚举、参数白名单、前端注册表三处。这里用参数化把"后端这一半"锁死，
前端那一半由 `registry.ts` 的类型检查兜底——少了哪一边，测试都会红。
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from llm.prompts import system_prompt
from main import app
from models.visual import Primitive, VisualSpec, allowed_params


def spec(primitive: str, params: dict, fallback: str = "图示降级文字") -> VisualSpec:
    return VisualSpec.model_validate(
        {"primitive": primitive, "params": params, "fallback_text": fallback}
    )


@pytest.mark.parametrize(
    ("primitive", "params"),
    [
        ("motion_timeline", {"steps": ["0–1.2s 门扇启动", "1.2–2.8s 匀速运行"], "total": "2.8s"}),
        ("flow_arrow", {"steps": ["断电", "验电", "挂牌"]}),
        ("callout", {"target": "门控器 X1", "note": "确认插头锁止", "position": "left"}),
        ("gate_state", {"state": "half", "label": "厅门", "note": "开口约 400mm"}),
        ("table", {"headers": ["项目", "标准"], "rows": ["开门时间|2.0–3.5s", "关门时间|2.0–3.5s"]}),
        ("annotation", {"title": "门区示意", "points": ["门扇：检查间隙", "门机：确认紧固"]}),
    ],
)
def test_new_primitive_accepts_valid_params(primitive: str, params: dict):
    visual = spec(primitive, params)
    visual.validate_against_primitive()


@pytest.mark.parametrize(
    ("primitive", "params", "expect"),
    [
        ("motion_timeline", {}, "steps"),
        ("motion_timeline", {"steps": ["只有一段"]}, "2–6"),
        ("flow_arrow", {}, "steps"),
        ("flow_arrow", {"steps": ["1", "2", "3", "4", "5", "6"]}, "2–5"),
        ("callout", {"target": "X1"}, "note"),
        ("gate_state", {"state": "ajar"}, "open"),
        ("table", {"headers": ["A"], "rows": ["1"]}, "2–4"),
        ("table", {"headers": ["A", "B"], "rows": ["只有一格"]}, "对齐"),
        ("annotation", {"points": []}, "1–6"),
    ],
)
def test_new_primitive_rejects_bad_params(primitive: str, params: dict, expect: str):
    visual = spec(primitive, params)
    with pytest.raises(ValueError, match=expect):
        visual.validate_against_primitive()


def test_unknown_param_still_rejected_for_new_primitive():
    visual = spec("flow_arrow", {"steps": ["a", "b"], "color": "red"})
    with pytest.raises(ValueError, match="不支持参数"):
        visual.validate_against_primitive()


def test_primitive_count_is_within_plan_range():
    # 计划 §2.1 要求 10–15 个；少于此说明"原语库补全"没做完。
    assert 10 <= len(list(Primitive)) <= 15


def test_schema_visual_lists_every_primitive():
    with TestClient(app) as client:
        body = client.get("/api/electro/schema/visual").json()
    assert set(body["primitives"]) == {p.value for p in Primitive}
    assert len(body["primitives"]) == len(list(Primitive))


def test_prompt_mentions_every_primitive():
    prompt = system_prompt()
    for name in allowed_params():
        assert f"- {name}：" in prompt, f"prompt 缺少原语 {name} 的说明"


def test_prompt_warns_against_checklist_as_table():
    assert "不要塞进 checklist" in system_prompt()
