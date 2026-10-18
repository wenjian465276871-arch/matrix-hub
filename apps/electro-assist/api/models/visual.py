"""视觉 DSL：LLM 只输出"用哪个原语 + 什么参数"，具体 SVG 由前端渲染。

设计约束（见开发计划 §12.4 与 ADR 中"不做运行时代码生成"）：
- 原语是构建期固定的枚举，不在运行时新增；
- 参数只允许标量，禁止嵌套结构、URL、HTML；
- 每个图示必须带 fallback_text，渲染失败时降级为文字，保证现场可读。
"""
from __future__ import annotations

from enum import Enum
from typing import Union

from pydantic import BaseModel, ConfigDict, Field, field_validator

Scalar = Union[str, int, float, bool]


class Primitive(str, Enum):
    """P0/P1a 的原语集合。新增原语必须走"构建期扩展"流程，不在运行时放开。"""

    step_card = "step_card"          # 步骤卡：序号 + 动作 + 要点
    meter = "meter"                  # 仪表读数：数值 + 单位 + 量程
    status_light = "status_light"    # 状态灯：通过/注意/危险
    wiring = "wiring"                # 接线示意：端子编号 + 线色
    connector = "connector"          # 接插件：针脚编号 + 定义
    torque_gauge = "torque_gauge"    # 力矩扳手：目标值 + 公差
    checklist = "checklist"          # 检查清单：多条勾选项


# 每个原语允许的参数键。未列出的键一律拒绝，防止 LLM 塞任意内容。
_ALLOWED_PARAMS: dict[Primitive, set[str]] = {
    Primitive.step_card: {"index", "action", "hint", "icon"},
    Primitive.meter: {"value", "unit", "min", "max", "label"},
    Primitive.status_light: {"state", "label"},
    Primitive.wiring: {"terminals", "wire_color", "note"},
    Primitive.connector: {"pins", "note"},
    Primitive.torque_gauge: {"target", "tolerance", "unit"},
    Primitive.checklist: {"items"},
}

_STATE_VALUES = {"pass", "warn", "danger", "idle"}


def allowed_params() -> dict[str, list[str]]:
    """给 prompt 与 `/schema/visual` 共用，避免"文档说允许、代码拒绝"的漂移。"""
    return {p.value: sorted(keys) for p, keys in _ALLOWED_PARAMS.items()}


class VisualSpec(BaseModel):
    """一条图示声明。渲染器按 primitive 分发，参数做二次校验。"""

    model_config = ConfigDict(extra="forbid")

    primitive: Primitive
    params: dict[str, Scalar] = Field(default_factory=dict)
    caption: str | None = Field(default=None, max_length=60)
    fallback_text: str = Field(min_length=2, max_length=200)

    @field_validator("params")
    @classmethod
    def _check_params(cls, v: dict[str, Scalar]) -> dict[str, Scalar]:
        for key, val in v.items():
            if isinstance(val, str) and len(val) > 120:
                raise ValueError(f"参数 {key} 过长（>120 字符）")
            if isinstance(val, str) and ("<" in val or "javascript:" in val.lower()):
                raise ValueError(f"参数 {key} 含疑似标记内容，禁止进入渲染层")
        return v

    def validate_against_primitive(self) -> None:
        """按原语校验参数键与枚举值。schema 层只做结构，语义在这里。"""
        allowed = _ALLOWED_PARAMS[self.primitive]
        unknown = set(self.params) - allowed
        if unknown:
            raise ValueError(f"{self.primitive.value} 不支持参数: {sorted(unknown)}")
        if self.primitive is Primitive.status_light:
            state = self.params.get("state")
            if state not in _STATE_VALUES:
                raise ValueError(f"status_light.state 必须是 {sorted(_STATE_VALUES)}")
