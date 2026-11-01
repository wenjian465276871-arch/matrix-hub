"""草稿修正与界面发布（计划 §3.5 的 `publish` 端点 ＋ UX §8 的「草稿修正」）。

**为什么现在能做**：决策 #16 拒绝的是「没有鉴权的后台」，不是「发布入口」。
本站已经有口令通道（决策 #21）：`POST /passcode/verify` 换 12h HMAC 令牌。
发布就用这把钥匙，不新建一套权限体系——一个演示站不需要第二个身份。

三条边界，缺一条都会把「修正」变成「篡改」：

1. **只改文字，不改结构**。步骤 id 序列必须与库里完全一致：增删步骤会让
   `records.step_id` 指向不存在的步骤，历史作业记录直接拼不出来。
2. **判据可以改值，不能删干净**。规则是「发布时每步必须有判据」，不是
   「每步必须有 N 条」；但把唯一一条删掉，发布闸门会拦，所以不额外禁止。
3. **已发布不可改**。`save_guide` 的 upsert 已经有这道墙（`WHERE status != 'published'`），
   这里再拦一次：让人看到 409，而不是"保存成功但内容没变"。
"""
from __future__ import annotations

from typing import Any

from models.guide import SCHEMA_VERSION, Criterion, Guide
from pydantic import BaseModel, ConfigDict, Field, ValidationError

import store


class RevisionRejected(Exception):
    """改不了的原因。`code` 直接进 HTTP 错误的 detail。"""

    def __init__(self, code: str, message: str, *, status: int = 422, extra: dict | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.extra = extra or {}


class CriterionPatch(BaseModel):
    """判据的可改字段。`type` 与 `id` 不可改：换类型等于换判定逻辑。

    `range` 改 min/max 时不会自动改 unit——把「2.0–3.5 s」改成「2.0–3.5 mm」
    是另一个判据了，应该重新生成，不该在修正界面上顺手改掉。
    """

    model_config = ConfigDict(extra="forbid")

    id: str = Field(pattern=r"^[a-z0-9_]{2,32}$")
    label: str | None = Field(default=None, min_length=2, max_length=60)
    unit: str | None = Field(default=None, max_length=3)
    min: float | None = None
    max: float | None = None
    options: list[str] | None = Field(default=None, max_length=12)


class StepPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(pattern=r"^s[0-9]{2}$")
    title: str | None = Field(default=None, min_length=2, max_length=40)
    action: str | None = Field(default=None, min_length=4, max_length=600)
    criteria: list[CriterionPatch] | None = Field(default=None, max_length=8)


class GuidePatch(BaseModel):
    """整份修正请求。全部字段可选：只传改过的部分，没传的原样保留。

    `steps` 也允许**部分提交**（只发改动的那几步），匹配按 `id` 而不是按位置。
    早期想法是"必须全量"，理由是怕把 A 步的判据写到 B 步上——但按 id 匹配
    根本没有位置这回事，全量要求只会让前端把没改的步骤也回传一遍，
    回传过程中任何一个字段序列化差异都会变成一次静默覆盖。
    真正要防的是**传了不存在的步骤**与**重复 id**，这两条在下面校验。
    """

    model_config = ConfigDict(extra="forbid")

    title: str | None = Field(default=None, min_length=4, max_length=60)
    summary: str | None = Field(default=None, min_length=10, max_length=300)
    steps: list[StepPatch] | None = Field(default=None, max_length=30)


def _load_draft(guide_id: str) -> tuple[dict[str, Any], Guide]:
    row = store.get_guide(guide_id)
    if row is None:
        raise RevisionRejected("not_found", "指导书不存在", status=404)
    if row["status"] == "published":
        raise RevisionRejected(
            "published_locked",
            "已发布的指导书不能修改：分享出去的链接不能变成另一份内容",
            status=409,
        )
    try:
        guide = Guide.model_validate(row["guide"])
    except ValidationError:
        raise RevisionRejected(
            "guide_invalid", "草稿数据无法解析，请重新生成", status=409
        ) from None
    return row, guide


def apply_patch(guide_id: str, patch: GuidePatch) -> Guide:
    """把修正写回草稿。返回校验通过后的新版 Guide。"""
    row, guide = _load_draft(guide_id)
    data = guide.model_dump(mode="json")

    if patch.title is not None:
        data["title"] = patch.title
    if patch.summary is not None:
        data["summary"] = patch.summary

    if patch.steps is not None:
        existing = {step["id"]: step for step in data["steps"]}
        seen: set[str] = set()
        for step_patch in patch.steps:
            if step_patch.id not in existing:
                raise RevisionRejected(
                    "step_unknown",
                    f"这份草稿里没有编号为 {step_patch.id} 的步骤；增删步骤请重新生成",
                )
            if step_patch.id in seen:
                raise RevisionRejected("step_duplicate", f"步骤 {step_patch.id} 重复提交")
            seen.add(step_patch.id)
            target = existing[step_patch.id]
            if step_patch.title is not None:
                target["title"] = step_patch.title
            if step_patch.action is not None:
                target["action"] = step_patch.action
            if step_patch.criteria is not None:
                known = {item["id"]: item for item in target.get("criteria", [])}
                incoming_ids = [item.id for item in step_patch.criteria]
                unknown = [cid for cid in incoming_ids if cid not in known]
                if unknown:
                    raise RevisionRejected(
                        "criterion_unknown",
                        f"{step_patch.id} 里没有判据 {'/'.join(unknown)}；"
                        "修正只能改已有判据的值，新增判据请重新生成",
                    )
                merged: list[dict[str, Any]] = []
                for item in step_patch.criteria:
                    base = dict(known[item.id])
                    if item.label is not None:
                        base["label"] = item.label
                    # 单位与上下限只在 range 判据上有意义；其他类型传了也不写，
                    # 否则 Criterion 的类型校验会直接把整份草稿判死。
                    if base.get("type") == "range":
                        if item.unit is not None:
                            base["unit"] = item.unit
                        if item.min is not None:
                            base["min"] = item.min
                        if item.max is not None:
                            base["max"] = item.max
                    elif base.get("type") == "enum" and item.options is not None:
                        base["options"] = [opt.strip() for opt in item.options if opt.strip()]
                    merged.append(base)
                # 只改被点名的判据：没出现在 patch 里的判据保持原样（顺序也不动），
                # 这样前端少传一个字段不会把另一条判据悄悄删掉。
                target["criteria"] = [
                    next((m for m in merged if m["id"] == item["id"]), item)
                    for item in target.get("criteria", [])
                ]

    data["schema_version"] = SCHEMA_VERSION
    try:
        revised = Guide.model_validate(data)
    except ValidationError as exc:
        raise RevisionRejected(
            "invalid_after_patch", _first_error(exc), status=422
        ) from None

    saved = store.save_guide(revised, status="draft")
    if saved.get("skipped"):
        # 校验与写入之间被发布（CLI 或另一个标签页）：宁可报冲突，不覆盖。
        raise RevisionRejected(
            "published_locked", "这份指导书刚被发布，修正已取消", status=409
        )
    return revised


def publish(guide_id: str) -> dict[str, Any]:
    """发布草稿。闸门与 CLI 完全一致：调 `Guide.publish_blockers()`，不另写一套。"""
    row, guide = _load_draft(guide_id)
    blockers = guide.publish_blockers()
    if blockers:
        raise RevisionRejected(
            "publish_blocked",
            f"还有 {len(blockers)} 步没有验收判据，补齐后才能发布",
            status=409,
            extra={"blockers": blockers},
        )
    if not store.publish_guide(guide_id):
        raise RevisionRejected("publish_failed", "发布失败，请稍后重试", status=500)
    fresh = store.get_guide(guide_id) or {}
    return {
        "status": "published",
        "guide_id": guide_id,
        "published_at": fresh.get("published_at"),
    }


def _first_error(exc: ValidationError) -> str:
    """把 pydantic 的错误压成一句人话。前端只需要知道「哪里不对」。"""
    errors = exc.errors()
    if not errors:
        return "修正后的内容未通过校验"
    first = errors[0]
    location = ".".join(str(part) for part in first.get("loc", ()) if part != "steps")
    message = first.get("msg", "校验失败")
    return f"{location or '内容'}：{message}"
