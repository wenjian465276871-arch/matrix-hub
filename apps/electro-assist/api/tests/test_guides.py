"""指导书读取端点的契约测试。

关注点不是"能返回 JSON"，而是三条边界：
1. 列表不返回全文（避免列表页拉几十 KB）；
2. 未知/畸形 id 一律 404，不泄露目录结构；
3. 坏样例被跳过而不是让整个接口 500——一个文件写错不该拖垮全部。
"""
from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from main import app
from routers import guides as guides_router

client = TestClient(app)
SAMPLES = Path(__file__).resolve().parent.parent / "samples"
SAMPLE_ID = "g_door_clearance_001"


@pytest.fixture(autouse=True)
def _fresh_cache(monkeypatch):
    monkeypatch.delenv("GUIDE_DIR", raising=False)
    guides_router.reset_cache()
    yield
    guides_router.reset_cache()


def test_list_returns_summary_not_full_body():
    r = client.get("/api/electro/guides")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["count"] >= 1
    item = next(i for i in body["items"] if i["id"] == SAMPLE_ID)
    assert item["step_count"] == 3
    assert item["system"] == "door"
    assert "steps" not in item
    assert item["source_note"]


def test_get_returns_full_guide():
    r = client.get(f"/api/electro/guides/{SAMPLE_ID}")
    assert r.status_code == 200, r.text
    guide = r.json()
    assert guide["schema_version"] == "1.0"
    assert len(guide["steps"]) == 3
    assert guide["steps"][0]["seq"] == 1
    assert "演示数据 · 非实际作业依据" in guide["disclaimers"]
    # 图元参数被原样保留，前端渲染器据此分发
    assert guide["steps"][1]["figures"][0]["primitive"] == "meter"


def test_unknown_id_is_404():
    assert client.get("/api/electro/guides/g_not_exist_000").status_code == 404


def test_malformed_id_is_404():
    # 不做 400/404 区分：不告诉调用方"格式对了但不存在"，减少探测面
    assert client.get("/api/electro/guides/../../etc/passwd").status_code == 404
    assert client.get("/api/electro/guides/abc").status_code == 404


def test_broken_sample_is_skipped(tmp_path, monkeypatch):
    shutil.copy(SAMPLES / "door_clearance.json", tmp_path / "good.json")
    (tmp_path / "broken.json").write_text("{ not json", encoding="utf-8")

    bad = json.loads((SAMPLES / "door_clearance.json").read_text(encoding="utf-8"))
    bad["id"] = "g_bad_schema_001"
    bad["steps"][0]["seq"] = 9  # 序号不连续，必须被拒
    (tmp_path / "invalid.json").write_text(json.dumps(bad), encoding="utf-8")

    monkeypatch.setenv("GUIDE_DIR", str(tmp_path))
    guides_router.reset_cache()

    body = client.get("/api/electro/guides").json()
    assert body["count"] == 1
    assert body["items"][0]["id"] == SAMPLE_ID


def test_empty_dir_returns_empty_list(tmp_path, monkeypatch):
    monkeypatch.setenv("GUIDE_DIR", str(tmp_path))
    guides_router.reset_cache()
    body = client.get("/api/electro/guides").json()
    assert body == {"schema_version": "1.0", "count": 0, "items": []}
