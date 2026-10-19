"""判据校验的单元测试。

这里只测"机器能确定的事"：数值区间、缺值、非法输入。
枚举/文本的语义判断刻意保守——选项里没有 expected 字段，系统不替人下结论。
"""
from __future__ import annotations

import math

import pytest

from models.guide import Criterion, Step
from services import criteria


def _range(**over):
    data = {
        "id": "open_time",
        "label": "开门时间",
        "type": "range",
        "min": 2.0,
        "max": 3.5,
        "unit": "s",
    }
    data.update(over)
    return Criterion.model_validate(data)


def _enum(**over):
    data = {
        "id": "pin_ok",
        "label": "端子核对",
        "type": "enum",
        "options": ["一致", "不一致"],
    }
    data.update(over)
    return Criterion.model_validate(data)


def _manual():
    return Criterion.model_validate({"id": "confirm_safe", "label": "安全确认", "type": "manual"})


def _step(*items: Criterion) -> Step:
    return Step(
        id="s01",
        seq=1,
        title="测试步骤",
        action="执行动作并记录数值。",
        criteria=list(items),
    )


@pytest.mark.parametrize("value", [2.0, 2.75, 3.5])
def test_range_inclusive_pass(value):
    result = criteria.evaluate(_range(), value)
    assert result.verdict == "pass"
    assert "内" in result.message


@pytest.mark.parametrize("value,side", [(1.9, "下限"), (3.6, "上限")])
def test_range_out_of_bounds_fails_with_side(value, side):
    result = criteria.evaluate(_range(), value)
    assert result.verdict == "fail"
    assert side in result.message
    assert "复测" in result.message


def test_range_rejects_bool_and_text():
    with pytest.raises(criteria.CriterionError) as info:
        criteria.evaluate(_range(), True)
    assert info.value.code == "invalid_value"

    with pytest.raises(criteria.CriterionError):
        criteria.evaluate(_range(), "3.0s")


def test_range_rejects_non_finite():
    with pytest.raises(criteria.CriterionError):
        criteria.evaluate(_range(), math.inf)


def test_enum_negative_option_is_fail():
    result = criteria.evaluate(_enum(), "不一致")
    assert result.verdict == "fail"
    assert "异常" in result.message


def test_enum_retest_option_is_warn():
    criterion = _enum(id="result", label="判定", options=["合格", "超差", "复测"])
    result = criteria.evaluate(criterion, "复测")
    assert result.verdict == "warn"
    assert "重新测量" in result.message


def test_enum_neutral_option_is_recorded_only():
    result = criteria.evaluate(_enum(), "一致")
    assert result.verdict == "manual"


def test_enum_rejects_option_outside_list():
    with pytest.raises(criteria.CriterionError):
        criteria.evaluate(_enum(), "大概一致")


def test_manual_requires_explicit_confirmation():
    with pytest.raises(criteria.CriterionError) as info:
        criteria.evaluate(_manual(), False)
    assert info.value.code == "manual_not_confirmed"

    assert criteria.evaluate(_manual(), True).verdict == "manual"


def test_text_rejects_empty():
    criterion = Criterion.model_validate(
        {"id": "note", "label": "备注", "type": "text"}
    )
    with pytest.raises(criteria.CriterionError):
        criteria.evaluate(criterion, "   ")
    assert criteria.evaluate(criterion, "外观正常").verdict == "manual"


def test_step_requires_every_criterion():
    step = _step(_range(), _enum())
    with pytest.raises(criteria.CriterionError) as info:
        criteria.evaluate_step(step, {"open_time": 3.0})
    assert info.value.code == "missing_criterion"
    assert info.value.criterion_id == "pin_ok"


def test_step_rejects_unknown_criterion():
    with pytest.raises(criteria.CriterionError) as info:
        criteria.evaluate_step(_step(_range()), {"open_time": 3.0, "oops": 1})
    assert info.value.code == "unknown_criterion"


def test_step_without_criteria_is_manual():
    verdict, results = criteria.evaluate_step(_step(), {})
    assert verdict == "manual"
    assert results == []


def test_step_overall_priority_fail_over_manual():
    step = _step(_range(), _enum(), _manual())
    verdict, results = criteria.evaluate_step(
        step, {"open_time": 9.0, "pin_ok": "一致", "confirm_safe": True}
    )
    assert verdict == "fail"
    assert {r.verdict for r in results} == {"fail", "manual"}
