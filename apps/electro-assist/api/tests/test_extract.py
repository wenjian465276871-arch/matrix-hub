"""图片识别（`POST /extract`）的契约测试。

用 stub provider 而不是真模型：这里要验证的是**边界**——缺少 Key、图不存在、
模型编数、模型乱写 JSON、调用超限——这些用真模型反而测不稳定。
"""
from __future__ import annotations

import io
import json

import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw

import store
from llm.base import Completion, LLMError, Usage
from main import app
from routers import extract as extract_router

client = TestClient(app)


@pytest.fixture(autouse=True)
def _reset(monkeypatch):
    extract_router.reset_limiter()
    yield
    extract_router.reset_limiter()


@pytest.fixture()
def tmp_uploads(tmp_path, monkeypatch):
    monkeypatch.setenv("UPLOAD_DIR", str(tmp_path / "uploads"))
    return str(tmp_path / "uploads")


def _image() -> bytes:
    im = Image.new("RGB", (1600, 1200), "white")
    d = ImageDraw.Draw(im)
    d.text((60, 60), "Process: door switch test", fill="black")
    buf = io.BytesIO()
    im.save(buf, format="PNG")
    return buf.getvalue()


def _asset() -> str:
    r = client.post(
        "/api/electro/uploads", files={"file": ("p.png", _image(), "image/png")}
    )
    assert r.status_code == 200, r.text
    return r.json()["asset_id"]


class StubVision:
    name = "stub-vision"

    def __init__(self, text: str):
        self.text = text
        self.calls: list[dict] = []

    def vision(self, **kwargs) -> Completion:
        self.calls.append(kwargs)
        return Completion(
            text=self.text,
            model="stub-vision",
            usage=Usage(prompt_tokens=1200, completion_tokens=300),
            latency_ms=42,
        )


def _payload(lines: list[str], steps: list[dict], **fields) -> str:
    return json.dumps(
        {
            "lines": lines,
            "fields": {
                "name": fields.get("name"),
                "station": fields.get("station"),
                "tools": fields.get("tools", []),
                "safety": fields.get("safety", []),
                "steps": steps,
            },
            "warnings": fields.get("warnings", []),
        },
        ensure_ascii=False,
    )


def test_missing_key_returns_503(tmp_uploads, monkeypatch):
    asset = _asset()

    def boom():
        raise LLMError("auth", "未配置 DEEPSEEK_API_KEY")

    monkeypatch.setattr(extract_router, "get_provider", boom)
    r = client.post("/api/electro/extract", json={"asset_ids": [asset]})
    assert r.status_code == 503
    assert r.json()["detail"]["code"] == "vision_not_configured"


def test_unknown_asset_returns_422(tmp_uploads):
    r = client.post("/api/electro/extract", json={"asset_ids": ["a_0000000000000000"]})
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "asset_not_found"


def test_too_many_assets_returns_422(tmp_uploads):
    asset = _asset()
    r = client.post("/api/electro/extract", json={"asset_ids": [asset] * 4})
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "too_many_assets"


def test_extract_returns_reviewable_draft(tmp_uploads, monkeypatch):
    asset = _asset()
    text = _payload(
        lines=["工序：客室侧门开关门功能试验", "工位：3 号车门", "1. 开关门各 3 次，开门时间 2.0–3.5s"],
        steps=[{"seq": 1, "action": "开关门各 3 次，开门时间 2.0–3.5s", "criterion": "2.0–3.5s", "source_line": 2}],
        name="客室侧门开关门功能试验",
        station="3 号车门",
    )
    stub = StubVision(text)
    monkeypatch.setattr(extract_router, "get_provider", lambda: stub)

    before = store.usage_summary()
    r = client.post("/api/electro/extract", json={"asset_ids": [asset]})
    assert r.status_code == 200, r.text
    body = r.json()

    assert body["needs_review"] is True
    assert body["fields"]["name"] == "客室侧门开关门功能试验"
    assert body["fields"]["steps"][0]["verified"] is True
    assert body["fields"]["steps"][0]["source_line"] == 2
    assert body["stats"]["verified_steps"] == 1
    assert stub.calls and len(stub.calls[0]["images"]) == 1
    assert stub.calls[0]["images"][0].startswith("data:image/png;base64,")

    after = store.usage_summary()
    assert after["calls"] == before["calls"] + 1
    assert after["cost_micros"] > before["cost_micros"]


def test_fabricated_numbers_are_stripped(tmp_uploads, monkeypatch):
    asset = _asset()
    # 图里只写了 2.0–3.5s，模型却给出 1.0–2.0s：判据必须被清空并标 unverified
    text = _payload(
        lines=["1. 开关门各 3 次，开门时间 2.0–3.5s"],
        steps=[{"seq": 1, "action": "开关门各 3 次", "criterion": "1.0–2.0s", "source_line": 0}],
    )
    monkeypatch.setattr(extract_router, "get_provider", lambda: StubVision(text))

    body = client.post("/api/electro/extract", json={"asset_ids": [asset]}).json()
    step = body["fields"]["steps"][0]
    assert step["criterion"] is None
    assert any("1.0" in item for item in body["unverified"])
    assert any("已清空判据" in item for item in body["unverified"])


def test_missing_fields_are_marked_unverified(tmp_uploads, monkeypatch):
    asset = _asset()
    text = _payload(
        lines=["1. 开关门各 3 次"],
        steps=[{"seq": 1, "action": "开关门各 3 次"}],
        name="凭空冒出来的工序名",
    )
    monkeypatch.setattr(extract_router, "get_provider", lambda: StubVision(text))

    body = client.post("/api/electro/extract", json={"asset_ids": [asset]}).json()
    assert body["fields"]["name"] is None
    assert any("工序名称" in item for item in body["unverified"])


def test_invalid_json_returns_502(tmp_uploads, monkeypatch):
    asset = _asset()
    monkeypatch.setattr(extract_router, "get_provider", lambda: StubVision("这张图看起来是工艺文件"))
    r = client.post("/api/electro/extract", json={"asset_ids": [asset]})
    assert r.status_code == 502
    assert r.json()["detail"]["code"] == "extract_invalid"


def test_rate_limited(tmp_uploads, monkeypatch):
    asset = _asset()
    text = _payload(lines=["1. 检查门机"], steps=[{"seq": 1, "action": "检查门机"}])
    monkeypatch.setattr(extract_router, "get_provider", lambda: StubVision(text))

    for _ in range(3):
        assert client.post("/api/electro/extract", json={"asset_ids": [asset]}).status_code == 200
    r = client.post("/api/electro/extract", json={"asset_ids": [asset]})
    assert r.status_code == 429
    assert r.json()["detail"]["code"] == "rate_limited"
