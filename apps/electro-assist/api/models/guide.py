"""A2 领域模型：工艺文本 → 结构化作业指导书。

设计要点（与开发计划一致）：
- 判据分四类，数值区间可自动校验，其余只做提交校验或人工确认；
- 单位在生成端就规范到 ≤3 字符，超长直接拒绝（前端按 56px 兜底显示历史数据）；
- 步骤序号必须从 1 连续，避免前端分页/打印时错位；
- 每份指导书强制带演示声明，合规不可关闭。
"""
from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .visual import VisualSpec

SCHEMA_VERSION = "1.1"
REQUIRED_DISCLAIMER = "演示数据 · 非实际作业依据"


class System(str, Enum):
    door = "door"
    hvac = "hvac"
    pantograph = "pantograph"


class CriterionType(str, Enum):
    range = "range"      # 数值区间，可自动校验
    enum = "enum"        # 枚举选项
    text = "text"        # 文本/记录型，仅提交时校验
    manual = "manual"    # 人工确认


class Criterion(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(pattern=r"^[a-z0-9_]{2,32}$")
    label: str = Field(min_length=2, max_length=60)
    type: CriterionType
    unit: str | None = Field(default=None, max_length=3)
    min: float | None = None
    max: float | None = None
    options: list[str] | None = None

    @model_validator(mode="after")
    def _check_by_type(self) -> "Criterion":
        if self.type is CriterionType.range:
            if self.min is None or self.max is None:
                raise ValueError("range 判据必须同时给出 min 与 max")
            if self.min > self.max:
                raise ValueError("range 判据的 min 不能大于 max")
            if not self.unit:
                raise ValueError("range 判据必须有单位")
        elif self.type is CriterionType.enum:
            if not self.options or len(self.options) < 2:
                raise ValueError("enum 判据至少需要两个选项")
        else:
            if self.min is not None or self.max is not None:
                raise ValueError(f"{self.type.value} 判据不应带 min/max")
        return self


class Step(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(pattern=r"^s[0-9]{2}$")
    seq: int = Field(ge=1, le=99)
    title: str = Field(min_length=2, max_length=40)
    action: str = Field(min_length=4, max_length=600)
    safety: list[str] = Field(default_factory=list, max_length=5)
    tools: list[str] = Field(default_factory=list, max_length=8)
    criteria: list[Criterion] = Field(default_factory=list, max_length=8)
    figures: list[VisualSpec] = Field(default_factory=list, max_length=3)
    duration_s: int | None = Field(default=None, ge=1, le=7200)

    @field_validator("safety", "tools")
    @classmethod
    def _short_items(cls, v: list[str]) -> list[str]:
        for item in v:
            if len(item) > 40:
                raise ValueError("安全提示/工具项请控制在 40 字以内")
        return v

    @model_validator(mode="after")
    def _check_figures(self) -> "Step":
        # 结构在校验阶段已通过，这里补语义：参数键必须属于该原语的白名单。
        for fig in self.figures:
            fig.validate_against_primitive()
        return self


class GuideMeta(BaseModel):
    model_config = ConfigDict(extra="forbid")

    system: System
    source_note: str = Field(min_length=4, max_length=200, description="公开资料来源说明")
    model: str = Field(min_length=3, max_length=40)
    generated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    is_demo: bool = True

    @field_validator("is_demo")
    @classmethod
    def _enforce_demo(cls, v: bool) -> bool:
        """默认值 True 只覆盖"没写"的情况；显式写 false 必须被拒绝。

        合规铁律：本项目不产出可直接执行的作业依据。如果允许 false，
        「演示数据 · 非实际作业依据」这句声明就可以被一个字段绕过。
        """
        if v is not True:
            raise ValueError("meta.is_demo 必须为 true：本项目不产出可直接执行的作业依据")
        return True


class Guide(BaseModel):
    """一份完整的可视化作业指导书。"""

    model_config = ConfigDict(extra="forbid")

    schema_version: str = SCHEMA_VERSION
    id: str = Field(pattern=r"^g_[a-z0-9_]{5,31}$")
    title: str = Field(min_length=4, max_length=60)
    summary: str = Field(min_length=10, max_length=300)
    meta: GuideMeta
    steps: list[Step] = Field(min_length=1, max_length=30)
    disclaimers: list[str] = Field(default_factory=lambda: [REQUIRED_DISCLAIMER])

    @model_validator(mode="after")
    def _check_steps(self) -> "Guide":
        seqs = [s.seq for s in self.steps]
        if seqs != list(range(1, len(seqs) + 1)):
            raise ValueError(f"步骤序号必须从 1 连续递增，当前为 {seqs}")
        ids = [s.id for s in self.steps]
        if len(set(ids)) != len(ids):
            raise ValueError("步骤 id 重复")
        if REQUIRED_DISCLAIMER not in self.disclaimers:
            raise ValueError(f"必须包含声明：{REQUIRED_DISCLAIMER}")
        return self
