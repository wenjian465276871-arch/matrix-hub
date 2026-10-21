"""B 模块领域模型：故障知识条目。

条目是**人写的**，不是模型生成的——这是 B 模块与 A2 的关键区别。
模型可以编一条不存在的故障链，而现场照着编的链条去拆东西是要出事的。
所以知识库走"人工整理 + 公开资料改写"，检索只负责找，不负责想。
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .guide import System


class Check(BaseModel):
    """一条可执行的检查动作。顺序有意义：先电后机、先查后动。

    2026-10-21 起支持两种检查：
    - `confirm`：现场判断正常/异常（默认，兼容旧知识库）；
    - `measure`：回填实测值，由服务端按 min/max 判定，供故障树收敛使用。

    `next` 是「本项通过后跳到第几项」，用于跳过不适用的分支；
    `on_fail` 是本项异常时的结论（原因 + 处置），不填则回退到条目级升级条件。
    """

    model_config = ConfigDict(extra="forbid")

    order: int = Field(ge=1, le=20)
    action: str = Field(min_length=4, max_length=120)
    expect: str = Field(min_length=2, max_length=120)
    kind: Literal["confirm", "measure"] = "confirm"
    unit: str | None = Field(default=None, max_length=3)
    min: float | None = None
    max: float | None = None
    next: int | None = Field(default=None, ge=1, le=20)
    on_fail: str | None = Field(default=None, max_length=200)

    @model_validator(mode="after")
    def _check_measure(self) -> "Check":
        if self.kind == "measure":
            if self.min is None or self.max is None:
                raise ValueError("measure 检查必须给出 min 与 max")
            if self.min > self.max:
                raise ValueError("measure 检查的 min 不能大于 max")
            if not self.unit:
                raise ValueError("measure 检查必须有单位")
        else:
            if self.min is not None or self.max is not None or self.unit is not None:
                raise ValueError("confirm 检查不应带 unit/min/max")
        if self.next is not None and self.next <= self.order:
            raise ValueError("next 必须指向后面的检查项")
        return self


class KnowledgeEntry(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(pattern=r"^kb_[a-z0-9_]{4,31}$")
    system: System
    title: str = Field(min_length=4, max_length=60)
    symptoms: list[str] = Field(min_length=2, max_length=8)
    keywords: list[str] = Field(min_length=2, max_length=12)
    likely_causes: list[str] = Field(min_length=2, max_length=6)
    checks: list[Check] = Field(min_length=2, max_length=8)
    escalation: str = Field(min_length=10, max_length=200)
    safety: str = Field(min_length=4, max_length=200)
    sources: list[str] = Field(default_factory=list, max_length=5)

    @field_validator("symptoms")
    @classmethod
    def _check_symptoms(cls, v: list[str]) -> list[str]:
        for item in v:
            if not 4 <= len(item) <= 80:
                raise ValueError("现象描述请控制在 4–80 字")
        return v

    @field_validator("keywords")
    @classmethod
    def _check_keywords(cls, v: list[str]) -> list[str]:
        for item in v:
            if not 2 <= len(item) <= 20:
                raise ValueError("关键词请控制在 2–20 字")
        return v

    @field_validator("likely_causes")
    @classmethod
    def _check_causes(cls, v: list[str]) -> list[str]:
        for item in v:
            if not 4 <= len(item) <= 80:
                raise ValueError("可能原因请控制在 4–80 字")
        return v

    @model_validator(mode="after")
    def _check_tree(self) -> "KnowledgeEntry":
        orders = [c.order for c in self.checks]
        if len(set(orders)) != len(orders):
            raise ValueError("检查项 order 不能重复")
        for check in self.checks:
            if check.next is not None and check.next not in orders:
                raise ValueError(f"检查项 {check.order} 的 next={check.next} 不存在")
        return self


class KnowledgeBase(BaseModel):
    model_config = ConfigDict(extra="forbid")

    version: str = Field(min_length=1, max_length=10)
    updated_at: str = Field(min_length=8, max_length=20)
    entries: list[KnowledgeEntry] = Field(min_length=1, max_length=100)


class EvalCase(BaseModel):
    model_config = ConfigDict(extra="forbid")

    query: str = Field(min_length=2, max_length=200)
    expect: str = Field(pattern=r"^kb_[a-z0-9_]{4,31}$")
    note: str = Field(default="", max_length=80)


class UncoveredCase(BaseModel):
    model_config = ConfigDict(extra="forbid")

    query: str = Field(min_length=2, max_length=200)
    why: str = Field(default="", max_length=80)


class EvalSet(BaseModel):
    """评测集与知识库放在一起：改了知识库就得同步改题，否则指标会骗人。"""

    model_config = ConfigDict(extra="forbid")

    version: str = Field(min_length=1, max_length=10)
    queries: list[EvalCase] = Field(min_length=1, max_length=50)
    uncovered: list[UncoveredCase] = Field(min_length=1, max_length=20)
