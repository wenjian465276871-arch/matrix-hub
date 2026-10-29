"""`POST /processes` 预检契约。

它最容易退化成"第二个生成接口"，所以测试重点不是"解析得多准"，
而是三条边界：**不花钱、不落库、缺什么说什么**。
"""
from __future__ import annotations

import store
from fastapi.testclient import TestClient
from main import app

client = TestClient(app)

SAMPLE = """工序：客室侧门开关门功能试验
工位：3 号车门
工具：塞尺、力矩扳手、秒表
1. 确认车辆静止，断开主控并挂检修牌。
2. 检查门控器供电 110V，自检无故障码。
3. 开关门各 3 次，开门时间应为 2.0–3.5s。
4. 检查门到位信号 S4/S5，两路均应导通。
5. 检查门机紧固件力矩，应为 0.7–0.9 N·m。
安全提示：作业前确认门区无人，禁止把手放在门缝处。"""


def test_precheck_extracts_fields():
    r = client.post("/api/electro/processes", json={"text": SAMPLE})
    assert r.status_code == 200, r.text
    body = r.json()

    assert body["process"]["name"] == "客室侧门开关门功能试验"
    assert body["process"]["station"] == "3 号车门"
    assert body["process"]["tools"] == ["塞尺", "力矩扳手", "秒表"]
    assert body["process"]["safety"] == ["作业前确认门区无人，禁止把手放在门缝处。"]
    assert [step["seq"] for step in body["process"]["steps"]] == [1, 2, 3, 4, 5]
    assert body["missing"] == []
    assert body["stats"]["steps_with_criterion"] >= 2
    assert body["process"]["steps"][2]["criterion_hint"].startswith("2.0")


def test_precheck_lists_missing_fields():
    r = client.post("/api/electro/processes", json={"text": "检查门机，确认无异常声响。"})
    assert r.status_code == 200
    body = r.json()
    assert "工序名称" in body["missing"]
    assert "工位" in body["missing"]
    assert "可核对的判据" in body["missing"]
    assert body["warnings"]


def test_precheck_rejects_padded_short_text():
    # 长度靠空格凑够，strip 后不足 10 字：必须在业务层拒，不能被 pydantic 放过去。
    r = client.post("/api/electro/processes", json={"text": "   门    "})
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "input_too_short"


def test_precheck_warns_on_too_many_steps():
    text = "工序：扭矩复核\n" + "\n".join(f"{i}. 复紧第 {i} 颗螺栓。" for i in range(1, 15))
    r = client.post("/api/electro/processes", json={"text": text})
    assert r.status_code == 200
    body = r.json()
    assert body["stats"]["steps"] == 14
    assert any("超过 8 步" in item for item in body["warnings"])


def test_precheck_does_not_spend_budget():
    before = store.usage_summary()
    client.post("/api/electro/processes", json={"text": SAMPLE})
    after = store.usage_summary()
    assert after["calls"] == before["calls"]
    assert after["cost_micros"] == before["cost_micros"]
