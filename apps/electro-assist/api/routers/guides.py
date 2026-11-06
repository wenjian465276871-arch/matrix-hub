"""指导书读取、草稿修正与发布。

列表**只返回已发布**（决策 #16）：访客生成的草稿不进公开列表，但可通过
`GET /guides/{id}` 凭随机 id 直接访问——不枚举、不公开。

写入口有三个，边界各自不同：

- `PUT /{id}/assets`：**只改图放哪**，不改文字与判据（判据改一个字就能把超差变合格）；
- `PATCH /{id}`：改文字与判据**值**，不能增删步骤、不能换判据类型（决策 #35）；
- `POST /{id}/publish`：用口令令牌换发布，闸门与 CLI 同一个 `publish_blockers()`。

后两个是 2026-11-01 补的：此前「补齐必填字段后对外」只存在于计划文本里，
线上要发布只能 SSH 进容器敲 CLI。
"""
from __future__ import annotations

import logging
import os
import re

from fastapi import APIRouter, Header, HTTPException, Query, Request
from pydantic import BaseModel, Field

from core import passcode, ratelimit
import store
from core.assets import ASSET_RE
from models.guide import SCHEMA_VERSION, AssetRef, Guide
from services import library, revision

router = APIRouter(prefix="/api/electro/guides", tags=["guides"])

log = logging.getLogger("electro.guides")

GUIDE_ID_RE = re.compile(r"^g_[a-z0-9_]{5,31}$")
STEP_ID_RE = re.compile(r"^s[0-9]{2}$")

MAX_ATTACH_ASSETS = 6
# 搜索词上限：列表页的输入框，没人会输入 200 字；给个上限避免超长 LIKE 扫全表。
MAX_QUERY_CHARS = 40
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


_write_limiter: ratelimit.Limiter | None = None


def get_write_limiter() -> ratelimit.Limiter:
    """修正与发布共用一把闸。

    发布天然幂等（第二次是 409），限流防的不是重复发布，而是**令牌泄露后
    批量改草稿**：改一份草稿就是改一份别人分享出去的页面。
    """
    global _write_limiter
    if _write_limiter is None:
        _write_limiter = ratelimit.Limiter(
            per_hour=int(os.getenv("REVISE_PER_HOUR", "20")),
            per_day=int(os.getenv("REVISE_PER_DAY", "60")),
            site_per_day=int(os.getenv("REVISE_SITE_PER_DAY", "300")),
        )
    return _write_limiter


def reset_write_limiter() -> None:
    """仅供测试。"""
    global _write_limiter
    _write_limiter = None


class AttachItem(BaseModel):
    asset_id: str = Field(pattern=ASSET_RE.pattern)
    caption: str = Field(min_length=2, max_length=60)
    # 不传 = 留在末尾「现场素材」区
    step_id: str | None = Field(default=None, pattern=STEP_ID_RE.pattern)


class AttachIn(BaseModel):
    assets: list[AttachItem] = Field(default_factory=list, max_length=MAX_ATTACH_ASSETS)


@router.get("")
def list_guides(
    limit: int = Query(library.PAGE_SIZE, ge=1, le=library.MAX_PAGE_SIZE),
    offset: int = Query(0, ge=0),
    q: str = Query("", max_length=MAX_QUERY_CHARS),
) -> dict:
    """列表只返回卡片字段，不返回全文——列表页不该拉几十 KB 的 steps。

    分页口径（计划 §12.6）：每页 12、`offset` 翻页、`has_more` 由总数决定。
    不用「下一页游标」：指导书是只增不改的展示内容，跳过一两条的代价远小于
    多维护一套游标签名。

    `q` 是卡片字段的子串搜索（UX §8 登记的欠账）。空串等于不过滤；
    搜索命中数就是 `total`，前端「共 N 份」直接可用。
    """
    # ------------------------------------------------------------------
    # C2 回滚演练（2026-11-06，验完立即 revert）
    #
    # 只在 APP_ENV=prod 触发：单测与 E2E 都跑在 dev 下，测不到这一条——
    # 这正好模拟"环境相关 bug"这种单测永远抓不到、只有生产会炸的形态。
    # 部署脚本的 probe_business 第一条就打这个端点，必然失败 → 触发自动回滚。
    # ------------------------------------------------------------------
    if os.getenv("APP_ENV", "").strip().lower() == "prod":
        raise HTTPException(status_code=500, detail={"code": "c2_rollback_drill"})

    term = q.strip()
    items = library.list_published(limit=limit, offset=offset, query=term or None)
    total = library.count_published(query=term or None)
    return {
        "schema_version": SCHEMA_VERSION,
        "count": len(items),
        "total": total,
        "has_more": offset + len(items) < total,
        "limit": limit,
        "offset": offset,
        "query": term,
        "items": items,
    }


@router.get("/{guide_id}")
def get_guide(guide_id: str) -> dict:
    if not GUIDE_ID_RE.match(guide_id):
        raise HTTPException(status_code=404, detail={"code": "not_found"})
    found = library.get_detail(guide_id)
    if found is None:
        raise HTTPException(status_code=404, detail={"code": "not_found"})
    guide, status, process_id = found
    return {"status": status, "guide": guide, "process_id": process_id}


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


# ---------------------------------------------------------------- 修正与发布（决策 #35）


def _guard_write(request: Request) -> None:
    """写草稿前的统一闸门：限流 + 口令令牌。顺序不能反——
    先限流再验令牌，否则任何人都能拿"令牌错误"当探测信号刷接口。"""
    allowed, retry_after = get_write_limiter().hit(ratelimit.client_ip(request))
    if not allowed:
        raise HTTPException(
            status_code=429,
            detail={
                "code": "rate_limited",
                "message": f"修改过于频繁，请在 {retry_after} 秒后重试",
                "retry_after": retry_after,
            },
            headers={"Retry-After": str(retry_after)},
        )


def _guard_passcode(token: str | None) -> None:
    if not passcode.enabled():
        raise HTTPException(
            status_code=503,
            detail={
                "code": "passcode_disabled",
                "message": "本站未启用修正通道（未配置口令）",
            },
        )
    if not passcode.verify_token(token):
        # 不区分"没带令牌"与"令牌错误/过期"：少一个可探测的信号。
        # 文案要告诉人下一步做什么，否则只会以为页面坏了。
        raise HTTPException(
            status_code=401,
            detail={
                "code": "passcode_required",
                "message": "需要口令：先验证口令，再用返回的令牌操作",
            },
        )


@router.patch("/{guide_id}")
def patch_guide(
    guide_id: str,
    body: revision.GuidePatch,
    request: Request,
    x_passcode_token: str | None = Header(default=None, alias="X-Passcode-Token"),
) -> dict:
    """修正草稿的文字与判据值（不改结构、不改已发布内容）。

    为什么不用 `PUT` 整体替换：整份替换意味着前端必须回传 `figures`（视觉 DSL）
    与 `assets`，而前端并没有完整重建它们的能力——一次序列化差异就能把图示
    静默抹掉。这里只接受"人真的改了什么"，其余字段服务端原样保留。
    """
    if not GUIDE_ID_RE.match(guide_id):
        raise HTTPException(status_code=404, detail={"code": "not_found"})
    _guard_write(request)
    _guard_passcode(x_passcode_token)

    try:
        revised = revision.apply_patch(guide_id, body)
    except revision.RevisionRejected as exc:
        raise HTTPException(
            status_code=exc.status,
            detail={"code": exc.code, "message": exc.message, **exc.extra},
        ) from exc

    log.info("草稿已修正 guide=%s steps=%d", guide_id, len(revised.steps))
    return {
        "status": "draft",
        "guide_id": guide_id,
        "guide": revised.model_dump(mode="json"),
        # 前端拿它直接告诉用户「还差什么才能发布」，省一次往返。
        "blockers": revised.publish_blockers(),
    }


@router.post("/{guide_id}/publish")
def publish_guide(
    guide_id: str,
    request: Request,
    x_passcode_token: str | None = Header(default=None, alias="X-Passcode-Token"),
) -> dict:
    """发布草稿：口令令牌 + `publish_blockers()` 闸门，与 CLI 同一套判据。"""
    if not GUIDE_ID_RE.match(guide_id):
        raise HTTPException(status_code=404, detail={"code": "not_found"})
    _guard_write(request)
    _guard_passcode(x_passcode_token)

    try:
        result = revision.publish(guide_id)
    except revision.RevisionRejected as exc:
        raise HTTPException(
            status_code=exc.status,
            detail={"code": exc.code, "message": exc.message, **exc.extra},
        ) from exc

    log.info("草稿已发布 guide=%s ip=%s", guide_id, ratelimit.client_ip(request))
    return result
