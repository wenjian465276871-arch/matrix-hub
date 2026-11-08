"""识别结果的逐条溯源（`trace`）：能指回原文第几行，就指；指不回去，就说指不回去。

这份测试守三件事：

1. `locate` 只在**真的能对上**时给行号——宁可返回 None，不许"差不多"；
2. `reconcile` 产出的 `trace.flag` 三态与内容校验一致，不会出现
   "标了 ok 但其实这段文字是模型改写的"；
3. 「内容对得上」与「能指到某一行」是两件独立的事。跨行太多导致定位不到时，
   即使 `verified=True` 也必须报 `unverified`——否则确认页会给一个假的行号。

反向验证：把 `_trace` 里的 `locate_by_numbers` 分支删掉，
`test_criterion_rephrased_is_suspect` 立刻红（suspect 退化成 unverified）。
另：`_trace` 原来有个 `exact` 参数想让"内容校验通过"才给 ok，删掉它测试全绿——
因为单行命中必然包含在 haystack 里，这个条件永远成立，是死参数，已移除。
"""
from __future__ import annotations

from llm.extract import ExtractFields, ExtractedStep, locate, locate_by_numbers, reconcile


def _fields(steps: list[dict], **kwargs) -> ExtractFields:
    return ExtractFields(steps=[ExtractedStep(**step) for step in steps], **kwargs)


# ---------------------------------------------------------------- locate


def test_locate_single_line() -> None:
    lines = ["工序：开关门试验", "1. 开关门各 3 次", "2. 开门时间 2.0–3.5s"]
    line, source = locate(lines, "开门时间 2.0-3.5s")
    assert line == 2
    assert source == "2. 开门时间 2.0–3.5s"


def test_locate_normalizes_fullwidth_and_space() -> None:
    """转录里是全角、模型输出是半角，必须能对上——否则每个数值都"指不回去"。"""
    lines = ["开门时间２.０～３.５ｓ"]
    line, _ = locate(lines, "开门时间 2.0~3.5s")
    assert line == 0


def test_locate_across_wrapped_lines() -> None:
    """工艺卡里一个步骤折成两行很常见，要能指到起始行。"""
    lines = ["1. 关闭车门并确认指示灯", "熄灭后再执行下一步"]
    line, source = locate(lines, "关闭车门并确认指示灯熄灭后再执行下一步")
    assert line == 0
    assert "熄灭后" in source


def test_locate_returns_none_when_rewritten() -> None:
    lines = ["1. 开关门各三次"]
    assert locate(lines, "反复开关车门三次以上") == (None, None)


def test_locate_rejects_empty() -> None:
    assert locate(["a"], None) == (None, None)
    assert locate(["a"], "   ") == (None, None)


def test_number_fallback_does_not_confuse_substring() -> None:
    """`"3.5" in "13.50"` 是 True——按子串找会把判据指到写着 13.5 的那一行。

    这类错指比"指不回去"更危险：人会照着 13.5 那行去核对，然后以为对上了。
    """
    lines = ["2. 关门力 13.5N 以下", "3. 开门时间 2.0–3.5s"]
    line, _ = locate_by_numbers(lines, "≤3.5s")
    assert line == 1


def test_number_fallback_picks_line_with_all_numbers() -> None:
    lines = ["范围 1.0–2.0s", "范围 2.0–3.5s"]
    line, _ = locate_by_numbers(lines, "2.0–3.5s")
    assert line == 1


# ---------------------------------------------------------------- trace 三态


def test_verbatim_action_is_ok() -> None:
    lines = ["1. 开关门各 3 次，开门时间 2.0–3.5s"]
    body = reconcile(lines, _fields([{"seq": 1, "action": "开关门各 3 次，开门时间 2.0–3.5s"}]), [])
    trace = body["fields"]["steps"][0]["trace"]
    assert trace["flag"] == "ok"
    assert trace["line"] == 0
    assert body["stats"]["located_steps"] == 1


def test_rewritten_action_is_suspect_not_ok() -> None:
    """内容被改写但模型给了有效行号：指到参考位置，**不是证据**。"""
    lines = ["1. 开关门各 3 次，开门时间 2.0–3.5s"]
    body = reconcile(
        lines,
        _fields([{"seq": 1, "action": "反复开关车门三次", "source_line": 0}]),
        [],
    )
    trace = body["fields"]["steps"][0]["trace"]
    assert body["fields"]["steps"][0]["verified"] is False
    assert trace["flag"] == "suspect"
    assert trace["line"] == 0
    assert body["stats"]["located_steps"] == 0


def test_out_of_range_hint_is_unverified() -> None:
    lines = ["1. 开关门各 3 次"]
    body = reconcile(lines, _fields([{"seq": 1, "action": "反复开关车门"}] ), [])
    trace = body["fields"]["steps"][0]["trace"]
    assert trace == {"line": None, "text": None, "flag": "unverified"}


def test_verified_but_not_locatable_is_unverified() -> None:
    """跨 4 行拼出来的内容：校验能过（haystack 包含），但指不到单一入口行。

    这时必须报 unverified——给它随便一个行号就是造假来源。
    """
    lines = ["第一句", "第二句", "第三句", "第四句"]
    body = reconcile(lines, _fields([{"seq": 1, "action": "第一句第二句第三句第四句"}]), [])
    step = body["fields"]["steps"][0]
    assert step["verified"] is True
    assert step["trace"]["flag"] == "unverified"
    assert step["trace"]["line"] is None


# ---------------------------------------------------------------- 判据溯源


def test_criterion_verbatim_is_ok() -> None:
    lines = ["1. 开关门各 3 次，开门时间 2.0–3.5s"]
    body = reconcile(
        lines,
        _fields([{"seq": 1, "action": "开关门各 3 次", "criterion": "2.0–3.5s"}]),
        [],
    )
    crit = body["fields"]["steps"][0]["criterion_trace"]
    assert crit["flag"] == "ok"
    assert crit["line"] == 0


def test_criterion_rephrased_is_suspect() -> None:
    """原图写「不大于 3.5s」，模型写成「≤3.5s」：数字有据，句式是改的。"""
    lines = ["1. 开门时间不大于 3.5s"]
    body = reconcile(
        lines,
        _fields([{"seq": 1, "action": "开门", "criterion": "≤3.5s"}]),
        [],
    )
    crit = body["fields"]["steps"][0]["criterion_trace"]
    assert crit["flag"] == "suspect"


def test_cleared_criterion_has_no_trace() -> None:
    """判据因数字缺失被清空时，不该再给它配一个"来源"。"""
    lines = ["1. 开门时间 2.0–3.5s"]
    body = reconcile(
        lines,
        _fields([{"seq": 1, "action": "开门", "criterion": "1.0–2.0s", "source_line": 0}]),
        [],
    )
    step = body["fields"]["steps"][0]
    assert step["criterion"] is None
    assert step["criterion_trace"] is None
