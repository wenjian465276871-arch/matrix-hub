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

SAMPLE = json.loads((Path(__file__).parent.parent / "samples" / "door_clearance.json").read_text(encoding="utf-8"))


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
