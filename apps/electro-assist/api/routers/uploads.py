"""图片上传与切图。

第 1–2 步的可交付：能收图、能拒不合格的图、能把整页切成可识别的块。
识别（第 3 步）不在这里，先把"进来的是不是一张能用的图"这件事做扎实。
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import uuid

from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from PIL import Image

from core import assets
from core import imaging
from core import ratelimit
from core import slicing

router = APIRouter(prefix="/api/electro/uploads", tags=["uploads"])

# 切块 id 形如 `a_xxx-table_band-2`。前缀必须与路径里的 asset_id 一致，
# 否则就能拿 A 图的分块 id 去 adopt B 图的目录——路径拼接最典型的越权口子。
SLICE_REGION_RE = re.compile(
    r"^(?P<asset>a_[0-9a-f]{16})-(?P<reason>full|table_band|table|dense_text)-(?P<idx>\d{1,2})$"
)
MAX_ADOPTS_PER_ASSET_DEFAULT = 6

# 切图是"读一张 5MB 图 + numpy 统计 + 写多个 PNG"的重活，且不需要任何参数。
# 上传有限流、切图原先没有——等于给了一个免费放大器。这里单独限流，
# 并给单个资产加调用上限：正常确认一次就够，反复切只可能是脚本。
SLICE_PER_HOUR_DEFAULT = 20
SLICE_PER_DAY_DEFAULT = 100
SLICE_SITE_PER_DAY_DEFAULT = 500
MAX_SLICES_PER_ASSET_DEFAULT = 5
_slice_limiter: ratelimit.Limiter | None = None


def _int_env(name: str, default: int) -> int:
    raw = os.getenv(name)
    try:
        return max(1, int(raw)) if raw and raw.strip() else default
    except ValueError:
        return default


def get_slice_limiter() -> ratelimit.Limiter:
    global _slice_limiter
    if _slice_limiter is None:
        _slice_limiter = ratelimit.Limiter(
            per_hour=_int_env("SLICE_PER_HOUR", SLICE_PER_HOUR_DEFAULT),
            per_day=_int_env("SLICE_PER_DAY", SLICE_PER_DAY_DEFAULT),
            site_per_day=_int_env("SLICE_SITE_PER_DAY", SLICE_SITE_PER_DAY_DEFAULT),
        )
    return _slice_limiter


def reset_slice_limiter() -> None:
    """仅供测试：限流器是进程内单例。"""
    global _slice_limiter
    _slice_limiter = None

def upload_dir() -> str:
    """运行时读取，便于测试注入；不要改成模块级常量。"""
    return assets.upload_dir()


ASSET_RE = assets.ASSET_RE
FILE_RE = assets.FILE_RE


def _asset_dir(asset_id: str) -> str:
    return os.path.join(upload_dir(), asset_id)


@router.post("")
async def upload(request: Request, file: UploadFile = File(...)) -> dict:
    # 先限流再读内容：上传是唯一无需参数即可写入磁盘、并触发最重解码的端点。
    allowed, retry_after = ratelimit.get_limiter().hit(ratelimit.client_ip(request))
    if not allowed:
        raise HTTPException(
            status_code=429,
            detail={
                "code": "rate_limited",
                "message": f"上传过于频繁，请在 {retry_after} 秒后重试",
                "retry_after": retry_after,
            },
            headers={"Retry-After": str(retry_after)},
        )

    raw = await file.read(imaging.MAX_BYTES + 1)
    if len(raw) > imaging.MAX_BYTES:
        raise HTTPException(status_code=413, detail={
            "code": "too_large", "message": f"超过 {imaging.MAX_BYTES // 1024 // 1024} MB"})

    check = imaging.inspect(raw)
    if not check.ok:
        status = 415 if any(i.code is imaging.Code.bad_format for i in check.issues) else 422
        raise HTTPException(status_code=status, detail={
            "code": check.issues[0].code.value,
            "message": check.issues[0].message,
            "issues": [{"code": i.code.value, "message": i.message} for i in check.issues],
        })

    try:
        normalized, info = imaging.normalize(raw)
    except (OSError, ValueError):
        # 截断/损坏的图能通过魔数与尺寸检查，却会在真正解码时炸开。
        # 这类输入是用户问题，不是服务端故障，必须回 422 而不是 500。
        raise HTTPException(status_code=422, detail={
            "code": "unreadable", "message": "图片无法完整解析，可能已损坏或被截断"})
    asset_id = "a_" + uuid.uuid4().hex[:16]
    directory = _asset_dir(asset_id)
    os.makedirs(directory, exist_ok=True)
    path = os.path.join(directory, f"{asset_id}.png")
    with open(path, "wb") as fh:
        fh.write(normalized)

    meta = {
        "asset_id": asset_id,
        "source_format": check.info.format,
        "source_width": check.info.width,
        "source_height": check.info.height,
        "stored_width": info.width,
        "stored_height": info.height,
        "stored_bytes": info.bytes,
        "sha256": info.sha256,
        "warnings": check.warnings,
    }
    with open(os.path.join(directory, "meta.json"), "w", encoding="utf-8") as fh:
        json.dump(meta, fh, ensure_ascii=False, indent=2)

    return {**meta, "exif_stripped": True}


@router.post("/{asset_id}/slice")
def slice_asset(asset_id: str, request: Request) -> dict:
    if not ASSET_RE.match(asset_id):
        raise HTTPException(status_code=400, detail={"code": "bad_asset_id"})

    allowed, retry_after = get_slice_limiter().hit(ratelimit.client_ip(request))
    if not allowed:
        raise HTTPException(
            status_code=429,
            detail={
                "code": "rate_limited",
                "message": f"切图请求过于频繁，请在 {retry_after} 秒后重试",
                "retry_after": retry_after,
            },
            headers={"Retry-After": str(retry_after)},
        )

    src = os.path.join(_asset_dir(asset_id), f"{asset_id}.png")
    meta_path = os.path.join(_asset_dir(asset_id), "meta.json")
    if not os.path.exists(src) or not os.path.exists(meta_path):
        raise HTTPException(status_code=404, detail={"code": "not_found"})

    with open(meta_path, encoding="utf-8") as fh:
        meta = json.load(fh)
    calls = int(meta.get("slice_calls", 0))
    cap = _int_env("MAX_SLICES_PER_ASSET", MAX_SLICES_PER_ASSET_DEFAULT)
    if calls >= cap:
        raise HTTPException(
            status_code=429,
            detail={
                "code": "slice_limit",
                "message": f"该图片已切图 {calls} 次，达到上限；如需重试请重新上传",
            },
        )
    meta["slice_calls"] = calls + 1
    with open(meta_path, "w", encoding="utf-8") as fh:
        json.dump(meta, fh, ensure_ascii=False, indent=2)

    with open(src, "rb") as fh:
        raw = fh.read()

    out_dir = _asset_dir(asset_id)
    regions = slicing.slice_image(raw, asset_id, out_dir)
    if len(regions) == 1:
        # 只有整图视图，说明没检测到表格/密集文字，需要人确认是否重拍
        note = "未检测到表格或密集文字区域，仅生成整图视图"
    else:
        note = f"生成 {len(regions) - 1} 个局部块（表格/密集文字）"

    return {
        "asset_id": asset_id,
        "regions": [r.to_dict() for r in regions],
        "note": note,
    }


@router.post("/{asset_id}/slice/{region_id}/adopt")
def adopt_region(asset_id: str, region_id: str) -> dict:
    """把一个切块"采纳"成独立素材。

    为什么不直接让 Guide 引用 `a_xxx_r2.png`：`assets.exists()` 只认
    `<id>/<id>.png + meta.json` 这一种形态。让引用层同时理解"整图"和"分块"
    会把这套约定撕成两半，清理脚本也得跟着改。复制一份（几十 KB）换一条干净的契约，划算。

    采纳上限按源图计：切块接口已有 5 次上限，但 adopt 会真的多存一份文件，
    不设上限就是"一次上传、无限膨胀"的放大器。
    """
    if not ASSET_RE.match(asset_id):
        raise HTTPException(status_code=400, detail={"code": "bad_asset_id"})
    match = SLICE_REGION_RE.match(region_id)
    if not match or match.group("asset") != asset_id:
        raise HTTPException(status_code=400, detail={"code": "bad_region_id"})

    src_dir = _asset_dir(asset_id)
    meta_path = os.path.join(src_dir, "meta.json")
    if not os.path.exists(meta_path):
        raise HTTPException(status_code=404, detail={"code": "not_found"})

    reason, index = match.group("reason"), int(match.group("idx"))
    filename = f"{asset_id}_full.png" if reason == "full" else f"{asset_id}_r{index}.png"
    src = os.path.join(src_dir, filename)
    if not os.path.exists(src):
        raise HTTPException(
            status_code=404,
            detail={"code": "region_not_found", "message": "该切块不存在，请先切图"},
        )

    with open(meta_path, encoding="utf-8") as fh:
        source_meta = json.load(fh)
    adopted = int(source_meta.get("adopted", 0))
    cap = _int_env("MAX_ADOPTS_PER_ASSET", MAX_ADOPTS_PER_ASSET_DEFAULT)
    if adopted >= cap:
        raise HTTPException(
            status_code=429,
            detail={
                "code": "adopt_limit",
                "message": f"这张图已采纳 {adopted} 个切块，达到上限；请重新上传",
            },
        )

    new_id = "a_" + uuid.uuid4().hex[:16]
    new_dir = _asset_dir(new_id)
    os.makedirs(new_dir, exist_ok=True)
    target = os.path.join(new_dir, f"{new_id}.png")
    shutil.copyfile(src, target)

    with open(target, "rb") as fh:
        payload = fh.read()
    with Image.open(target) as image:
        width, height = image.size
        stored_format = image.format or "PNG"

    meta = {
        "asset_id": new_id,
        "source_format": stored_format,
        "source_width": width,
        "source_height": height,
        "stored_width": width,
        "stored_height": height,
        "stored_bytes": len(payload),
        "sha256": hashlib.sha256(payload).hexdigest(),
        "warnings": [],
        "exif_stripped": True,
        "derived_from": asset_id,
        "region_id": region_id,
        "region_reason": reason,
        "url": assets.public_url(new_id),
    }
    with open(os.path.join(new_dir, "meta.json"), "w", encoding="utf-8") as fh:
        json.dump(meta, fh, ensure_ascii=False, indent=2)

    source_meta["adopted"] = adopted + 1
    with open(meta_path, "w", encoding="utf-8") as fh:
        json.dump(source_meta, fh, ensure_ascii=False, indent=2)

    return meta


@router.get("/{asset_id}")
def get_meta(asset_id: str) -> dict:
    """返回上传时的元信息，前端确认页据此展示尺寸、来源格式与告警。"""
    if not ASSET_RE.match(asset_id):
        raise HTTPException(status_code=400, detail={"code": "bad_asset_id"})
    path = os.path.join(_asset_dir(asset_id), "meta.json")
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail={"code": "not_found"})
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


@router.get("/{asset_id}/{filename}")
def get_file(asset_id: str, filename: str) -> FileResponse:
    if not ASSET_RE.match(asset_id) or not FILE_RE.match(filename):
        raise HTTPException(status_code=400, detail={"code": "bad_path"})
    path = os.path.join(_asset_dir(asset_id), filename)
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail={"code": "not_found"})
    return FileResponse(path, media_type="image/png")
