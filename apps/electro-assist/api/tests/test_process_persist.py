"""工艺落库与「用同一份工艺重新生成」（计划 §3.5，2026-11-03 补齐）。

三条边界：
1. `save=false` 仍是纯预检——加了一张表不等于让老调用方多写一行；
2. 重新生成走同一套配额，换入口不是换额度；
3. 保留期 30 天，且仍被指导书引用的工艺不许删。
"""
from __future__ import annotations

import copy
import json
import re
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import store
from llm import Completion, Usage
from main import app
from routers import processes as processes_router
from services import generation
from services.jobqueue import job_queue

client = TestClient(app)

SAMPLE = json.loads(
    (Path(__file__).resolve().parent.parent / "data" / "samples" / "door_switch_test.json").read_text(
        encoding="utf-8"
    )
)

TEXT = """工序：客室侧门开关门功能试验
工位：3 号车门
工具：秒表、塞尺
1. 确认门区无人，挂检修牌。
2. 开关门各 3 次，开门时间应为 2.0–3.5s。
3. 检查门到位信号 S4/S5，两路均应导通。
安全提示：禁止把手放在门缝处。"""

PID_RE = re.compile(r"^p_[0-9a-f]{16}$")


@pytest.fixture()
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "electro.db"))
    monkeypatch.setenv("GENERATE_PER_HOUR", "2")
    monkeypatch.setenv("GENERATE_PER_DAY", "10")
    monkeypatch.setenv("GENERATE_DAILY_BUDGET_MICROS", "3000000")
    store.init_db()
    job_queue.reset()
    processes_router.reset_limiter()
    yield
    job_queue.reset()
    processes_router.reset_limiter()


def _save(text: str = TEXT) -> str:
    r = client.post("/api/electro/processes", json={"text": text, "save": True})
    assert r.status_code == 200, r.text
    pid = r.json()["process_id"]
    assert PID_RE.match(pid), pid
    return pid


def _count_processes() -> int:
    con = sqlite3.connect(store.db_path())
    try:
        return int(con.execute("SELECT COUNT(*) FROM processes").fetchone()[0])
    finally:
        con.close()


class _FakeProvider:
    """只回一份合法 Guide；不碰网络，不验模型质量。"""

    name = "fake-model"

    def __init__(self, body: dict):
        self.body = copy.deepcopy(body)

    def structured(self, **_kwargs) -> Completion:
        return Completion(
            text=json.dumps(self.body, ensure_ascii=False),
            model=self.name,
            usage=Usage(prompt_tokens=1000, completion_tokens=500, reasoning_tokens=100),
            latency_ms=12,
        )

    def close(self) -> None:
        pass


def test_save_persists_and_reads_back(env):
    pid = _save()

    r = client.get(f"/api/electro/processes/{pid}")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["id"] == pid
    assert body["text"].startswith("工序：客室侧门开关门功能试验")
    # 标题取「工序：」之后的第一行，不调模型、不做摘要
    assert body["title"] == "客室侧门开关门功能试验"
    assert body["chars"] == len(TEXT.strip())


def test_precheck_without_save_writes_nothing(env):
    before = _count_processes()
    r = client.post("/api/electro/processes", json={"text": TEXT})
    assert r.status_code == 200
    assert r.json()["process_id"] is None
    assert _count_processes() == before


def test_unknown_process_is_404(env):
    assert client.get("/api/electro/processes/p_0000000000000000").status_code == 404
    assert client.get("/api/electro/processes/not-a-process").status_code == 404
    r = client.post("/api/electro/processes/p_0000000000000000/generate", json={})
    assert r.status_code == 404
    assert r.json()["detail"]["code"] == "process_not_found"


def test_regenerate_uses_stored_text_and_shares_quota(env):
    pid = _save()

    first = client.post(f"/api/electro/processes/{pid}/generate", json={})
    assert first.status_code == 202, first.text
    job_id = first.json()["job_id"]
    assert PID_RE.match(first.json()["process_id"])

    job = store.get_job(job_id)
    assert job is not None
    assert job["process_id"] == pid
    # 重新生成不会新建工艺：同一份工艺的多次生成应指向同一个 id
    assert _count_processes() == 1

    assert client.post(f"/api/electro/processes/{pid}/generate", json={}).status_code == 202
    # 第 3 次撞上每 IP 2 次/时的配额：换入口不等于换额度
    third = client.post(f"/api/electro/processes/{pid}/generate", json={})
    assert third.status_code == 429
    assert "quota" in third.json()["detail"]["code"]


def test_generate_autosaves_process(env):
    r = client.post("/api/electro/generate", json={"text": TEXT})
    assert r.status_code == 202, r.text
    job = store.get_job(r.json()["job_id"])
    pid = job["process_id"]
    assert pid and PID_RE.match(pid)

    saved = client.get(f"/api/electro/processes/{pid}").json()
    # 存的是 strip 后的原文：多两个空格会让"同一条工艺"在库里变成两条
    assert saved["text"] == TEXT.strip()


def test_retry_reuses_original_process(env):
    first = client.post("/api/electro/generate", json={"text": TEXT})
    job_id = first.json()["job_id"]
    pid = store.get_job(job_id)["process_id"]

    # 重试只接受"原任务失败"：手工打成 failed，模拟一次真实失败
    con = sqlite3.connect(store.db_path())
    try:
        with con:
            con.execute(
                "UPDATE jobs SET status='failed', error_code='internal' WHERE id = ?", (job_id,)
            )
    finally:
        con.close()

    retry = client.post("/api/electro/generate", json={"text": TEXT, "retry_of": job_id})
    assert retry.status_code == 202, retry.text
    retry_job = store.get_job(retry.json()["job_id"])
    # 同一份工艺再来一次，不该多出一份原文
    assert retry_job["process_id"] == pid
    assert _count_processes() == 1


def test_generated_guide_links_back_to_process(env):
    """生成成功要把 process_id 写进指导书，详情页才有「再生成」入口。"""
    r = client.post("/api/electro/generate", json={"text": TEXT})
    assert r.status_code == 202, r.text
    job_id = r.json()["job_id"]
    pid = store.get_job(job_id)["process_id"]

    generation.run(job_id, TEXT, provider_factory=lambda: _FakeProvider(SAMPLE))

    job = store.get_job(job_id)
    assert job["status"] == "succeeded", job["error_detail"]
    assert store.get_guide(job["guide_id"])["process_id"] == pid

    detail = client.get(f"/api/electro/guides/{job['guide_id']}").json()
    assert detail["process_id"] == pid


def test_expired_process_is_purged_unless_referenced(env):
    now = datetime.now(timezone.utc)
    old = (now - timedelta(days=40)).isoformat(timespec="seconds")
    orphan, referenced = "p_" + "a" * 16, "p_" + "b" * 16

    con = sqlite3.connect(store.db_path())
    try:
        with con:
            for pid in (orphan, referenced):
                con.execute(
                    "INSERT INTO processes (id, title, system, text, chars, input_sha256,"
                    " created_at, updated_at) VALUES (?, '旧工艺', '', '文本', 2, '', ?, ?)",
                    (pid, old, old),
                )
            con.execute(
                "INSERT INTO guides (id, schema_version, title, system, status, json,"
                " process_id, created_at, updated_at)"
                " VALUES ('g_old_process_001', '1.2', '旧指导书', 'door', 'published', '{}', ?, ?, ?)",
                (referenced, old, old),
            )
    finally:
        con.close()

    _save()  # 任意一次写入触发过期清理

    con = sqlite3.connect(store.db_path())
    try:
        left = {row[0] for row in con.execute("SELECT id FROM processes")}
    finally:
        con.close()
    assert orphan not in left
    assert referenced in left
