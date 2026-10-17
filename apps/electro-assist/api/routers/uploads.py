"""图片上传与切图。

第 1–2 步的可交付：能收图、能拒不合格的图、能把整页切成可识别的块。
识别（第 3 步）不在这里，先把"进来的是不是一张能用的图"这件事做扎实。
"""
from __future__ import annotations

import json
import os
import re
import uuid

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse

import imaging
import slicing

router = APIRouter(prefix="/api/electro/uploads", tags=["uploads"])

def upload_dir() -> str:
    """运行时读取，便于测试注入；不要改成模块级常量。"""
    return os.getenv("UPLOAD_DIR", "app_data/uploads")
ASSET_RE = re.compile(r"^a_[0-9a-f]{16}$")
FILE_RE = re.compile(r"^a_[0-9a-f]{16}(_r\d+|_full)?\.png$")


def _asset_dir(asset_id: str) -> str:
    return os.path.join(upload_dir(), asset_id)


@router.post("")
async def upload(file: UploadFile = File(...)) -> dict:
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

    normalized, info = imaging.normalize(raw)
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
def slice_asset(asset_id: str) -> dict:
    if not ASSET_RE.match(asset_id):
        raise HTTPException(status_code=400, detail={"code": "bad_asset_id"})
    src = os.path.join(_asset_dir(asset_id), f"{asset_id}.png")
    if not os.path.exists(src):
        raise HTTPException(status_code=404, detail={"code": "not_found"})

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


@router.get("/{asset_id}/{filename}")
def get_file(asset_id: str, filename: str) -> FileResponse:
    if not ASSET_RE.match(asset_id) or not FILE_RE.match(filename):
        raise HTTPException(status_code=400, detail={"code": "bad_path"})
    path = os.path.join(_asset_dir(asset_id), filename)
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail={"code": "not_found"})
    return FileResponse(path, media_type="image/png")
