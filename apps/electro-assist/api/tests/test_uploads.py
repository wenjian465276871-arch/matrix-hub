"""上传与切图的契约测试。

图片用 Pillow 现场合成，不依赖外部素材：
- 一张 1600×1200 的"工艺截图"：带表格线 + 文字行 + 小字旁注；
- 同一张图缩到 800px，用来验证"太小直接拒"。
"""
from __future__ import annotations

import io

import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw

import imaging
from main import app

client = TestClient(app)


def _make_page(width: int = 1600, height: int = 1200) -> bytes:
    im = Image.new("RGB", (width, height), "white")
    d = ImageDraw.Draw(im)
    d.text((60, 40), "Process Sheet 4.1  Door Clearance Check", fill="black")
    for i in range(6):
        d.text((60, 100 + i * 34), f"Step {i + 1}: check clearance 1.0 - 3.0 mm", fill="black")

    x0, y0, cw, rh = 60, 340, 420, 60
    for r in range(6):
        d.line([(x0, y0 + r * rh), (x0 + 3 * cw, y0 + r * rh)], fill="black", width=3)
    for c in range(4):
        d.line([(x0 + c * cw, y0), (x0 + c * cw, y0 + 5 * rh)], fill="black", width=3)
    for r in range(5):
        for c in range(3):
            d.text((x0 + c * cw + 12, y0 + r * rh + 20), f"R{r+1}C{c+1} 0.8 N.m", fill="black")

    for i in range(3):
        d.text((900, 760 + i * 18), "Torque 0.8 N.m  M6x12", fill="black")

    buf = io.BytesIO()
    im.save(buf, format="JPEG", quality=92)
    return buf.getvalue()


@pytest.fixture()
def tmp_uploads(tmp_path, monkeypatch):
    monkeypatch.setenv("UPLOAD_DIR", str(tmp_path / "uploads"))
    return str(tmp_path / "uploads")


def test_rejects_non_image(tmp_uploads):
    r = client.post("/api/electro/uploads", files={"file": ("a.txt", b"hello world", "text/plain")})
    assert r.status_code == 415
    assert r.json()["detail"]["code"] == "bad_format"


def test_rejects_too_small(tmp_uploads):
    r = client.post("/api/electro/uploads", files={"file": ("s.jpg", _make_page(800, 600), "image/jpeg")})
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "too_small"


def test_upload_normalizes(tmp_uploads):
    r = client.post("/api/electro/uploads", files={"file": ("p.jpg", _make_page(), "image/jpeg")})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["asset_id"].startswith("a_")
    assert body["exif_stripped"] is True
    assert body["stored_width"] >= imaging.MIN_LONG_SIDE


def test_slice_finds_table(tmp_uploads):
    up = client.post("/api/electro/uploads", files={"file": ("p.jpg", _make_page(), "image/jpeg")}).json()
    r = client.post(f"/api/electro/uploads/{up['asset_id']}/slice")
    assert r.status_code == 200, r.text
    regions = r.json()["regions"]
    assert len(regions) >= 2, r.json()
    assert regions[0]["reason"] == "full"
    assert "table" in {x["reason"] for x in regions[1:]}, [x["reason"] for x in regions]
    assert all(x["scale"] >= 1.0 for x in regions[1:])


def test_slice_rejects_bad_asset_id(tmp_uploads):
    assert client.post("/api/electro/uploads/not-an-id/slice").status_code == 400


# ---- 切图限流与单资产上限（2026-10-21）------------------------------------
# 切图是唯一"无参数、可重复、重 CPU + 写盘"的操作，必须单独设闸。


@pytest.fixture(autouse=True)
def _reset_slice_limiter():
    from routers import uploads as uploads_router

    uploads_router.reset_slice_limiter()
    yield
    uploads_router.reset_slice_limiter()


def test_slice_rate_limited(tmp_uploads, monkeypatch):
    monkeypatch.setenv("SLICE_PER_HOUR", "1")
    monkeypatch.setenv("SLICE_PER_DAY", "10")
    monkeypatch.setenv("MAX_SLICES_PER_ASSET", "10")
    up = client.post(
        "/api/electro/uploads", files={"file": ("p.jpg", _make_page(), "image/jpeg")}
    ).json()

    assert client.post(f"/api/electro/uploads/{up['asset_id']}/slice").status_code == 200
    r = client.post(f"/api/electro/uploads/{up['asset_id']}/slice")
    assert r.status_code == 429
    assert r.json()["detail"]["code"] == "rate_limited"
    assert int(r.headers["Retry-After"]) >= 1


def test_slice_capped_per_asset(tmp_uploads, monkeypatch):
    monkeypatch.setenv("SLICE_PER_HOUR", "10")
    monkeypatch.setenv("SLICE_PER_DAY", "20")
    monkeypatch.setenv("MAX_SLICES_PER_ASSET", "1")
    up = client.post(
        "/api/electro/uploads", files={"file": ("p.jpg", _make_page(), "image/jpeg")}
    ).json()

    assert client.post(f"/api/electro/uploads/{up['asset_id']}/slice").status_code == 200
    r = client.post(f"/api/electro/uploads/{up['asset_id']}/slice")
    assert r.status_code == 429
    assert r.json()["detail"]["code"] == "slice_limit"

    meta = client.get(f"/api/electro/uploads/{up['asset_id']}").json()
    assert meta["slice_calls"] == 1
