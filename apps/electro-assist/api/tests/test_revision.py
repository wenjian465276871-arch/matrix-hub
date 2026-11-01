"""草稿修正与界面发布（决策 #35）。

要证明的五条边界：

1. **没有口令就没有写权限**：未配置口令 503、没带令牌 401；
2. **只能改字，不能改结构**：步骤 id 序列变化一律拒绝（否则历史记录指空）；
3. **判据能改值、不能被凭空发明**：未知判据 id 拒绝，非法区间由模型校验兜住；
4. **发布闸门与 CLI 同一套判据**：缺判据 409 并列出缺口；
5. **已发布不可改**：409，而不是"保存成功但内容没变"。
"""
from __future__ import annotations

import copy

import pytest
from fastapi.testclient import TestClient

from core import passcode
import store
from main import app
from routers import guides as guides_router
from services import library

client = TestClient(app)

CODE = "revision-code"


@pytest.fixture()
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "electro.db"))
    monkeypatch.setenv("ELECTRO_PASSCODE", CODE)
    monkeypatch.setenv("REVISE_PER_HOUR", "50")
    monkeypatch.setenv("REVISE_PER_DAY", "100")
    store.init_db()
    guides_router.reset_attach_limiter()
    guides_router.reset_write_limiter()
    yield
    guides_router.reset_attach_limiter()
    guides_router.reset_write_limiter()


def _token() -> str:
    r = client.post("/api/electro/passcode/verify", json={"code": CODE})
    assert r.status_code == 200, r.text
    return r.json()["token"]


def _base_guide():
    """取一份真实样例当底稿：手写 Guide 容易漏掉字段，测出来的不是线上形状。"""
    samples = library.load_fixtures()
    assert samples, "样例库为空"
    return copy.deepcopy(samples[1] if len(samples) > 1 else samples[0])


def _draft(guide_id: str = "g_revision_draft_001", *, drop_criteria: bool = False):
    guide = _base_guide()
    guide.id = guide_id
    if drop_criteria:
        for step in guide.steps:
            step.criteria = []
    store.save_guide(guide, status="draft")
    return guide


def test_patch_requires_passcode_configured(env, monkeypatch):
    monkeypatch.delenv("ELECTRO_PASSCODE", raising=False)
    guide = _draft()
    r = client.patch(f"/api/electro/guides/{guide.id}", json={"title": "改个名字试试"})
    assert r.status_code == 503
    assert r.json()["detail"]["code"] == "passcode_disabled"


def test_patch_without_token_is_401(env):
    guide = _draft()
    r = client.patch(f"/api/electro/guides/{guide.id}", json={"title": "改个名字试试"})
    assert r.status_code == 401
    assert r.json()["detail"]["code"] == "passcode_required"


def test_patch_updates_title_and_action(env):
    guide = _draft()
    headers = {"X-Passcode-Token": _token()}
    r = client.patch(
        f"/api/electro/guides/{guide.id}",
        json={
            "title": "客室侧门开关门功能试验（已复核）",
            "steps": [{"id": guide.steps[0].id, "action": "人工复核后的动作描述"}],
        },
        headers=headers,
    )
    assert r.status_code == 200, r.text
    assert r.json()["guide"]["title"] == "客室侧门开关门功能试验（已复核）"
    assert r.json()["guide"]["steps"][0]["action"] == "人工复核后的动作描述"
    # 没传的步骤原样保留：部分提交不该把别的步骤清空
    assert r.json()["guide"]["steps"][1]["action"] == guide.steps[1].action

    fresh = client.get(f"/api/electro/guides/{guide.id}").json()
    assert fresh["status"] == "draft"
    assert fresh["guide"]["title"] == "客室侧门开关门功能试验（已复核）"


def test_patch_updates_range_criterion(env):
    guide = _draft()
    target = next(
        (step for step in guide.steps if any(c.type.value == "range" for c in step.criteria)),
        None,
    )
    assert target is not None, "样例里应当有至少一条 range 判据"
    criterion = next(c for c in target.criteria if c.type.value == "range")

    r = client.patch(
        f"/api/electro/guides/{guide.id}",
        json={
            "steps": [
                {
                    "id": target.id,
                    "criteria": [
                        {"id": criterion.id, "min": 1.5, "max": 4.0, "unit": "s"},
                    ],
                }
            ]
        },
        headers={"X-Passcode-Token": _token()},
    )
    assert r.status_code == 200, r.text
    patched = next(s for s in r.json()["guide"]["steps"] if s["id"] == target.id)
    changed = next(c for c in patched["criteria"] if c["id"] == criterion.id)
    assert changed["min"] == 1.5
    assert changed["max"] == 4.0
    # 没被点名的判据不能被删：少传一个字段不等于"删掉这条"
    assert len(patched["criteria"]) == len(target.criteria)


def test_patch_rejects_unknown_step(env):
    """步骤按 id 匹配：传一个不存在的 id 必须拒绝，不能被"就近落到某一步"。"""
    guide = _draft()
    r = client.patch(
        f"/api/electro/guides/{guide.id}",
        json={"steps": [{"id": "s99", "action": "凭空多出来的一步"}]},
        headers={"X-Passcode-Token": _token()},
    )
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "step_unknown"


def test_patch_rejects_unknown_criterion(env):
    guide = _draft()
    r = client.patch(
        f"/api/electro/guides/{guide.id}",
        json={"steps": [{"id": guide.steps[0].id, "criteria": [{"id": "c_not_exist"}]}]},
        headers={"X-Passcode-Token": _token()},
    )
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "criterion_unknown"


def test_patch_rejects_published(env):
    guide = _draft("g_revision_published_001")
    assert store.publish_guide(guide.id)
    r = client.patch(
        f"/api/electro/guides/{guide.id}",
        json={"title": "已发布还想改"},
        headers={"X-Passcode-Token": _token()},
    )
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "published_locked"


def test_patch_rejects_invalid_range(env):
    """min > max 必须在写库前被模型校验拦住，而不是写进去再说。"""
    guide = _draft()
    target = next(
        (s for s in guide.steps if any(c.type.value == "range" for c in s.criteria)),
        None,
    )
    assert target is not None, "样例里应当有至少一条 range 判据"
    criterion = next(c for c in target.criteria if c.type.value == "range")
    r = client.patch(
        f"/api/electro/guides/{guide.id}",
        json={"steps": [{"id": target.id, "criteria": [{"id": criterion.id, "min": 9, "max": 1}]}]},
        headers={"X-Passcode-Token": _token()},
    )
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "invalid_after_patch"


def test_publish_blocks_when_criteria_missing(env):
    guide = _draft("g_revision_blocked_001", drop_criteria=True)
    r = client.post(
        f"/api/electro/guides/{guide.id}/publish",
        headers={"X-Passcode-Token": _token()},
    )
    assert r.status_code == 409
    body = r.json()["detail"]
    assert body["code"] == "publish_blocked"
    assert body["blockers"]
    assert store.get_guide(guide.id)["status"] == "draft"


def test_publish_then_appears_in_list(env):
    guide = _draft("g_revision_publish_ok_001", drop_criteria=True)
    headers = {"X-Passcode-Token": _token()}

    # 缺判据的草稿先被拦住，还没进列表
    assert client.post(f"/api/electro/guides/{guide.id}/publish", headers=headers).status_code == 409

    # 用一份本来就有判据的样例验证成功路径
    ok = _draft("g_revision_publish_ok_002")
    r = client.post(f"/api/electro/guides/{ok.id}/publish", headers=headers)
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "published"

    listed = client.get("/api/electro/guides").json()["items"]
    assert any(item["id"] == ok.id for item in listed)


def test_publish_twice_is_conflict(env):
    guide = _draft("g_revision_twice_001")
    headers = {"X-Passcode-Token": _token()}
    assert client.post(f"/api/electro/guides/{guide.id}/publish", headers=headers).status_code == 200
    second = client.post(f"/api/electro/guides/{guide.id}/publish", headers=headers)
    assert second.status_code == 409
    assert second.json()["detail"]["code"] == "published_locked"


def test_patch_rate_limited(env, monkeypatch):
    monkeypatch.setenv("REVISE_PER_HOUR", "2")
    monkeypatch.setenv("REVISE_SITE_PER_DAY", "2")
    guides_router.reset_write_limiter()
    guide = _draft("g_revision_limited_001")
    headers = {"X-Passcode-Token": _token()}
    for _ in range(2):
        assert (
            client.patch(
                f"/api/electro/guides/{guide.id}", json={"title": "重复改同一处"}, headers=headers
            ).status_code
            == 200
        )
    r = client.patch(
        f"/api/electro/guides/{guide.id}", json={"title": "第三次修改标题"}, headers=headers
    )
    assert r.status_code == 429
    assert r.json()["detail"]["code"] == "rate_limited"
