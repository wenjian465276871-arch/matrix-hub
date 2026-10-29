"""视觉 DSL：LLM 只输出"用哪个原语 + 什么参数"，具体 SVG 由前端渲染。

设计约束（见开发计划 §12.4 与 ADR 中"不做运行时代码生成"）：
- 原语是构建期固定的枚举，不在运行时新增；
- 参数只允许标量或「字符串列表」，禁止嵌套对象、URL、HTML；
- 每个图示必须带 fallback_text，渲染失败时降级为文字，保证现场可读。

为什么参数允许字符串列表（2026-10-18 放宽，决策 #15）：
批量评测 5 份语料，3 份被拒，错误全是 `params.items` 传了数组。
清单类参数（items / terminals / pins）的本质就是列表，只允许标量等于
逼模型把列表编码成 `a|b|c` 这种带分隔符的字符串——它靠 JSON Schema 看不出这个约定，
只能靠散文提示，稳定性差。这不是模型的错，是契约不自然。
列表仍是强校验的：条数 ≤10、每项 ≤40 字、禁止标记内容。安全性没有放松。
"""
from __future__ import annotations

from enum import Enum
from typing import Union

from pydantic import BaseModel, ConfigDict, Field, field_validator

Scalar = Union[str, int, float, bool]
# 列表只允许「字符串列表」，不允许对象/嵌套，避免参数变成任意结构。
ParamValue = Union[Scalar, list[str]]

MAX_LIST_ITEMS = 10
MAX_LIST_ITEM_CHARS = 40
# 列表只允许「字符串列表」，不允许对象/嵌套，避免参数变成任意结构。
ParamValue = Union[Scalar, list[str]]

MAX_LIST_ITEMS = 10
MAX_LIST_ITEM_CHARS = 40


class Primitive(str, Enum):
    """P0/P1a 的原语集合。新增原语必须走"构建期扩展"流程，不在运行时放开。"""

    step_card = "step_card"          # 步骤卡：序号 + 动作 + 要点
    meter = "meter"                  # 仪表读数：数值 + 单位 + 量程
    status_light = "status_light"    # 状态灯：通过/注意/危险
    wiring = "wiring"                # 接线示意：端子编号 + 线色
    connector = "connector"          # 接插件：针脚编号 + 定义
    torque_gauge = "torque_gauge"    # 力矩扳手：目标值 + 公差
    checklist = "checklist"          # 检查清单：多条勾选项
    motion_timeline = "motion_timeline"  # 运动时序：分段动作 + 时间
    flow_arrow = "flow_arrow"            # 流程箭头：前后依赖的操作序列
    callout = "callout"                  # 气泡标注：单点强调
    gate_state = "gate_state"            # 开关/闸门状态：开/半开/关
    table = "table"                      # 表格：表头 + 行（竖线分隔单元格）
    annotation = "annotation"            # 标注示意图：编号点 + 图例


# 每个原语允许的参数键。未列出的键一律拒绝，防止 LLM 塞任意内容。
_ALLOWED_PARAMS: dict[Primitive, set[str]] = {
    Primitive.step_card: {"index", "action", "hint", "icon"},
    Primitive.meter: {"value", "unit", "min", "max", "label"},
    Primitive.status_light: {"state", "label"},
    Primitive.wiring: {"terminals", "wire_color", "note"},
    Primitive.connector: {"pins", "note"},
    Primitive.torque_gauge: {"target", "tolerance", "unit"},
    Primitive.checklist: {"items"},
    Primitive.motion_timeline: {"steps", "total", "label"},
    Primitive.flow_arrow: {"steps", "label"},
    Primitive.callout: {"target", "note", "position"},
    Primitive.gate_state: {"state", "label", "note"},
    Primitive.table: {"headers", "rows", "label"},
    Primitive.annotation: {"title", "points", "note"},
}

# 必填参数：缺了就不是"降级成文字"，而是渲染出一张没有信息量的空图。
# 校验放在服务端，模型才会收到明确的拒绝理由去补。
_REQUIRED_PARAMS: dict[Primitive, set[str]] = {
    Primitive.motion_timeline: {"steps"},
    Primitive.flow_arrow: {"steps"},
    Primitive.callout: {"target", "note"},
    Primitive.gate_state: {"state"},
    Primitive.table: {"headers", "rows"},
    Primitive.annotation: {"points"},
}

# 公开给 prompt 使用：枚举值只在这里定义一次，避免"文档写一套、校验另一套"。
STATE_VALUES = ("pass", "warn", "danger", "idle")
GATE_STATES = ("open", "closed", "half")
CALLOUT_POSITIONS = ("left", "right", "top", "bottom")


def allowed_params() -> dict[str, list[str]]:
    """给 prompt 与 `/schema/visual` 共用，避免"文档说允许、代码拒绝"的漂移。"""
    return {p.value: sorted(keys) for p, keys in _ALLOWED_PARAMS.items()}


class VisualSpec(BaseModel):
    """一条图示声明。渲染器按 primitive 分发，参数做二次校验。"""

    model_config = ConfigDict(extra="forbid")

    primitive: Primitive
    params: dict[str, ParamValue] = Field(default_factory=dict)
    caption: str | None = Field(default=None, max_length=60)
    fallback_text: str = Field(min_length=2, max_length=200)

    @field_validator("params")
    @classmethod
    def _check_params(cls, v: dict[str, ParamValue]) -> dict[str, ParamValue]:
        for key, val in v.items():
            if isinstance(val, list):
                if len(val) > MAX_LIST_ITEMS:
                    raise ValueError(f"参数 {key} 列表过长（>{MAX_LIST_ITEMS} 项）")
                for item in val:
                    if not isinstance(item, str):
                        raise ValueError(f"参数 {key} 的列表只能包含字符串")
                    if len(item) > MAX_LIST_ITEM_CHARS:
                        raise ValueError(f"参数 {key} 的列表项过长（>{MAX_LIST_ITEM_CHARS} 字）")
                    if "<" in item or "javascript:" in item.lower():
                        raise ValueError(f"参数 {key} 的列表项含疑似标记内容")
                continue
            if isinstance(val, str) and len(val) > 120:
                raise ValueError(f"参数 {key} 过长（>120 字符）")
            if isinstance(val, str) and ("<" in val or "javascript:" in val.lower()):
                raise ValueError(f"参数 {key} 含疑似标记内容，禁止进入渲染层")
        return v

    def validate_against_primitive(self) -> None:
        """按原语校验参数键、必填项与枚举值。schema 层只做结构，语义在这里。"""
        allowed = _ALLOWED_PARAMS[self.primitive]
        unknown = set(self.params) - allowed
        if unknown:
            raise ValueError(f"{self.primitive.value} 不支持参数: {sorted(unknown)}")

        missing = _REQUIRED_PARAMS.get(self.primitive, set()) - set(self.params)
        if missing:
            raise ValueError(f"{self.primitive.value} 缺少必填参数: {sorted(missing)}")

        if self.primitive is Primitive.status_light:
            state = self.params.get("state")
            if state not in STATE_VALUES:
                raise ValueError(f"status_light.state 必须是 {sorted(STATE_VALUES)}")

        if self.primitive is Primitive.gate_state:
            state = self.params.get("state")
            if state not in GATE_STATES:
                raise ValueError(f"gate_state.state 必须是 {sorted(GATE_STATES)}")

        if self.primitive is Primitive.callout:
            position = self.params.get("position", "right")
            if position not in CALLOUT_POSITIONS:
                raise ValueError(f"callout.position 必须是 {sorted(CALLOUT_POSITIONS)}")

        if self.primitive is Primitive.motion_timeline:
            steps = self.params.get("steps")
            if not isinstance(steps, list) or not 2 <= len(steps) <= 6:
                raise ValueError("motion_timeline.steps 必须是 2–6 项的字符串数组")

        if self.primitive is Primitive.flow_arrow:
            steps = self.params.get("steps")
            if not isinstance(steps, list) or not 2 <= len(steps) <= 5:
                raise ValueError("flow_arrow.steps 必须是 2–5 项的字符串数组")

        if self.primitive is Primitive.annotation:
            points = self.params.get("points")
            if not isinstance(points, list) or not 1 <= len(points) <= 6:
                raise ValueError("annotation.points 必须是 1–6 项的字符串数组")

        if self.primitive is Primitive.table:
            headers = self.params.get("headers")
            rows = self.params.get("rows")
            if not isinstance(headers, list) or not 2 <= len(headers) <= 4:
                raise ValueError("table.headers 必须是 2–4 项的字符串数组")
            if not isinstance(rows, list) or not 1 <= len(rows) <= 10:
                raise ValueError("table.rows 必须是 1–10 项的字符串数组")
            for row in rows:
                # 行列不齐是表格最典型的模型错误：多给一列会被画到边界外，
                # 少给一列会让后面的值整体左移，现场读到的就是错的标准。
                if not isinstance(row, str) or len(row.split("|")) != len(headers):
                    raise ValueError(
                        f"table.rows 每行必须用 | 分成 {len(headers)} 格，与 headers 对齐"
                    )
