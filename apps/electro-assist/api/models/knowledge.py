"""B 模块领域模型：故障知识条目。

条目是**人写的**，不是模型生成的——这是 B 模块与 A2 的关键区别。
模型可以编一条不存在的故障链，而现场照着编的链条去拆东西是要出事的。
所以知识库走"人工整理 + 公开资料改写"，检索只负责找，不负责想。
"""
from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field, field_validator

from .guide import System


class Check(BaseModel):
    """一条可执行的检查动作。顺序有意义：先电后机、先查后动。"""

    model_config = ConfigDict(extra="forbid")

    order: int = Field(ge=1, le=20)
    action: str = Field(min_length=4, max_length=120)
    expect: str = Field(min_length=2, max_length=120)


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
