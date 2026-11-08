"""回滚失败状态：宿主写、容器读、两处消费（`/healthz` 与 `deploy.sh` 闸门）。

这组测试要钉住的是**读不到也算没失败**这个尺度——`/healthz` 不能因为一个状态文件
读不出来就变得不健康，否则部署脚本会回滚一个完全正常的版本。
另外钉住"只暴露必要字段"：状态文件以后可能加内部字段，不能顺着健康检查漏出去。
"""
from __future__ import annotations

import json

from fastapi.testclient import TestClient

from core import rollbackstate
from main import app

client = TestClient(app)


def test_missing_file_means_not_failed(monkeypatch, tmp_path):
    monkeypatch.setenv("ROLLBACK_STATE_PATH", str(tmp_path / "nope.json"))
    assert rollbackstate.summary() == {"failed": False}


def test_corrupt_file_does_not_break_health(monkeypatch, tmp_path):
    path = tmp_path / "bad.json"
    path.write_text("{不是 JSON", encoding="utf-8")
    monkeypatch.setenv("ROLLBACK_STATE_PATH", str(path))
    assert rollbackstate.summary() == {"failed": False}
    r = client.get("/healthz")
    assert r.status_code == 200
    assert r.json()["rollback"] == {"failed": False}


def test_failed_state_surfaces_context(monkeypatch, tmp_path):
    path = tmp_path / "state.json"
    path.write_text(
        json.dumps(
            {
                "failed": True,
                "at": "2026-11-08T19:46:23+08:00",
                "reason": "postdeploy_5xx",
                "detail": "回滚后 6 次健康复查仍未通过（ratio=6/6）",
                "from_tag": "new123",
                "to_tag": "prev456",
                "internal_debug_path": "/root/不该透出.log",
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("ROLLBACK_STATE_PATH", str(path))
    r = client.get("/healthz")
    assert r.status_code == 200
    rollback = r.json()["rollback"]
    assert rollback["failed"] is True
    assert rollback["reason"] == "postdeploy_5xx"
    assert rollback["to_tag"] == "prev456"
    # 白名单之外的字段一律不透出
    assert "internal_debug_path" not in rollback


def test_successful_rollback_reports_not_failed(monkeypatch, tmp_path):
    path = tmp_path / "state.json"
    path.write_text(
        json.dumps({"failed": False, "reason": "postdeploy_5xx", "to_tag": "prev456"}),
        encoding="utf-8",
    )
    monkeypatch.setenv("ROLLBACK_STATE_PATH", str(path))
    # 成功回滚只说明"刚才那版坏了、已经退回去"，不该让后续部署被闸门拦住
    assert rollbackstate.summary() == {"failed": False}
