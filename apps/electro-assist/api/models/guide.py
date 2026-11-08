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
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .visual import VisualSpec

SCHEMA_VERSION = "1.2"
REQUIRED_DISCLAIMER = "演示数据 · 非实际作业依据"

# 素材 id 由上传接口分配（`a_` + 16 位十六进制）。这里只做格式校验，
# "这张图真的存在"必须在服务层查磁盘——模型不认识素材，也不该由它担保。
ASSET_ID_RE = r"^a_[0-9a-f]{16}$"


class Provenance(BaseModel):
    """一条判据"从哪儿来"的证据。

    为什么必须可选且由服务端填写：模型看不到图，也数不准行，让它输出 bbox 与
    `raw_text` 等于让它编。**生成阶段一律剥掉模型给的 provenance**（`llm/runner.py`），
    由 `services/generation.py` 在落库前用原文重新定位后回填——模型只负责内容，
    来源由服务端用可复现的方式算出来。

    两个锚点至少有一个，否则这条 provenance 没有意义（既不知道哪张图、
    也不知道第几行）：

    - `asset_id`：图片来源。**只有本次提交恰好 1 张图时才填**——多张图是合并
      转录的，行号归属不明，硬指一张就是编；
    - `line`：原文行号（0 基）。纯文本输入或图片多于 1 张时靠它。

    `bbox` 仍留在契约里但**当前恒为 None**：没有视觉服务返回坐标，保留了也只是
    一个"看起来有定位"的假象。等真接上 OCR 再说。

    `flag` 沿用三层校验的结论：ok（原文逐字命中）/ suspect（只对得上数值，
    句式被改写）/ unverified（指不回原文）。
    """

    model_config = ConfigDict(extra="forbid")

    asset_id: str | None = Field(default=None, pattern=ASSET_ID_RE)
    # 归一化到 0–1 的 [x, y, w, h]：原图尺寸不同，像素坐标没法跨设备复用。
    bbox: list[float] | None = Field(default=None, min_length=4, max_length=4)
    raw_text: str | None = Field(default=None, max_length=200)
    line: int | None = Field(default=None, ge=0, le=9999)
    confidence: float | None = Field(default=None, ge=0, le=1)
    flag: Literal["ok", "suspect", "unverified"] = "ok"

    @field_validator("bbox")
    @classmethod
    def _normalized_bbox(cls, value: list[float] | None) -> list[float] | None:
        if value is None:
            return value
        if any(not 0.0 <= number <= 1.0 for number in value):
            raise ValueError("bbox 必须是归一化到 0–1 的四个数 [x, y, w, h]")
        if value[0] + value[2] > 1.0001 or value[1] + value[3] > 1.0001:
            raise ValueError("bbox 超出画布范围")
        return value

    @model_validator(mode="after")
    def _needs_anchor(self) -> "Provenance":
        if self.asset_id is None and self.line is None:
            raise ValueError("provenance 至少要有一个锚点：asset_id 或 line")
        return self


class AssetRef(BaseModel):
    """一张用户自带的现场素材（截图/照片）。

    为什么没有 crop 字段：切图接口还在，但"选哪一块入稿"需要确认页，
    当前链路没做确认页，先只接整图。加字段容易，去掉错的数据难。
    """

    model_config = ConfigDict(extra="forbid")

    asset_id: str = Field(pattern=ASSET_ID_RE)
    caption: str = Field(min_length=2, max_length=60)

    @field_validator("caption")
    @classmethod
    def _plain_caption(cls, v: str) -> str:
        text = v.strip()
        if not text:
            raise ValueError("素材说明不能为空")
        if "<" in text or "javascript:" in text.lower():
            raise ValueError("素材说明含疑似标记内容")
        return text


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
    # 图片输入时指回原图位置；文本输入与旧数据为 None。
    provenance: Provenance | None = None

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
    # 用户自带的现场素材（照片/截图）。给模型看的 schema 里已剔除该字段，
    # 服务端在生成后填充；位置由人在草稿页决定。
    assets: list[AssetRef] = Field(default_factory=list, max_length=3)
    duration_s: int | None = Field(default=None, ge=1, le=7200)
    # 步骤级来源（图片输入时）。判据级 provenance 更精确，这一层用于
    # "整步都来自同一段原文"的场景，避免每个判据重复记一遍。
    provenance: Provenance | None = None

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
    # 工位：计划 §2.1 输入模板的字段。预检能解析、人工可改，模型不填。
    # 与 source_type 同理：None 时不落盘，旧镜像仍能读取文本来源的草稿。
    station: str | None = Field(
        default=None, max_length=60, exclude_if=lambda value: value is None
    )
    # 输入形态：文本粘贴 or 图片识别后回填。由服务端写入，模型不得决定。
    # text 时**不落盘**：旧版本（迁移 v8 之前）的 GuideMeta 是 extra="forbid"，
    # 多一个键就读不出草稿。默认值仍是 text，省略即等价。
    source_type: Literal["text", "image"] = Field(
        default="text", exclude_if=lambda value: value == "text"
    )
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
    # 还没归位的素材放这里，渲染成指导书末尾的「现场素材」区。
    # 归位（挂到某一步）由人来做，不是模型：见 PUT /guides/{id}/assets。
    assets: list[AssetRef] = Field(default_factory=list, max_length=6)
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
        # 同一张图在全文只能出现一次：重复引用会让编号错乱，打印出来还占两页。
        used = [a.asset_id for step in self.steps for a in step.assets]
        used += [a.asset_id for a in self.assets]
        if len(set(used)) != len(used):
            raise ValueError("同一素材在步骤与素材区之间不能重复引用")
        return self

    def publish_blockers(self) -> list[str]:
        """发布前必须补齐的项；空列表 = 可以发布（计划 §12.4）。

        草稿允许留空：原文没写判据时，生成端宁可留白也不替你编；草稿是给人改的。
        但**发布是最后一道闸门**——一条没有验收判据的步骤上线后，现场照着做却
        没有"做到什么程度算对"的依据，等于把判断责任推回给操作者。

        所以这条检查不放在模型校验里（那会把草稿也一起判死），而是单列一个方法，
        由 publish CLI、seed 与样例刷新三处共同调用。
        """
        return [
            f"{step.id}「{step.title}」没有验收判据"
            for step in self.steps
            if not step.criteria
        ]
