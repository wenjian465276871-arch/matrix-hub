"""B 模块流式（`POST /diagnose?stream=1`）。

流式的价值全在"每帧真的完成了一步"。所以要证明：

1. 帧顺序是 recall → rerank → done，且 `done` 里是完整结果；
2. 未覆盖时只有两帧——没有候选就没有重排，发空帧等于假装还在算；
3. 重排关闭/失败时 `applied=false`，但结果照出（排序退化不等于查不到）；
4. 非流式路径一字不变（老客户端与 curl 不受影响）。
"""
from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from main import app
from routers import diagnose as diagnose_router

client = TestClient(app)

SYMPTOM = "开门没有反应，按了开门按钮门不动"


@pytest.fixture(autouse=True)
def _reset():
    diagnose_router.reset_limiter()
    yield
    diagnose_router.reset_limiter()


def _frames(raw: str) -> list[tuple[str, dict]]:
    """按 SSE 规矩切帧：空行分隔，`event:` 与 `data:` 各一行。"""
    out: list[tuple[str, dict]] = []
    for block in raw.split("\n\n"):
        if not block.strip():
            continue
        event = "message"
        data = None
        for line in block.splitlines():
            if line.startswith("event:"):
                event = line[len("event:") :].strip()
            elif line.startswith("data:"):
                data = json.loads(line[len("data:") :].strip())
        assert data is not None, f"帧缺少 data：{block!r}"
        out.append((event, data))
    return out


def test_stream_emits_three_stages():
    r = client.post("/api/electro/diagnose?stream=1", json={"symptom": SYMPTOM})
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/event-stream")

    frames = _frames(r.text)
    assert [event for event, _ in frames] == ["recall", "rerank", "done"]

    recall = frames[0][1]
    assert recall["stage"] == "recall"
    assert recall["count"] >= 1
    assert recall["candidates"]

    rerank = frames[1][1]
    assert rerank["stage"] == "rerank"
    # 没配 Key 的测试环境里重排不可用：`applied` 必须是 false，而不是假装排过
    assert rerank["applied"] is False
    assert len(rerank["order"]) == recall["count"]

    done = frames[2][1]
    assert done["matched"] is True
    assert done["results"]
    assert done["count"] == len(done["results"])
    # 最终帧必须是一次性接口的同一份结构（前端两套解析会漂移）
    plain = client.post("/api/electro/diagnose", json={"symptom": SYMPTOM}).json()
    assert set(plain) == set(done)


def test_uncovered_stream_has_two_frames():
    r = client.post("/api/electro/diagnose?stream=1", json={"symptom": "咖啡机不出水了怎么办"})
    frames = _frames(r.text)
    assert [event for event, _ in frames] == ["recall", "done"]
    assert frames[0][1]["count"] == 0
    assert frames[1][1]["matched"] is False
    assert frames[1][1]["uncovered_reason"] in {"no_match", "system_not_covered"}


def test_stream_respects_rerank_switch(monkeypatch):
    monkeypatch.setenv("DIAGNOSE_RERANK", "0")
    r = client.post("/api/electro/diagnose?stream=1", json={"symptom": SYMPTOM})
    frames = _frames(r.text)
    assert frames[1][1]["applied"] is False
    assert frames[-1][0] == "done"


def test_non_stream_unchanged():
    r = client.post("/api/electro/diagnose", json={"symptom": SYMPTOM})
    assert r.status_code == 200
    body = r.json()
    assert body["matched"] is True
    assert "results" in body and "rerank" in body


def test_stream_rate_limited_before_frames(monkeypatch):
    """限流必须在开流之前判定：已经开始推帧就没法再改状态码了。"""
    monkeypatch.setenv("DIAGNOSE_PER_HOUR", "1")
    monkeypatch.setenv("DIAGNOSE_SITE_PER_DAY", "1")
    diagnose_router.reset_limiter()

    assert client.post("/api/electro/diagnose?stream=1", json={"symptom": SYMPTOM}).status_code == 200
    r = client.post("/api/electro/diagnose?stream=1", json={"symptom": SYMPTOM})
    assert r.status_code == 429
    assert r.headers["Retry-After"]


# ------------------------------------------------ 传输层重连（决策 #45）


def test_resume_from_recall_skips_it():
    """客户端说"收到 recall 了"：不重发它，直接给 rerank + done。

    这条不是省流量，是省一次模型调用——重连时最贵的那一步恰好就是重排。
    """
    r = client.post(
        "/api/electro/diagnose?stream=1",
        json={"symptom": SYMPTOM},
        headers={"Last-Event-ID": "recall"},
    )
    assert r.status_code == 200
    frames = _frames(r.text)
    assert [event for event, _ in frames] == ["rerank", "done"]
    assert frames[-1][1]["matched"] is True


def test_resume_from_rerank_only_done():
    r = client.post(
        "/api/electro/diagnose?stream=1",
        json={"symptom": SYMPTOM},
        headers={"Last-Event-ID": "rerank"},
    )
    frames = _frames(r.text)
    assert [event for event, _ in frames] == ["done"]
    assert frames[0][1]["results"]


def test_resume_with_unknown_value_is_ignored():
    """白名单外的值当没断点处理：旧客户端、中间层乱加头都不该把结果弄没。"""
    r = client.post(
        "/api/electro/diagnose?stream=1",
        json={"symptom": SYMPTOM},
        headers={"Last-Event-ID": "recall,rerank"},
    )
    assert r.status_code == 200
    frames = _frames(r.text)
    assert [event for event, _ in frames] == ["recall", "rerank", "done"]


def test_resume_point_never_reached_reports_error():
    """断点名合法但本流程不会产出（例如 `error`）：必须显式报错，不能给空流。

    空流会让前端以为"服务端卡住了"，而真正的原因是两边版本对不上。
    """
    r = client.post(
        "/api/electro/diagnose?stream=1",
        json={"symptom": SYMPTOM},
        headers={"Last-Event-ID": "error"},
    )
    frames = _frames(r.text)
    assert len(frames) == 1
    assert frames[0][0] == "error"
    assert frames[0][1]["code"] == "resume_mismatch"
