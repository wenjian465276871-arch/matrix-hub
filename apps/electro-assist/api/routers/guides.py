"""指导书读取与草稿素材归位。

列表**只返回已发布**（决策 #16）：访客生成的草稿不进公开列表，但可通过
`GET /guides/{id}` 凭随机 id 直接访问——不枚举、不公开。

`PUT /{id}/assets` 是唯一一个写草稿的入口，边界刻意收得很窄：
**只能重排已有素材的位置，不能改文字、判据、步骤**。
理由：判据是红线（改一个字就能把超差变合格），而图片归位是排版问题——
模型没看图，位置只能由人给。没有这个入口，上传的图永远只能躺在末尾。
"""
from __future__ import annotations

import os
import re

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from core import ratelimit
import store
from core.assets import ASSET_RE
from models.guide import SCHEMA_VERSION, AssetRef, Guide
from services import library

router = APIRouter(prefix="/api/electro/guides", tags=["guides"])

GUIDE_ID_RE = re.compile(r"^g_[a-z0-9_]{5,31}$")
STEP_ID_RE = re.compile(r"^s[0-9]{2}$")

MAX_ATTACH_ASSETS = 6
_attach_limiter: ratelimit.Limiter | None = None


def get_attach_limiter() -> ratelimit.Limiter:
    """归位会写库：不设限，一个脚本就能把演示站当草稿箱刷。"""
    global _attach_limiter
    if _attach_limiter is None:
        _attach_limiter = ratelimit.Limiter(
            per_hour=int(os.getenv("ATTACH_PER_HOUR", "30")),
            per_day=int(os.getenv("ATTACH_PER_DAY", "100")),
            site_per_day=int(os.getenv("ATTACH_SITE_PER_DAY", "500")),
        )
    return _attach_limiter


def reset_attach_limiter() -> None:
    """仅供测试：限流器是进程内单例。"""
    global _attach_limiter
    _attach_limiter = None


class AttachItem(BaseModel):
    asset_id: str = Field(pattern=ASSET_RE.pattern)
    caption: str = Field(min_length=2, max_length=60)
    # 不传 = 留在末尾「现场素材」区
    step_id: str | None = Field(default=None, pattern=STEP_ID_RE.pattern)


class AttachIn(BaseModel):
    assets: list[AttachItem] = Field(default_factory=list, max_length=MAX_ATTACH_ASSETS)


@router.get("")
def list_guides() -> dict:
    """列表只返回卡片字段，不返回全文——列表页不该拉几十 KB 的 steps。"""
    items = library.list_published(limit=50)
    return {"schema_version": SCHEMA_VERSION, "count": len(items), "items": items}


@router.get("/{guide_id}")
def get_guide(guide_id: str) -> dict:
    if not GUIDE_ID_RE.match(guide_id):
        raise HTTPException(status_code=404, detail={"code": "not_found"})
    found = library.get_detail(guide_id)
    if found is None:
        raise HTTPException(status_code=404, detail={"code": "not_found"})
    guide, status = found
    return {"status": status, "guide": guide}


@router.put("/{guide_id}/assets")
def put_assets(guide_id: str, body: AttachIn, request: Request) -> dict:
    if not GUIDE_ID_RE.match(guide_id):
        raise HTTPException(status_code=404, detail={"code": "not_found"})

    allowed, retry_after = get_attach_limiter().hit(ratelimit.client_ip(request))
    if not allowed:
        raise HTTPException(
            status_code=429,
            detail={
                "code": "rate_limited",
                "message": f"调整过于频繁，请在 {retry_after} 秒后重试",
                "retry_after": retry_after,
            },
            headers={"Retry-After": str(retry_after)},
        )

    row = store.get_guide(guide_id)
    if row is None:
        raise HTTPException(status_code=404, detail={"code": "not_found"})
    if row["status"] == "published":
        # 已发布内容一旦可改，之前分享出去的链接就变成了另一份东西。
        raise HTTPException(
            status_code=409,
            detail={"code": "published_locked", "message": "已发布的指导书不能调整素材"},
        )

    try:
        guide = Guide.model_validate(row["guide"])
    except Exception:  # noqa: BLE001 - 库里的 JSON 坏了是数据问题，不是请求问题
        raise HTTPException(
            status_code=409, detail={"code": "guide_invalid", "message": "草稿数据无法解析"}
        ) from None

    # 只允许重排**这份草稿里已有的**素材：传一个别人的 id 进来就等于越权挂图。
    known = [a.asset_id for step in guide.steps for a in step.assets]
    known += [a.asset_id for a in guide.assets]
    steps_by_id = {step.id: step for step in guide.steps}

    if known and not body.assets:
        # 空数组是"清空"，但清空后没有入口再加回来（归位只认已有素材）。
        # 与其让人误删到无法恢复，不如直接拒绝：要删图请重新生成。
        raise HTTPException(
            status_code=422,
            detail={
                "code": "assets_required",
                "message": "至少要保留一张素材；需要去掉全部图片请重新生成",
            },
        )

    for step in guide.steps:
        step.assets = []
    guide.assets = []

    for item in body.assets:
        if item.asset_id not in known:
            raise HTTPException(
                status_code=422,
                detail={"code": "unknown_asset", "message": "这份草稿里没有该素材"},
            )
        try:
            ref = AssetRef(asset_id=item.asset_id, caption=item.caption)
        except ValueError:
            raise HTTPException(
                status_code=422,
                detail={"code": "bad_caption", "message": "素材说明不能为空或包含标记内容"},
            ) from None
        if item.step_id is None:
            guide.assets.append(ref)
        else:
            step = steps_by_id.get(item.step_id)
            if step is None:
                raise HTTPException(
                    status_code=422,
                    detail={"code": "step_not_found", "message": f"没有编号为 {item.step_id} 的步骤"},
                )
            step.assets.append(ref)

    # 赋值不会重跑 model_validator，重复引用要在这里兜住。
    try:
        guide = Guide.model_validate(guide.model_dump(mode="json"))
    except Exception:
        raise HTTPException(
            status_code=422,
            detail={"code": "asset_duplicate", "message": "同一素材只能挂在一个位置"},
        ) from None

    guide.schema_version = SCHEMA_VERSION
    saved = store.save_guide(guide, status="draft")
    if saved.get("skipped"):
        raise HTTPException(
            status_code=409,
            detail={"code": "published_locked", "message": "已发布的指导书不能调整素材"},
        )
    return {
        "status": "draft",
        "guide_id": guide.id,
        "attached": sum(len(step.assets) for step in guide.steps),
        "loose": len(guide.assets),
    }
