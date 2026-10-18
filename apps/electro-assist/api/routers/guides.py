"""指导书读取：数据库优先，样例只在空库时 seed。

列表**只返回已发布**（决策 #16）：访客生成的草稿不进公开列表，但可通过
`GET /guides/{id}` 凭随机 id 直接访问——不枚举、不公开。

详情返回 `{status, guide}` 信封：前端需要知道"这份能不能对外"，
而 `status` 不属于指导书文档本身（Guide 模型是 `extra="forbid"` 的）。
"""
from __future__ import annotations

import re

from fastapi import APIRouter, HTTPException

from models.guide import SCHEMA_VERSION
from services import library

router = APIRouter(prefix="/api/electro/guides", tags=["guides"])

GUIDE_ID_RE = re.compile(r"^g_[a-z0-9_]{5,31}$")


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
