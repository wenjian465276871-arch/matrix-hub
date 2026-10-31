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
from models.visual import (
    MAX_MOTION_TRACKS,
    MotionAnim,
    Primitive,
    VisualSpec,
    allowed_params,
    motion_slots,
)


def spec(primitive: str, params: dict, fallback: str = "图示降级文字") -> VisualSpec:
    return VisualSpec.model_validate(
        {"primitive": primitive, "params": params, "fallback_text": fallback}
    )


def moving(
    primitive: str, params: dict, motion: list[dict], fallback: str = "图示降级文字"
) -> VisualSpec:
    return VisualSpec.model_validate(
        {"primitive": primitive, "params": params, "fallback_text": fallback, "motion": motion}
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


# ---------- 动效轨道（计划 §2.1 tracks） ----------
# 动效是"可选强调"，所以两类错误都要挡住：写错槽位（静默不画）与
# 用动效表达文档没写的时间/顺序（比不画更危险）。


@pytest.mark.parametrize(
    ("primitive", "params", "target", "anim"),
    [
        ("status_light", {"state": "warn", "label": "门区"}, "lamp", "blink"),
        ("meter", {"value": 1.2, "unit": "s", "min": 0, "max": 3}, "needle", "flow"),
        ("meter", {"value": 1.2, "unit": "s", "min": 0, "max": 3}, "readout", "pulse"),
        ("gate_state", {"state": "half"}, "leaf", "pulse"),
        ("flow_arrow", {"steps": ["断电", "验电"]}, "arrow", "draw"),
        ("motion_timeline", {"steps": ["0–1.2s 启动", "1.2–2.8s 运行"]}, "segment", "pulse"),
    ],
)
def test_motion_accepts_valid_slot_and_anim(primitive, params, target, anim):
    visual = moving(primitive, params, [{"target": target, "anim": anim, "duration": 900}])
    visual.validate_against_primitive()
    assert visual.motion[0].anim is MotionAnim(anim)


def test_motion_defaults_duration_when_omitted():
    visual = moving("status_light", {"state": "pass"}, [{"target": "lamp", "anim": "pulse"}])
    assert visual.motion[0].duration == 900


@pytest.mark.parametrize(
    ("primitive", "params", "motion", "expect"),
    [
        # 不支持动效的原语：写错位置比写错值更难查，直接拒
        ("step_card", {"index": 1, "action": "确认"}, [{"target": "lamp", "anim": "pulse"}], "不支持 motion"),
        # 槽位不存在
        ("gate_state", {"state": "open"}, [{"target": "hinge", "anim": "pulse"}], "motion.target"),
        # 同一槽位两条轨道会互相覆盖，顺序不可预测
        (
            "status_light",
            {"state": "pass"},
            [{"target": "lamp", "anim": "pulse"}, {"target": "lamp", "anim": "shake"}],
            "重复",
        ),
        # 填充元素上做描边生长 → 一片空白
        ("gate_state", {"state": "closed"}, [{"target": "leaf", "anim": "draw"}], "描边"),
        ("status_light", {"state": "danger"}, [{"target": "lamp", "anim": "flow"}], "描边"),
    ],
)
def test_motion_rejects_bad_track(primitive, params, motion, expect):
    visual = moving(primitive, params, motion)
    with pytest.raises(ValueError, match=expect):
        visual.validate_against_primitive()


def test_motion_rejects_out_of_range_duration():
    with pytest.raises(ValueError):
        moving("status_light", {"state": "pass"}, [{"target": "lamp", "anim": "pulse", "duration": 200}])


def test_motion_rejects_unknown_anim():
    with pytest.raises(ValueError):
        moving("status_light", {"state": "pass"}, [{"target": "lamp", "anim": "spin"}])


def test_motion_is_capped():
    tracks = [
        {"target": "segment", "anim": "pulse"} for _ in range(MAX_MOTION_TRACKS + 1)
    ]
    with pytest.raises(ValueError):
        moving("motion_timeline", {"steps": ["a", "b"]}, tracks)


def test_schema_visual_publishes_motion_slots():
    with TestClient(app) as client:
        body = client.get("/api/electro/schema/visual").json()
    assert set(body["motion"]["slots"]) == set(motion_slots())
    assert body["motion"]["anims"] == [a.value for a in MotionAnim]
    assert body["motion"]["max_tracks"] == MAX_MOTION_TRACKS


def test_prompt_lists_motion_slots():
    """prompt 与校验共用同一份槽位表：写错了模型只会一直撞 422。"""
    prompt = system_prompt()
    for primitive, slots in motion_slots().items():
        assert f"- {primitive}：target 取 {', '.join(slots)}" in prompt


def test_meter_motion_requires_value():
    """没有 value 的仪表只画量程条，指针与读数都不存在。

    生产实测踩过：hvac 样例给"要求 1.4-1.8 MPa"（无 value）挂了 needle/draw，
    校验、发布、刷新三道关全放行，页面上一帧动画都没有——静默失效最坏。
    """
    visual = moving(
        "meter",
        {"min": 1.4, "max": 1.8, "unit": "MPa"},
        [{"target": "needle", "anim": "draw"}],
    )
    with pytest.raises(ValueError, match="没有 value"):
        visual.validate_against_primitive()


def test_meter_motion_ok_when_value_present():
    visual = moving(
        "meter",
        {"min": 6, "max": 12, "unit": "℃", "value": 9},
        [{"target": "needle", "anim": "draw"}],
    )
    visual.validate_against_primitive()
    assert visual.motion[0].target == "needle"


def test_meter_motion_requires_value():
    """没有 value 的仪表只画量程条，指针与读数都不存在。

    生产实测踩过：hvac 样例给"要求 1.4-1.8 MPa"（无 value）挂了 needle/draw，
    校验、发布、刷新三道关全放行，页面上一帧动画都没有——静默失效最坏。
    """
    visual = moving(
        "meter",
        {"min": 1.4, "max": 1.8, "unit": "MPa"},
        [{"target": "needle", "anim": "draw"}],
    )
    with pytest.raises(ValueError, match="没有 value"):
        visual.validate_against_primitive()


def test_meter_motion_ok_when_value_present():
    visual = moving(
        "meter",
        {"min": 6, "max": 12, "unit": "℃", "value": 9},
        [{"target": "needle", "anim": "draw"}],
    )
    visual.validate_against_primitive()
    assert visual.motion[0].target == "needle"
