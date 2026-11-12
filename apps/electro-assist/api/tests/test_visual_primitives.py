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
    DEVICE_MOMENTS,
    DEVICE_PART_LABELS,
    DEVICE_SUBJECTS,
    DEVICE_SYSTEMS,
    DEVICE_T_TOLERANCE,
    MAX_DEVICE_SCENES,
    MAX_MOTION_TRACKS,
    MotionAnim,
    Primitive,
    VisualSpec,
    allowed_params,
    device_catalog,
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
    # 2026-11-13 上限由 15 提到 17：新增 `mon_panel` 与 `operation_scene` 两个
    # **交互情景**原语（受电弓升弓试验的 MON 屏与双画布操作台）。它们是"带状态的
    # 界面"而不是一张图，用既有的 15 个只能拼出静态示意，点不了。上限跟着提，
    # 不是放宽断言——超过 17 仍然会红，防的是无节制扩表。
    assert 10 <= len(list(Primitive)) <= 17


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


# ---------------------------------------------------------------- 三维场景

def test_device_moments_are_ordered_and_bounded():
    """可指名瞬间必须是单调、去重、落在 0–1 的。

    这张表是 prompt 里 `t` 的唯一来源：顺序错或越界，模型会照着表选出一个
    前端算不出姿态的值——页面上表现为「图不动」或「停在别的工步」。
    """
    for subject, moments in DEVICE_MOMENTS.items():
        ts = [t for t, _, _ in moments]
        keys = [key for _, key, _ in moments]
        assert ts == sorted(ts), f"{subject} 的 t 未按升序排列"
        assert len(set(ts)) == len(ts), f"{subject} 的 t 有重复"
        assert len(set(keys)) == len(keys), f"{subject} 的 key 有重复"
        assert all(0.0 <= t <= 1.0 for t in ts), f"{subject} 的 t 越界"
        assert len(moments) >= 3, f"{subject} 至少要有 3 个可指名瞬间才有得选"


def test_device_moment_windows_do_not_overlap():
    """相邻瞬间的间距必须大于两倍容差，否则「吸附到最近值」有两个等价的答案。

    例：0.50 与 0.52 相邻、容差 0.02 时，模型给 0.51 吸附到哪个都说得通——
    同一份指导书两次生成可能落在不同帧，`t` 就不再是"可复现"的。
    """
    for subject, moments in DEVICE_MOMENTS.items():
        ts = [t for t, _, _ in moments]
        for earlier, later in zip(ts, ts[1:]):
            assert later - earlier > 2 * DEVICE_T_TOLERANCE, (
                f"{subject} 的 {earlier} 与 {later} 间距小于容差窗口，吸附会有歧义"
            )


def test_every_device_has_parts_systems_and_moments():
    """三个来源必须一一对齐：漏一个，catalog 生成时就会 KeyError。"""
    assert set(DEVICE_SUBJECTS) == set(DEVICE_MOMENTS) == set(DEVICE_SYSTEMS)
    for subject, systems in DEVICE_SYSTEMS.items():
        assert systems, f"{subject} 没有归属工位，等于永不可用"


def test_every_part_has_a_chinese_label():
    """每个可高亮部件都要有释义。

    只给键不给释义，`drive` / `drive2` 在模型眼里就是两个没有语义的缩写；
    猜错会高亮到别的件上，而高亮本身"看着合理"，没人能从结果反推它理解错了。
    """
    for subject, parts in DEVICE_SUBJECTS.items():
        labels = DEVICE_PART_LABELS[subject]
        assert set(labels) == set(parts), f"{subject} 的部件与释义键不一致"
        for key, label in labels.items():
            assert label and len(label) <= 40, f"{subject}.{key} 的释义为空或过长"
            assert any("\u4e00" <= ch <= "\u9fff" for ch in label), (
                f"{subject}.{key} 的释义没有中文，等于没解释"
            )


def test_device_scene_t_must_be_a_known_moment():
    """t 只认设备表里的瞬间。

    0–1 之间任何一个数都能画出一张好看的图，但画的是**别的工步**——
    图、读数、判据全对，只有"这是哪一步"错了，页面上没有任何东西能暴露它。
    """
    with pytest.raises(ValueError, match="只能取设备表里的瞬间"):
        spec("device_scene", {"subject": "door", "t": 0.72}).validate_against_primitive()


def test_device_scene_t_snaps_within_tolerance():
    """容差内吸附到表内值：差 1% 看不出来，但同一瞬间不该落在不同帧。"""
    visual = spec("device_scene", {"subject": "door", "t": 0.56})
    visual.validate_against_primitive()
    assert visual.params["t"] == 0.55


def test_device_scene_accepts_string_t():
    """模型经常把数字写成字符串；`"0.72"` 应当按数值处理并吸附。"""
    visual = spec("device_scene", {"subject": "pantograph", "t": "0.72"})
    visual.validate_against_primitive()
    assert visual.params["t"] == 0.72


def test_device_scene_requires_t():
    """省略 t 等于让前端随便挑一帧，和编一个 t 是同一件事，所以必须拒。"""
    with pytest.raises(ValueError, match="缺少必填参数"):
        spec("device_scene", {"subject": "door"}).validate_against_primitive()


def test_device_scene_part_error_lists_labels():
    """part 选错时的报错必须带释义：`drive2` 这种键，只说"不在列表里"模型改不动。"""
    visual = spec("device_scene", {"subject": "pantograph", "t": 0.72, "part": "drive3"})
    with pytest.raises(ValueError) as err:
        visual.validate_against_primitive()
    message = str(err.value)
    assert "drive=气路控制箱" in message
    assert "升弓气囊与降弓阻尼器" in message


def test_schema_visual_publishes_device_catalog():
    with TestClient(app) as client:
        body = client.get("/api/electro/schema/visual").json()
    devices = body["devices"]
    assert set(devices) == set(DEVICE_SUBJECTS)
    for subject, info in devices.items():
        assert info["parts"] == list(DEVICE_SUBJECTS[subject])
        assert info["part_labels"] == DEVICE_PART_LABELS[subject]
        assert info["systems"] == sorted(DEVICE_SYSTEMS[subject])
        assert [m["t"] for m in info["moments"]] == [t for t, _, _ in DEVICE_MOMENTS[subject]]


def test_prompt_lists_every_device_moment():
    """prompt 必须把每个设备的瞬间列全。

    只写「t 取 0–1」等于让模型自己编小数：编出来的 t 会让设备停在别的工步，
    而图上完全看不出来（图好看、读数也对，只是不是这一步）。
    """
    prompt = system_prompt()
    for subject, moments in DEVICE_MOMENTS.items():
        assert f"· {subject}（" in prompt, f"prompt 缺少设备 {subject}"
        for _, _, label in moments:
            assert label in prompt, f"prompt 缺少 {subject} 的瞬间「{label}」"


def test_prompt_states_device_scene_cap():
    assert f"最多 {MAX_DEVICE_SCENES} 张" in system_prompt()


def test_device_catalog_matches_prompt_parts():
    """catalog 里的每个 part 及其释义都必须出现在 prompt 那一行里。

    只对键做断言会漏掉释义：键进了 prompt、释义没进，模型看到的仍然是缩写，
    这一条改动的价值就归零了。
    """
    prompt = system_prompt()
    for subject, info in device_catalog().items():
        for key in info["parts"]:
            assert f"{key}={info['part_labels'][key]}" in prompt, (
                f"{subject}.{key} 的键或释义未进 prompt"
            )


# ---------------------------------------------------------------- baked_figure

def _baked(**over):
    """一条合法的烘焙图规格，测试里按需覆盖字段。"""
    base = {
        "primitive": "baked_figure",
        "params": {"src": "/figures/pantograph/step1.webp", "alt": "受电弓落弓状态"},
        "caption": "作业准备",
        "fallback_text": "受电弓落弓状态。",
    }
    base.update(over)
    return base


def test_baked_figure_accepts_site_relative_image():
    spec = VisualSpec(**_baked())
    spec.validate_against_primitive()
    assert spec.params["src"].startswith("/figures/")


@pytest.mark.parametrize(
    "src",
    [
        "figures/pantograph/step1.webp",          # 缺前导斜杠：拼上 BASE_URL 会变成相对路径
        "https://cdn.example.com/step1.webp",     # 外链：CSP 是 default-src 'self'，加载不出来
        "/figures/../../etc/passwd",              # 目录穿越
        "/figures/pantograph/step1.svg",          # 只允许位图
        "/static/step1.webp",                     # 不在 /figures/ 下
    ],
)
def test_baked_figure_rejects_bad_src(src):
    with pytest.raises(ValueError):
        VisualSpec(**_baked(params={"src": src, "alt": "x"})).validate_against_primitive()


def test_baked_figure_requires_alt():
    """图片必须有替代文字：图是内容不是装饰，读屏用户靠它知道画面里是什么。"""
    with pytest.raises(ValueError):
        VisualSpec(**_baked(params={"src": "/figures/a.webp", "alt": "   "})).validate_against_primitive()
    with pytest.raises(ValueError):
        VisualSpec(**_baked(params={"src": "/figures/a.webp"})).validate_against_primitive()


def test_baked_figure_rejects_unknown_params():
    """尺寸、滤镜、背景一律不给：那是构建期决定的，模型碰一次就错一次。"""
    with pytest.raises(ValueError):
        VisualSpec(
            **_baked(params={"src": "/figures/a.webp", "alt": "x", "width": 800})
        ).validate_against_primitive()


# ---------------------------------------------------------------- baked_figure

def _baked(**over):
    """一条合法的烘焙图规格，测试里按需覆盖字段。"""
    base = {
        "primitive": "baked_figure",
        "params": {"src": "/figures/pantograph/step1.webp", "alt": "受电弓落弓状态"},
        "caption": "作业准备",
        "fallback_text": "受电弓落弓状态。",
    }
    base.update(over)
    return base


def test_baked_figure_accepts_site_relative_image():
    spec = VisualSpec(**_baked())
    spec.validate_against_primitive()
    assert spec.params["src"].startswith("/figures/")


@pytest.mark.parametrize(
    "src",
    [
        "figures/pantograph/step1.webp",          # 缺前导斜杠：拼上 BASE_URL 会变成相对路径
        "https://cdn.example.com/step1.webp",     # 外链：CSP 是 default-src 'self'，加载不出来
        "/figures/../../etc/passwd",              # 目录穿越
        "/figures/pantograph/step1.svg",          # 只允许位图
        "/static/step1.webp",                     # 不在 /figures/ 下
    ],
)
def test_baked_figure_rejects_bad_src(src):
    with pytest.raises(ValueError):
        VisualSpec(**_baked(params={"src": src, "alt": "x"})).validate_against_primitive()


def test_baked_figure_requires_alt():
    """图片必须有替代文字：图是内容不是装饰，读屏用户靠它知道画面里是什么。"""
    with pytest.raises(ValueError):
        VisualSpec(**_baked(params={"src": "/figures/a.webp", "alt": "   "})).validate_against_primitive()
    with pytest.raises(ValueError):
        VisualSpec(**_baked(params={"src": "/figures/a.webp"})).validate_against_primitive()


def test_baked_figure_rejects_unknown_params():
    """尺寸、滤镜、背景一律不给：那是构建期决定的，模型碰一次就错一次。"""
    with pytest.raises(ValueError):
        VisualSpec(
            **_baked(params={"src": "/figures/a.webp", "alt": "x", "width": 800})
        ).validate_against_primitive()
