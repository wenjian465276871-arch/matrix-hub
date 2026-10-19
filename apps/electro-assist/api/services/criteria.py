"""判据校验：只做"这台机器能确定的事"。

边界刻意划得很清楚：

- **range** 自动判定：在区间内 `pass`，超出 `fail`；
- **enum / text** 只记录，不猜"哪个选项才算合格"——schema 里没有 expected 字段，
  猜错一次就是把人往错误方向推。唯一的例外是选项本身带明确评价：
  命中否定词判 `fail`，命中"复测"判 `warn`（宁可疑，不可放过）；
- **manual** 必须显式确认，没勾就是没做；
- 任何判据缺值都拒绝提交，不替用户填默认值。

结果里的 `message` 是给现场看的一句话：哪里、多少、要求多少。
"""
from __future__ import annotations

import math
from dataclasses import asdict, dataclass
from typing import Any

from models.guide import Criterion, CriterionType, Step

# 选项本身就是结论时，保守地判异常；不在表里的选项一律按"已记录"处理。
NEGATIVE_OPTIONS = {
    "不一致",
    "超差",
    "异常",
    "不合格",
    "否",
    "失败",
    "未通过",
    "不符合",
    "超限",
    "松动",
    "渗漏",
    "报警",
}
RETEST_OPTIONS = {"复测", "需复测", "重新测量", "待复测"}

MANUAL_TRUE = {"1", "true", "yes", "on", "确认", "已确认"}


class CriterionError(ValueError):
    def __init__(self, code: str, message: str, criterion_id: str | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.criterion_id = criterion_id


@dataclass
class Result:
    criterion_id: str
    label: str
    type: str
    value: Any
    unit: str | None
    verdict: str
    message: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _fmt(value: float) -> str:
    return f"{value:.6g}"


def _range(criterion: Criterion, value: Any) -> Result:
    if isinstance(value, bool):
        raise CriterionError("invalid_value", f"「{criterion.label}」需要一个数值", criterion.id)
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise CriterionError(
            "invalid_value", f"「{criterion.label}」需要一个数值，收到 {value!r}", criterion.id
        ) from None
    if not math.isfinite(number):
        raise CriterionError("invalid_value", f"「{criterion.label}」的数值无效", criterion.id)

    low, high = float(criterion.min), float(criterion.max)  # type: ignore[arg-type]
    unit = criterion.unit or ""
    measured = f"{_fmt(number)} {unit}".strip()
    if low <= number <= high:
        return Result(
            criterion.id,
            criterion.label,
            criterion.type.value,
            number,
            criterion.unit,
            "pass",
            f"在 {_fmt(low)}–{_fmt(high)} {unit} 内（实测 {measured}）",
        )
    side = "上限" if number > high else "下限"
    bound = high if number > high else low
    return Result(
        criterion.id,
        criterion.label,
        criterion.type.value,
        number,
        criterion.unit,
        "fail",
        f"实测 {measured} 超出{side} {_fmt(bound)} {unit}，请复测",
    )


def _enum(criterion: Criterion, value: Any) -> Result:
    text = str(value).strip()
    options = criterion.options or []
    if text not in options:
        raise CriterionError(
            "invalid_value",
            f"「{criterion.label}」只能选择：{' / '.join(options)}",
            criterion.id,
        )
    if text in NEGATIVE_OPTIONS:
        verdict, message = "fail", f"记录为「{text}」，判定异常"
    elif text in RETEST_OPTIONS:
        verdict, message = "warn", f"记录为「{text}」，需要重新测量"
    else:
        verdict, message = "manual", f"已记录「{text}」"
    return Result(
        criterion.id,
        criterion.label,
        criterion.type.value,
        text,
        None,
        verdict,
        message,
    )


def _text(criterion: Criterion, value: Any) -> Result:
    if not isinstance(value, str) or not value.strip():
        raise CriterionError("invalid_value", f"「{criterion.label}」不能为空", criterion.id)
    text = value.strip()
    if len(text) > 500:
        raise CriterionError("invalid_value", f"「{criterion.label}」请控制在 500 字以内", criterion.id)
    return Result(
        criterion.id,
        criterion.label,
        criterion.type.value,
        text,
        None,
        "manual",
        "已记录",
    )


def _manual(criterion: Criterion, value: Any) -> Result:
    confirmed = value is True or (
        isinstance(value, str) and value.strip().lower() in MANUAL_TRUE
    )
    if not confirmed:
        raise CriterionError(
            "manual_not_confirmed", f"「{criterion.label}」需要人工确认后才能提交", criterion.id
        )
    return Result(
        criterion.id,
        criterion.label,
        criterion.type.value,
        True,
        None,
        "manual",
        "已人工确认",
    )


def evaluate(criterion: Criterion, value: Any) -> Result:
    if criterion.type is CriterionType.range:
        return _range(criterion, value)
    if criterion.type is CriterionType.enum:
        return _enum(criterion, value)
    if criterion.type is CriterionType.text:
        return _text(criterion, value)
    return _manual(criterion, value)


def evaluate_step(step: Step, values: dict[str, Any]) -> tuple[str, list[Result]]:
    known = {c.id for c in step.criteria}
    unknown = set(values) - known
    if unknown:
        raise CriterionError("unknown_criterion", f"未知判据：{sorted(unknown)[0]}")

    results: list[Result] = []
    for criterion in step.criteria:
        if criterion.id not in values:
            raise CriterionError(
                "missing_criterion",
                f"缺少「{criterion.label}」的实测值",
                criterion.id,
            )
        results.append(evaluate(criterion, values[criterion.id]))

    if not results:
        return "manual", results

    verdicts = {r.verdict for r in results}
    if "fail" in verdicts:
        return "fail", results
    if "warn" in verdicts:
        return "warn", results
    if "manual" in verdicts:
        return "manual", results
    return "pass", results
