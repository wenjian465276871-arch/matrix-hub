"""指导书搜索（`GET /guides?q=`）。

要证明的四条：

1. 命中标题/摘要/来源说明任一即可；
2. `total` 是**命中数**，不是全库数——否则「共 N 份」会骗人；
3. `%` 与 `_` 不被当成通配符（否则搜一个 `%` 就把全库搜出来）；
4. 空串等于不过滤，与加参数前的行为完全一致。
"""
from __future__ import annotations

import copy

import pytest
from fastapi.testclient import TestClient

import store
from main import app
from services import library

client = TestClient(app)


@pytest.fixture()
def seeded(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "electro.db"))
    # 关掉自动 seed：否则 6 份样例会一起进库，搜索命中数就不可断言了。
    monkeypatch.setenv("SEED_GUIDES", "0")
    store.init_db()
    base = library.load_fixtures()
    assert len(base) >= 2
    first, second = copy.deepcopy(base[0]), copy.deepcopy(base[1])
    first.id = "g_search_alpha_001"
    first.title = "客室侧门开关门时间测量"
    first.summary = "测量开门与关门时间，确认在 2.0–3.5 秒区间内。"
    second.id = "g_search_beta_001"
    second.title = "受电弓升弓检查"
    second.summary = "静态调试时的升弓动作与压力确认。"
    store.save_guide(first, status="published")
    store.save_guide(second, status="published")
    return first, second


def test_search_matches_title(seeded):
    body = client.get("/api/electro/guides", params={"q": "侧门"}).json()
    ids = [item["id"] for item in body["items"]]
    assert "g_search_alpha_001" in ids
    assert "g_search_beta_001" not in ids
    assert body["total"] == 1
    assert body["has_more"] is False
    assert body["query"] == "侧门"


def test_search_matches_summary(seeded):
    body = client.get("/api/electro/guides", params={"q": "升弓"}).json()
    assert [item["id"] for item in body["items"]] == ["g_search_beta_001"]


def test_search_total_is_hit_count(seeded):
    """`total` 必须是命中数：拿它算「还有 N 份」，多算就会给出永远点不完的按钮。"""
    body = client.get("/api/electro/guides", params={"q": "压力"}).json()
    assert body["total"] == 1
    assert body["count"] == 1

    all_rows = client.get("/api/electro/guides").json()
    assert all_rows["total"] >= 2


def test_search_treats_wildcards_literally(seeded):
    """`%` 是 LIKE 通配符：不转义的话它等于「全选」，搜索框就成了摆设。"""
    body = client.get("/api/electro/guides", params={"q": "%"}).json()
    assert body["total"] == 0
    assert body["items"] == []


def test_search_empty_query_is_no_filter(seeded):
    a = client.get("/api/electro/guides", params={"q": "  "}).json()
    b = client.get("/api/electro/guides").json()
    assert a["total"] == b["total"]
    assert a["query"] == ""


def test_search_query_too_long(seeded):
    r = client.get("/api/electro/guides", params={"q": "门" * 41})
    assert r.status_code == 422
