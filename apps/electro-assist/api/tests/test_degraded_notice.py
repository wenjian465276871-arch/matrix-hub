"""降级提示：生成期被删掉的图示，作者必须看得见。

## 为什么有这条

`_salvage` 在模型写出非法图示时会**删掉出错那一步的全部图示**，再让指导书
照常通过——这是设计好的确定性降级，为了不因为一张装饰图废掉整份生成。
但它的痕迹以前只写日志：日志在服务器上，看页面的人只会发现"这一步没图"，
而根本不知道本来该有、是被系统移除的。

这条钉住"痕迹 → 落库 → 详情接口"这三段；前端提示条由组件测覆盖。
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import store
from main import app
from models.guide import Guide
from store.db import connect
from services import library

client = TestClient(app)
SAMPLES = Path(__file__).resolve().parent.parent / "data" / "samples"


@pytest.fixture()
def lib(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "electro.db"))
    monkeypatch.setenv("GUIDE_DIR", str(SAMPLES))
    monkeypatch.setenv("SEED_GUIDES", "1")
    store.init_db()
    library.ensure_seeded()
    return tmp_path


def _fresh(name: str, guide_id: str) -> Guide:
    """样例内容 + 一个全新的 id。

    不能直接用样例自带 id：那些 id 已被 seed 成**已发布**，而 `save_guide`
    按设计不覆盖已发布内容，会原样返回旧记录（job_id 仍为 NULL），
    测试就会因为"没写进去"而红——那不是缺陷，是保护。
    """
    guide = Guide(**json.loads((SAMPLES / name).read_text(encoding="utf-8")))
    guide.id = guide_id
    return guide


def test_repairs_are_persisted_and_exposed_on_detail(lib):
    """生成失败的图示说明要能顺着 job 被详情页读到。"""
    job = store.create_job(kind="generate", client_ip="10.0.0.9", input_text="x" * 20)
    saved = store.save_guide(_fresh("door_clearance.json", "g_t_degraded_0001"), job_id=job)
    store.finish_job(
        job,
        "succeeded",
        guide_id=saved["id"],
        repairs=["s03 的图示不合法，已去掉", "steps.1 仪表无 value，动效已去掉"],
    )

    assert store.guide_repairs(saved["id"]) == [
        "s03 的图示不合法，已去掉",
        "steps.1 仪表无 value，动效已去掉",
    ]
    body = client.get(f"/api/electro/guides/{saved['id']}").json()
    assert body["repairs"] == store.guide_repairs(saved["id"])


def test_detail_always_has_the_key(lib):
    """没有降级（或不是生成出来的）也必须是空数组，前端不用判 undefined。"""
    body = client.get("/api/electro/guides/g_door_clearance_001").json()
    assert body["repairs"] == []


def test_repair_text_with_punctuation_survives(lib):
    """说明里带中文顿号、分号、引号都不能拆错——存 JSON 数组就是为了这个。

    如果当初用逗号/分号拼接，这里第一条就会被拆成三条，页面上凭空多出两行。
    """
    job = store.create_job(kind="generate", client_ip="10.0.0.10", input_text="y" * 20)
    saved = store.save_guide(_fresh("hvac_cooling.json", "g_t_degraded_0002"), job_id=job)
    note = "第 5 步「读数超差；参见 1.2 条」的图示已去掉"
    store.finish_job(job, "succeeded", guide_id=saved["id"], repairs=[note])

    assert store.guide_repairs(saved["id"]) == [note]


def test_corrupted_repairs_do_not_break_detail(lib):
    """库里的值被写坏时，详情页不能 500——降级说明是提示，不是内容。"""
    job = store.create_job(kind="generate", client_ip="10.0.0.11", input_text="z" * 20)
    saved = store.save_guide(_fresh("door_clearance.json", "g_t_degraded_0001"), job_id=job)
    with connect() as conn:
        conn.execute("UPDATE jobs SET repairs = 'not-json' WHERE id = ?", (job,))
        conn.commit()

    assert store.guide_repairs(saved["id"]) == []
    assert client.get(f"/api/electro/guides/{saved['id']}").status_code == 200
