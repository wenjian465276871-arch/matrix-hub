"""指导书读取（只读 fixture 层）。

P1a-W1 的第一步：把已经通过契约测试的样例，变成前端真能拿到的数据。

为什么不让前端直接读静态 JSON：
- 那会绕开 `Guide` 校验。样例手改坏了，前端只会拿到脏数据，
  而不会看到一个明确的 4xx——问题会被推迟到渲染时才炸。
- 从这里换成 SQLite 查询时，路由签名不用变。这是"先渲染后生成"
  能成立的前提：渲染层从第一天就只依赖契约，不依赖数据来源。

缓存策略：按目录缓存解析结果，进程内只读一次。样例改动需重启（fixture 可接受）；
换成 DAO 后此缓存自然消失。
"""
from __future__ import annotations

import json
import logging
import os
import re
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import ValidationError

from models.guide import SCHEMA_VERSION, Guide

router = APIRouter(prefix="/api/electro/guides", tags=["guides"])
log = logging.getLogger("electro.guides")

GUIDE_ID_RE = re.compile(r"^g_[a-z0-9_]{5,31}$")

_cache: dict[str, Guide] | None = None
_cache_dir: Path | None = None


def guide_dir() -> Path:
    """运行时读取，便于测试注入。"""
    env = os.getenv("GUIDE_DIR")
    if env:
        return Path(env)
    return Path(__file__).resolve().parent.parent / "samples"


def reset_cache() -> None:
    global _cache, _cache_dir
    _cache = None
    _cache_dir = None


def load_all() -> dict[str, Guide]:
    global _cache, _cache_dir
    directory = guide_dir()
    if _cache is not None and _cache_dir == directory:
        return _cache

    guides: dict[str, Guide] = {}
    if directory.is_dir():
        for path in sorted(directory.glob("*.json")):
            try:
                raw = json.loads(path.read_text(encoding="utf-8"))
                guide = Guide.model_validate(raw)
            except (json.JSONDecodeError, ValidationError, OSError) as exc:
                # 单个样例坏掉不应该让整个列表 500：跳过并留日志，前端仍能看到其余样例。
                log.warning("跳过非法样例 %s：%s", path.name, exc)
                continue
            guides[guide.id] = guide

    _cache, _cache_dir = guides, directory
    return guides


@router.get("")
def list_guides() -> dict:
    """指导书列表。只返回卡片需要的字段，不返回全文——列表页不该拉几十 KB 的 steps。"""
    items = [
        {
            "id": g.id,
            "title": g.title,
            "summary": g.summary,
            "system": g.meta.system.value,
            "step_count": len(g.steps),
            "estimated_s": sum(s.duration_s or 0 for s in g.steps) or None,
            "generated_at": g.meta.generated_at.isoformat(),
            "is_demo": g.meta.is_demo,
            # 来源说明放在列表里：演示数据必须一眼可辨，不能等点进去才看到。
            "source_note": g.meta.source_note,
        }
        for g in sorted(load_all().values(), key=lambda x: x.meta.generated_at, reverse=True)
    ]
    return {"schema_version": SCHEMA_VERSION, "count": len(items), "items": items}


@router.get("/{guide_id}")
def get_guide(guide_id: str) -> dict:
    """按 id 取完整指导书。返回前已过 Guide 校验，前端可信任结构。"""
    if not GUIDE_ID_RE.match(guide_id):
        raise HTTPException(status_code=404, detail={"code": "not_found"})
    guide = load_all().get(guide_id)
    if guide is None:
        raise HTTPException(status_code=404, detail={"code": "not_found"})
    return guide.model_dump(mode="json")
