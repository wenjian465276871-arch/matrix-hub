"""素材链路契约测试：上传 → 生成带素材 → 人工归位。

这一组测试守的是三条容易被"看起来能跑"掩盖的边界：
1. 素材 id 必须是服务端发的那种格式，客户端编一个不能进库；
2. 模型即使照 schema 编了 assets，也必须被清空——图片位置是事实，不是生成物；
3. 已发布的指导书不能被改，哪怕只是挪一张图。
"""
from __future__ import annotations

import copy
import io
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw

import store
from llm import Completion, Usage
from main import app
from models.guide import AssetRef, Guide
from routers import guides as guides_router
from services import generation
from services.jobqueue import job_queue

client = TestClient(app)
SAMPLE = json.loads(
    (Path(__file__).resolve().parent.parent / "samples" / "door_switch_test.json").read_text(
        encoding="utf-8"
    )
)
TEXT = "工序：开关门功能试验。检查开关门时间 2.0-3.5s，确认门到位信号正常。"
IP = "testclient"
ASSET_A = "a_0123456789abcdef"
ASSET_B = "a_fedcba9876543210"


def _png(width: int = 1600, height: int = 1200) -> bytes:
    im = Image.new("RGB", (width, height), "white")
    d = ImageDraw.Draw(im)
    d.text((60, 40), "Door clearance 1.0 - 3.0 mm", fill="black")
    for i in range(8):
        d.line([(60, 200 + i * 90), (width - 60, 200 + i * 90)], fill="black", width=2)
    buf = io.BytesIO()
    im.save(buf, format="PNG")
    return buf.getvalue()


@pytest.fixture()
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "electro.db"))
    monkeypatch.setenv("UPLOAD_DIR", str(tmp_path / "uploads"))
    monkeypatch.setenv("GENERATE_PER_HOUR", "5")
    monkeypatch.setenv("GENERATE_PER_DAY", "20")
    store.init_db()
    job_queue.reset()
    guides_router.reset_attach_limiter()
    yield
    job_queue.reset()
    guides_router.reset_attach_limiter()


def _upload() -> str:
    r = client.post(
        "/api/electro/uploads", files={"file": ("shot.png", _png(), "image/png")}
    )
    assert r.status_code == 200, r.text
    return r.json()["asset_id"]


class FakeProvider:
    name = "fake-model"

    def __init__(self, body: dict):
        self.body = body

    def structured(self, **_kwargs) -> Completion:
        return Completion(
            text=json.dumps(self.body, ensure_ascii=False),
            model=self.name,
            usage=Usage(prompt_tokens=1000, completion_tokens=500, reasoning_tokens=100),
            latency_ms=12,
        )

    def close(self) -> None:
        pass


def _guide() -> Guide:
    return Guide.model_validate(copy.deepcopy(SAMPLE))


# ---------------------------------------------------------------- 模型层


def test_asset_ref_rejects_client_invented_id():
    with pytest.raises(ValueError):
        AssetRef(asset_id="../../etc/passwd", caption="门锁位置")


def test_same_asset_cannot_appear_twice():
    data = copy.deepcopy(SAMPLE)
    data["assets"] = [{"asset_id": ASSET_A, "caption": "门锁间隙"}]
    data["steps"][0]["assets"] = [{"asset_id": ASSET_A, "caption": "门锁间隙"}]
    with pytest.raises(ValueError, match="不能重复引用"):
        Guide.model_validate(data)


def test_prompt_schema_hides_assets():
    """模型连 assets 字段都不该看到：看到就会填，填了就是编。"""
    from llm.prompts import output_schema

    schema = output_schema()
    assert "assets" not in schema["properties"]
    assert "assets" not in schema["$defs"]["Step"]["properties"]
    assert "assets" not in schema.get("required", [])
    # 反向确认：真实模型仍然有这两个字段，删的只是"给模型看的那份"
    assert "assets" in Guide.model_json_schema()["properties"]


# ---------------------------------------------------------------- 生成


def test_generate_rejects_asset_that_is_not_on_disk(env):
    r = client.post(
        "/api/electro/generate",
        json={"text": TEXT, "assets": [{"asset_id": ASSET_A, "caption": "门锁间隙"}]},
    )
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "asset_not_found"


def test_generate_rejects_duplicate_asset(env):
    asset_id = _upload()
    r = client.post(
        "/api/electro/generate",
        json={
            "text": TEXT,
            "assets": [
                {"asset_id": asset_id, "caption": "门锁间隙"},
                {"asset_id": asset_id, "caption": "同一张"},
            ],
        },
    )
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "asset_duplicate"


def test_worker_attaches_assets_and_drops_model_output(env):
    asset_id = _upload()

    # 模型照 schema 编了一张不存在的图：必须被服务端清掉。
    body = copy.deepcopy(SAMPLE)
    body["steps"][0]["assets"] = [{"asset_id": ASSET_B, "caption": "模型编的"}]
    body["assets"] = [{"asset_id": ASSET_B, "caption": "模型编的"}]

    r = client.post(
        "/api/electro/generate",
        json={"text": TEXT, "assets": [{"asset_id": asset_id, "caption": "门锁间隙测量位置"}]},
    )
    assert r.status_code == 202
    job_id = r.json()["job_id"]
    assert json.loads(store.get_job(job_id)["assets_json"])[0]["asset_id"] == asset_id

    generation.run(job_id, TEXT, provider_factory=lambda: FakeProvider(body))

    snap = store.get_job(job_id)
    assert snap["status"] == "succeeded", snap
    saved = store.get_guide(snap["guide_id"])["guide"]
    assert [a["asset_id"] for a in saved["assets"]] == [asset_id]
    assert saved["assets"][0]["caption"] == "门锁间隙测量位置"
    assert all(step["assets"] == [] for step in saved["steps"])


# ---------------------------------------------------------------- 归位


def _save_draft(assets: list[dict] | None = None) -> str:
    data = copy.deepcopy(SAMPLE)
    data["id"] = "g_asset_case_0001"
    data["assets"] = assets or [{"asset_id": ASSET_A, "caption": "门锁间隙"}]
    guide = Guide.model_validate(data)
    store.save_guide(guide, status="draft")
    return guide.id


def test_attach_moves_asset_to_step(env):
    guide_id = _save_draft()
    r = client.put(
        f"/api/electro/guides/{guide_id}/assets",
        json={"assets": [{"asset_id": ASSET_A, "caption": "门锁间隙", "step_id": "s02"}]},
    )
    assert r.status_code == 200, r.text
    assert r.json()["attached"] == 1 and r.json()["loose"] == 0

    saved = store.get_guide(guide_id)["guide"]
    assert saved["assets"] == []
    moved = [s for s in saved["steps"] if s["id"] == "s02"][0]
    assert moved["assets"][0]["asset_id"] == ASSET_A


def test_attach_back_to_loose_area(env):
    guide_id = _save_draft()
    client.put(
        f"/api/electro/guides/{guide_id}/assets",
        json={"assets": [{"asset_id": ASSET_A, "caption": "门锁间隙", "step_id": "s01"}]},
    )
    client.put(
        f"/api/electro/guides/{guide_id}/assets",
        json={"assets": [{"asset_id": ASSET_A, "caption": "门锁间隙（改）"}]},
    )
    saved = store.get_guide(guide_id)["guide"]
    assert saved["assets"][0]["caption"] == "门锁间隙（改）"
    assert all(step["assets"] == [] for step in saved["steps"])


def test_attach_rejects_published(env):
    data = copy.deepcopy(SAMPLE)
    data["id"] = "g_asset_pub_0001"
    data["assets"] = [{"asset_id": ASSET_A, "caption": "门锁间隙"}]
    store.save_guide(Guide.model_validate(data), status="published")

    r = client.put(
        f"/api/electro/guides/{data['id']}/assets",
        json={"assets": [{"asset_id": ASSET_A, "caption": "门锁间隙", "step_id": "s01"}]},
    )
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "published_locked"


def test_attach_rejects_foreign_asset(env):
    guide_id = _save_draft()
    r = client.put(
        f"/api/electro/guides/{guide_id}/assets",
        json={"assets": [{"asset_id": ASSET_B, "caption": "别人的图"}]},
    )
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "unknown_asset"


def test_attach_rejects_unknown_step(env):
    guide_id = _save_draft()
    r = client.put(
        f"/api/electro/guides/{guide_id}/assets",
        json={"assets": [{"asset_id": ASSET_A, "caption": "门锁间隙", "step_id": "s99"}]},
    )
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "step_not_found"


def test_attach_refuses_to_clear_everything(env):
    guide_id = _save_draft()
    r = client.put(f"/api/electro/guides/{guide_id}/assets", json={"assets": []})
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "assets_required"
    # 原样保留，没有被清空
    assert store.get_guide(guide_id)["guide"]["assets"][0]["asset_id"] == ASSET_A


def test_attach_requires_known_guide(env):
    r = client.put(
        "/api/electro/guides/g_notexist0001/assets",
        json={"assets": [{"asset_id": ASSET_A, "caption": "门锁间隙"}]},
    )
    assert r.status_code == 404
