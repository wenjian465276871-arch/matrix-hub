"""指导书读取端点的契约测试。

关注点不是"能返回 JSON"，而是五条边界：
1. 列表不返回全文（避免列表页拉几十 KB）；
2. 列表只返回已发布（决策 #16：草稿不上公开列表）；
3. 未知/畸形 id 一律 404，不泄露目录结构；
4. 坏样例被跳过而不是让整个接口 500；
5. 详情返回 `{status, guide}` 信封，前端据此标"草稿"。
"""
from __future__ import annotations

import json
import shutil
import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import store
from main import app
from models.guide import SCHEMA_VERSION
from services import library

client = TestClient(app)
SAMPLES = Path(__file__).resolve().parent.parent / "samples"
SAMPLE_ID = "g_door_clearance_001"


@pytest.fixture()
def fresh_library(tmp_path, monkeypatch):
    """每个用例一套独立库：seed 状态不互相污染。"""
    monkeypatch.setenv("DB_PATH", str(tmp_path / "electro.db"))
    monkeypatch.setenv("GUIDE_DIR", str(SAMPLES))
    monkeypatch.setenv("SEED_GUIDES", "1")
    store.init_db()
    library.ensure_seeded()
    return tmp_path


def test_list_returns_summary_not_full_body(fresh_library):
    r = client.get("/api/electro/guides")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["count"] >= 1
    item = next(i for i in body["items"] if i["id"] == SAMPLE_ID)
    assert item["step_count"] == 3
    assert item["system"] == "door"
    assert item["status"] == "published"
    assert "steps" not in item
    assert item["source_note"]


def test_get_returns_full_guide(fresh_library):
    r = client.get(f"/api/electro/guides/{SAMPLE_ID}")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "published"
    guide = body["guide"]
    assert guide["schema_version"] == SCHEMA_VERSION  # 样例已随契约升到 1.2
    assert len(guide["steps"]) == 3
    assert guide["steps"][0]["seq"] == 1
    assert "演示数据 · 非实际作业依据" in guide["disclaimers"]
    # 图元参数被原样保留，前端渲染器据此分发
    assert guide["steps"][1]["figures"][0]["primitive"] == "meter"


def test_draft_is_not_listed_but_reachable_by_id(fresh_library):
    guide = library.load_fixtures(SAMPLES)[0]
    guide.id = "g_draft_only_001"
    store.save_guide(guide, status="draft")

    listed = client.get("/api/electro/guides").json()
    assert all(item["id"] != "g_draft_only_001" for item in listed["items"])

    detail = client.get("/api/electro/guides/g_draft_only_001")
    assert detail.status_code == 200
    assert detail.json()["status"] == "draft"


def test_unknown_id_is_404(fresh_library):
    assert client.get("/api/electro/guides/g_not_exist_000").status_code == 404


def test_malformed_id_is_404(fresh_library):
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

    monkeypatch.setenv("DB_PATH", str(tmp_path / "electro.db"))
    monkeypatch.setenv("GUIDE_DIR", str(tmp_path))
    monkeypatch.setenv("SEED_GUIDES", "1")
    store.init_db()

    body = client.get("/api/electro/guides").json()
    assert body["count"] == 1
    assert body["items"][0]["id"] == SAMPLE_ID


def test_empty_dir_returns_empty_list(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "electro.db"))
    monkeypatch.setenv("GUIDE_DIR", str(tmp_path))
    monkeypatch.setenv("SEED_GUIDES", "1")
    store.init_db()

    body = client.get("/api/electro/guides").json()
    assert body == {"schema_version": SCHEMA_VERSION, "count": 0, "items": []}


def test_every_primitive_has_sample_coverage():
    """样例必须覆盖全部视觉原语。

    没有样例覆盖的原语，前端渲染器就等于没有验收对象——T07 的 M1 判据正是
    "七个原语都能在真实页面上渲染出来"。少一个，这条判据就没法成立。
    """
    from models.visual import Primitive

    used = {
        fig.primitive.value
        for guide in library.load_fixtures(SAMPLES)
        for step in guide.steps
        for fig in step.figures
    }
    missing = {p.value for p in Primitive} - used
    assert not missing, f"以下原语没有任何样例覆盖：{sorted(missing)}"


def test_formal_sample_has_connector_and_wiring():
    """正式案例的硬要求：5–8 步、至少一张接线/针脚图、来源可溯。"""
    guides = {g.id: g for g in library.load_fixtures(SAMPLES)}
    guide = guides["g_door_switch_formal_001"]
    assert 5 <= len(guide.steps) <= 8
    primitives = {fig.primitive.value for step in guide.steps for fig in step.figures}
    assert {"connector", "wiring"} <= primitives
    assert "公开资料" in guide.meta.source_note
    # 每个接线类图元都要给出可降级的文字说明，否则渲染失败时现场看不懂
    for step in guide.steps:
        for fig in step.figures:
            assert fig.fallback_text.strip()


def test_hvac_migration_sample_exists():
    """判据 4：换子系统仍可跑通。

    空调案例是迁移验证的线上证据；没有它，"同一框架可复用"只是一句话。
    这里只校验它能被 Guide 解析、声明齐全，渲染覆盖由原语测试负责。
    """
    guides = {g.id: g for g in library.load_fixtures(SAMPLES)}
    assert "g_hvac_cooling_check" in guides
    hvac = guides["g_hvac_cooling_check"]
    assert hvac.meta.system.value == "hvac"
    assert 3 <= len(hvac.steps) <= 8
    assert "演示数据 · 非实际作业依据" in hvac.disclaimers
    assert hvac.meta.is_demo is True


def test_pantograph_migration_sample_exists():
    """第二个迁移案例：受电弓。

    空调只证明"换一个子系统能跑"，再加一个才排除"恰好空调和车门相似"；
    同时也把 3 个子系统（车门/空调/受电弓）在 A2 侧补齐——B 侧早已有受电弓知识库。
    """
    guides = {g.id: g for g in library.load_fixtures(SAMPLES)}
    assert "g_pantograph_raise_check" in guides
    panto = guides["g_pantograph_raise_check"]

    assert panto.meta.system.value == "pantograph"
    assert 3 <= len(panto.steps) <= 8
    assert "演示数据 · 非实际作业依据" in panto.disclaimers
    assert panto.meta.is_demo is True
    assert "公开资料" in panto.meta.source_note

    # 判据要覆盖"自动判定 + 人工确认"两类，否则换子系统只是换了文案
    types = {c.type.value for step in panto.steps for c in step.criteria}
    assert {"range", "manual"} <= types
    # 每个图元都要能降级成文字：现场渲染失败时靠这句话
    for step in panto.steps:
        for fig in step.figures:
            assert fig.fallback_text.strip()


def test_seed_adds_missing_fixtures_without_touching_existing(tmp_path, monkeypatch):
    """部署新增样例后，已有记录不被覆盖，缺的补进来。"""
    shutil.copy(SAMPLES / "door_clearance.json", tmp_path / "a.json")
    monkeypatch.setenv("DB_PATH", str(tmp_path / "electro.db"))
    monkeypatch.setenv("GUIDE_DIR", str(tmp_path))
    monkeypatch.setenv("SEED_GUIDES", "1")
    store.init_db()

    assert library.ensure_seeded() == 1

    # 已发布内容受保护：拿到同一个 id 再存一次只会 skipped，不改内容。
    guide = library.load_fixtures(tmp_path)[0]
    guide.title = "人工改过的标题"
    assert store.save_guide(guide, status="published")["skipped"] is True

    shutil.copy(SAMPLES / "door_switch_formal.json", tmp_path / "b.json")
    library._seeded_paths.clear()  # 模拟进程重启
    assert library.ensure_seeded() == 1
    assert store.get_guide("g_door_clearance_001")["title"] == "客室侧门关闭间隙检查"
    assert store.get_guide("g_door_switch_formal_001") is not None


def test_normalize_schema_versions_only_touches_stamp(tmp_path, monkeypatch):
    """存量 1.0/1.1 指导书要能被归一化，但只改版本戳。

    这条测试守的是 2026-10-29 踩过的坑：线上样例一直返回 1.1，
    看起来像"部署没生效"，实际是历史 JSON 里的旧版本号。
    """
    monkeypatch.setenv("DB_PATH", str(tmp_path / "electro.db"))
    store.init_db()

    data = json.loads((SAMPLES / "door_switch_test.json").read_text(encoding="utf-8"))
    data["schema_version"] = "1.0"
    payload = json.dumps(data, ensure_ascii=False)
    con = sqlite3.connect(store.db_path())
    try:
        with con:
            con.execute(
                "INSERT INTO guides (id, schema_version, title, system, status, json,"
                " step_count, created_at, updated_at)"
                " VALUES (?, '1.0', ?, 'door', 'published', ?, ?, 'x', 'x')",
                (data["id"], data["title"], payload, len(data["steps"])),
            )
            # 内容真的不兼容的记录：必须跳过，不能硬掰版本号
            con.execute(
                "INSERT INTO guides (id, schema_version, title, system, status, json,"
                " step_count, created_at, updated_at)"
                " VALUES ('g_broken_0001', '1.0', '坏数据', 'door', 'draft', '{}', 0, 'x', 'x')"
            )
    finally:
        con.close()

    assert library.normalize_schema_versions() == 1
    row = store.get_guide(data["id"])
    assert row["schema_version"] == SCHEMA_VERSION
    assert row["guide"]["schema_version"] == SCHEMA_VERSION
    assert len(row["guide"]["steps"]) == len(data["steps"])
    assert row["status"] == "published"  # 发布状态没被顺手改掉
    # 坏数据原样留着，版本号不动
    assert store.get_guide("g_broken_0001")["schema_version"] == "1.0"
    # 幂等：第二次没有可改的
    assert library.normalize_schema_versions() == 0
