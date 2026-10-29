"""作业记录导出与诊断结论回写。

两条要求来自现场而不是文档：
1. 记录要能"拿得走"——班组电脑没网、没前端，双击 HTML 也要能读；
2. 转 B 排查的结论必须回到这次作业里——否则打印出来的报告只有"某步超差"，
   没有"为什么、怎么处置"，等于把结论丢在了另一个页面。
"""
from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import store
from main import app
from services import library
from services import sessions as session_service

client = TestClient(app)
GUIDE_ID = "g_door_switch_test_001"
SAMPLES = Path(__file__).resolve().parent.parent / "data" / "samples"


@pytest.fixture()
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "electro.db"))
    monkeypatch.setenv("GUIDE_DIR", str(SAMPLES))
    monkeypatch.setenv("SEED_GUIDES", "1")
    store.init_db()
    library.ensure_seeded()
    session_service.reset_rate_limit()
    from routers import diagnose as diagnose_router

    diagnose_router.reset_limiter()


def _start() -> str:
    r = client.post("/api/electro/sessions", json={"guide_id": GUIDE_ID})
    assert r.status_code == 201, r.text
    return r.json()["session"]["id"]


def _submit(sid: str, seq: int, values: dict, note: str = ""):
    return client.post(
        f"/api/electro/sessions/{sid}/steps/{seq}",
        json={"values": values, "note": note},
        headers={"Idempotency-Key": f"{sid}:s{seq:02d}:a1"},
    )


def _failed_session() -> str:
    sid = _start()
    assert _submit(sid, 1, {"confirm_safe": True}).status_code == 200
    # 供电 90V 低于 99–121V：判 fail，不推进，留下异常链
    assert _submit(sid, 2, {"supply_v": 90, "pin_ok": "一致"}, note="现场读数偏低").status_code == 200
    return sid


def test_report_has_no_diagnosis_by_default(env):
    sid = _failed_session()
    body = client.get(f"/api/electro/records/{sid}").json()
    assert body["diagnoses"] == []
    assert len(body["exceptions"]) >= 1


def test_diagnosis_is_linked_back_to_record(env):
    sid = _failed_session()
    r = client.post(
        "/api/electro/diagnose/runs",
        json={
            "symptom": "开关门时间超差，关门缓慢不到位",
            "system": "door",
            "session_id": sid,
        },
    )
    assert r.status_code == 201, r.text
    run = r.json()["run"]

    body = client.get(f"/api/electro/records/{sid}").json()
    assert len(body["diagnoses"]) == 1
    linked = body["diagnoses"][0]
    assert linked["id"] == run["id"]
    assert linked["symptom"].startswith("开关门时间超差")
    assert linked["status"] in ("active", "concluded")
    assert linked["checks"] == 0
    assert linked["conclusion"] is None


def test_export_html_is_self_contained(env):
    sid = _failed_session()
    client.post(
        "/api/electro/diagnose/runs",
        json={"symptom": "开关门时间超差，关门缓慢", "system": "door", "session_id": sid},
    )

    r = client.get(f"/api/electro/records/{sid}/export.html")
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("text/html")
    assert "attachment" in r.headers["content-disposition"]
    assert r.headers["cache-control"] == "no-store"

    html = r.text
    assert html.startswith("<!DOCTYPE html>")
    assert "<style>" in html and "http" not in html.split("<style>")[0]
    assert "客室侧门开关门功能试验" in html
    assert "异常链" in html
    assert "关联排查结论" in html
    assert "开关门时间超差" in html
    # 站点资源一律外链的写法在这里必须没有：文件要能离线打开
    assert "<script" not in html


def test_export_escapes_user_note(env):
    sid = _start()
    payload = "<script>alert(1)</script> 门区有人"
    assert _submit(sid, 1, {"confirm_safe": True}, note=payload).status_code == 200

    html = client.get(f"/api/electro/records/{sid}/export.html").text
    assert "<script>alert(1)</script>" not in html
    assert "&lt;script&gt;alert(1)&lt;/script&gt;" in html


def test_export_rejects_unknown_record(env):
    r = client.get("/api/electro/records/s_0000000000000000/export.html")
    assert r.status_code == 404
    assert client.get("/api/electro/records/bad/export.html").status_code == 404
