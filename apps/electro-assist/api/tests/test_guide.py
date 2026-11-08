"""契约测试：领域模型的边界条件。

这些用例的作用不是覆盖率，而是把"什么样的数据才算合法"钉死。
生成端一旦产出越界数据，这里必须先红。
"""
from __future__ import annotations

import json
from copy import deepcopy
from pathlib import Path

import pytest
from pydantic import ValidationError

from models.guide import Guide, REQUIRED_DISCLAIMER

SAMPLE = json.loads((Path(__file__).parent.parent / "data" / "samples" / "door_clearance.json").read_text(encoding="utf-8"))


def test_sample_is_valid():
    guide = Guide.model_validate(SAMPLE)
    assert len(guide.steps) == 3
    assert guide.steps[1].criteria[0].unit == "mm"


def test_unit_longer_than_three_chars_rejected():
    bad = deepcopy(SAMPLE)
    bad["steps"][1]["criteria"][0]["unit"] = "millimeter"
    with pytest.raises(ValidationError):
        Guide.model_validate(bad)


def test_steps_must_be_contiguous_from_one():
    bad = deepcopy(SAMPLE)
    bad["steps"][1]["seq"] = 5
    with pytest.raises(ValidationError):
        Guide.model_validate(bad)


def test_missing_required_disclaimer_rejected():
    bad = deepcopy(SAMPLE)
    bad["disclaimers"] = ["随便写点什么"]
    with pytest.raises(ValidationError):
        Guide.model_validate(bad)


def test_enum_needs_at_least_two_options():
    bad = deepcopy(SAMPLE)
    bad["steps"][2]["criteria"][0]["options"] = ["合格"]
    with pytest.raises(ValidationError):
        Guide.model_validate(bad)


def test_range_needs_unit_and_bounds():
    bad = deepcopy(SAMPLE)
    bad["steps"][1]["criteria"][0].pop("unit")
    with pytest.raises(ValidationError):
        Guide.model_validate(bad)


def test_unknown_visual_param_rejected():
    bad = deepcopy(SAMPLE)
    bad["steps"][0]["figures"][0]["params"]["evil"] = "x"
    with pytest.raises(ValidationError):
        Guide.model_validate(bad)


def test_visual_param_rejects_markup():
    bad = deepcopy(SAMPLE)
    bad["steps"][0]["figures"][0]["params"]["action"] = "<script>alert(1)</script>"
    with pytest.raises(ValidationError):
        Guide.model_validate(bad)


def test_status_light_state_must_be_known():
    bad = deepcopy(SAMPLE)
    bad["steps"][2]["figures"][0]["params"]["state"] = "green"
    with pytest.raises(ValidationError):
        Guide.model_validate(bad)


def test_fallback_text_is_mandatory():
    bad = deepcopy(SAMPLE)
    bad["steps"][0]["figures"][0].pop("fallback_text")
    with pytest.raises(ValidationError):
        Guide.model_validate(bad)


def test_default_disclaimer_present():
    guide = Guide.model_validate(SAMPLE)
    assert REQUIRED_DISCLAIMER in guide.disclaimers


# ---------------------------------------------------------------- 参数类型（决策 #15）

def test_list_params_are_accepted():
    """清单类参数允许字符串列表——这是模型最自然的写法。"""
    from models.visual import VisualSpec

    spec = VisualSpec.model_validate(
        {
            "primitive": "checklist",
            "params": {"items": ["确认断电挂牌", "确认防溜车措施", "确认区域警示"]},
            "fallback_text": "作业前逐项确认。",
        }
    )
    assert spec.params["items"] == ["确认断电挂牌", "确认防溜车措施", "确认区域警示"]


def test_list_param_too_many_items_rejected():
    from models.visual import MAX_LIST_ITEMS, VisualSpec

    with pytest.raises(ValidationError):
        VisualSpec.model_validate(
            {
                "primitive": "checklist",
                "params": {"items": ["x"] * (MAX_LIST_ITEMS + 1)},
                "fallback_text": "超长列表。",
            }
        )


def test_list_param_item_too_long_rejected():
    from models.visual import MAX_LIST_ITEM_CHARS, VisualSpec

    with pytest.raises(ValidationError):
        VisualSpec.model_validate(
            {
                "primitive": "checklist",
                "params": {"items": ["x" * (MAX_LIST_ITEM_CHARS + 1)]},
                "fallback_text": "超长项。",
            }
        )


def test_list_param_rejects_markup():
    from models.visual import VisualSpec

    with pytest.raises(ValidationError):
        VisualSpec.model_validate(
            {
                "primitive": "checklist",
                "params": {"items": ["<script>alert(1)</script>"]},
                "fallback_text": "含标记。",
            }
        )


def test_list_param_rejects_objects():
    from models.visual import VisualSpec

    with pytest.raises(ValidationError):
        VisualSpec.model_validate(
            {
                "primitive": "checklist",
                "params": {"items": [{"text": "a"}]},
                "fallback_text": "嵌套对象。",
            }
        )


# ---------------------------------------------------------------- 参数类型（决策 #15）

def test_list_params_are_accepted():
    """清单类参数允许字符串列表——这是模型最自然的写法。"""
    from models.visual import VisualSpec

    spec = VisualSpec.model_validate(
        {
            "primitive": "checklist",
            "params": {"items": ["确认断电挂牌", "确认防溜车措施", "确认区域警示"]},
            "fallback_text": "作业前逐项确认。",
        }
    )
    assert spec.params["items"] == ["确认断电挂牌", "确认防溜车措施", "确认区域警示"]


def test_list_param_too_many_items_rejected():
    from models.visual import MAX_LIST_ITEMS, VisualSpec

    with pytest.raises(ValidationError):
        VisualSpec.model_validate(
            {
                "primitive": "checklist",
                "params": {"items": ["x"] * (MAX_LIST_ITEMS + 1)},
                "fallback_text": "超长列表。",
            }
        )


def test_list_param_item_too_long_rejected():
    from models.visual import MAX_LIST_ITEM_CHARS, VisualSpec

    with pytest.raises(ValidationError):
        VisualSpec.model_validate(
            {
                "primitive": "checklist",
                "params": {"items": ["x" * (MAX_LIST_ITEM_CHARS + 1)]},
                "fallback_text": "超长项。",
            }
        )


def test_list_param_rejects_markup():
    from models.visual import VisualSpec

    with pytest.raises(ValidationError):
        VisualSpec.model_validate(
            {
                "primitive": "checklist",
                "params": {"items": ["<script>alert(1)</script>"]},
                "fallback_text": "含标记。",
            }
        )


def test_list_param_rejects_objects():
    from models.visual import VisualSpec

    with pytest.raises(ValidationError):
        VisualSpec.model_validate(
            {
                "primitive": "checklist",
                "params": {"items": [{"text": "a"}]},
                "fallback_text": "嵌套对象。",
            }
        )


# ---------------------------------------------------------------- 合规：is_demo

def test_is_demo_false_rejected():
    """不允许产出"非演示"的作业依据——否则合规声明可被一个字段绕过。"""
    bad = deepcopy(SAMPLE)
    bad.setdefault("meta", {})["is_demo"] = False
    with pytest.raises(ValidationError) as exc:
        Guide.model_validate(bad)
    assert "is_demo" in str(exc.value)


def test_is_demo_defaults_true_when_omitted():
    data = deepcopy(SAMPLE)
    data.setdefault("meta", {}).pop("is_demo", None)
    assert Guide.model_validate(data).meta.is_demo is True


# ---------------------------------------------------------------- 合规：is_demo

def test_is_demo_false_rejected():
    """不允许产出"非演示"的作业依据——否则合规声明可被一个字段绕过。"""
    bad = deepcopy(SAMPLE)
    bad.setdefault("meta", {})["is_demo"] = False
    with pytest.raises(ValidationError) as exc:
        Guide.model_validate(bad)
    assert "is_demo" in str(exc.value)


def test_is_demo_defaults_true_when_omitted():
    data = deepcopy(SAMPLE)
    data.setdefault("meta", {}).pop("is_demo", None)
    assert Guide.model_validate(data).meta.is_demo is True


# ---------------------------------------------------------------- 溯源契约（决策 #11）

def test_source_type_defaults_to_text():
    guide = Guide.model_validate(SAMPLE)
    assert guide.meta.source_type == "text"


def test_source_type_accepts_image():
    data = deepcopy(SAMPLE)
    data["meta"]["source_type"] = "image"
    assert Guide.model_validate(data).meta.source_type == "image"


def test_source_type_rejects_unknown_value():
    bad = deepcopy(SAMPLE)
    bad["meta"]["source_type"] = "ocr"
    with pytest.raises(ValidationError):
        Guide.model_validate(bad)


def test_provenance_round_trips_on_step_and_criterion():
    data = deepcopy(SAMPLE)
    ref = {
        "asset_id": "a_0123456789abcdef",
        "bbox": [0.1, 0.2, 0.3, 0.4],
        "raw_text": "0.8 N·m",
        "flag": "suspect",
    }
    data["steps"][1]["provenance"] = ref
    data["steps"][1]["criteria"][0]["provenance"] = ref
    guide = Guide.model_validate(data)
    assert guide.steps[1].provenance.flag == "suspect"
    assert guide.steps[1].criteria[0].provenance.raw_text == "0.8 N·m"


def test_provenance_rejects_bbox_out_of_canvas():
    bad = deepcopy(SAMPLE)
    bad["steps"][1]["provenance"] = {
        "asset_id": "a_0123456789abcdef",
        "bbox": [0.9, 0.1, 0.3, 0.1],
    }
    with pytest.raises(ValidationError):
        Guide.model_validate(bad)


def test_provenance_rejects_unknown_flag():
    bad = deepcopy(SAMPLE)
    bad["steps"][1]["provenance"] = {
        "asset_id": "a_0123456789abcdef",
        "flag": "maybe",
    }
    with pytest.raises(ValidationError):
        Guide.model_validate(bad)


def test_llm_schema_hides_server_owned_fields():
    """模型看得到的 schema 不能含 provenance/source_type：它没有读图能力。"""
    from llm.prompts import output_schema

    dumped = json.dumps(output_schema(), ensure_ascii=False)
    assert "provenance" not in dumped
    assert "source_type" not in dumped
    assert "Provenance" not in dumped


# ---------------------------------------------------------------- 工位（计划 §2.1）

def test_station_is_optional_and_omitted_when_none():
    guide = Guide.model_validate(SAMPLE)
    assert guide.meta.station is None
    # None 不落盘：旧镜像的 extra="forbid" 不该被一个空字段判死
    assert "station" not in guide.model_dump(mode="json")["meta"]


def test_station_round_trips():
    data = deepcopy(SAMPLE)
    data["meta"]["station"] = "3 号车门"
    guide = Guide.model_validate(data)
    assert guide.meta.station == "3 号车门"
    assert guide.model_dump(mode="json")["meta"]["station"] == "3 号车门"
