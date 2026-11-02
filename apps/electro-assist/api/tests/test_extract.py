"""图片识别（`POST /extract`）的契约测试。

用 stub provider 而不是真模型：这里要验证的是**边界**——缺少 Key、图不存在、
模型编数、模型乱写 JSON、调用超限——这些用真模型反而测不稳定。
"""
from __future__ import annotations

import io
import json

import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw

import store
from llm.base import Completion, LLMError, Usage
from main import app
from routers import extract as extract_router

client = TestClient(app)


@pytest.fixture(autouse=True)
def _reset(monkeypatch):
    extract_router.reset_limiter()
    yield
    extract_router.reset_limiter()


@pytest.fixture()
def tmp_uploads(tmp_path, monkeypatch):
    monkeypatch.setenv("UPLOAD_DIR", str(tmp_path / "uploads"))
    return str(tmp_path / "uploads")


def _image() -> bytes:
    im = Image.new("RGB", (1600, 1200), "white")
    d = ImageDraw.Draw(im)
    d.text((60, 60), "Process: door switch test", fill="black")
    buf = io.BytesIO()
    im.save(buf, format="PNG")
    return buf.getvalue()


def _asset() -> str:
    r = client.post(
        "/api/electro/uploads", files={"file": ("p.png", _image(), "image/png")}
    )
    assert r.status_code == 200, r.text
    return r.json()["asset_id"]


class StubVision:
    """模拟两段式（决策 #37）：`vision` 只回转录，`structured` 只回字段。

    真实模型在两个通道里看到的是两套提示词；stub 用 `system` 文本里的
    特征串区分，因此**同一条用例既能测 dual，也能在
    `EXTRACT_MODE=single` 下测单通道**——后者 `structured` 不会被调用。

    构造参数仍是一份完整 payload 字符串：解析得出来就拆成两半分别返回，
    解析不出来（比如故意喂乱码）就原样回传，让解析失败的那条路径照常触发。
    """

    name = "stub-vision"

    def __init__(
        self,
        text: str,
        *,
        structure_text: str | None = None,
        error: LLMError | None = None,
    ):
        self.text = text
        self.structure_text = structure_text
        self.error = error
        self.calls: list[dict] = []
        self.structured_calls: list[dict] = []
        try:
            self.data = json.loads(text)
        except (TypeError, ValueError):
            self.data = None

    def vision(self, **kwargs) -> Completion:
        self.calls.append(kwargs)
        if self.error is not None:
            raise self.error
        system = kwargs.get("system", "")
        # 转录通道的提示词以「只做一件事」起头（见 llm/extract.TRANSCRIBE_SYSTEM）。
        if "只做一件事" in system and isinstance(self.data, dict):
            body = {"lines": self.data.get("lines", []), "warnings": self.data.get("warnings", [])}
            text = json.dumps(body, ensure_ascii=False)
        else:
            text = self.text
        return Completion(
            text=text,
            model="stub-vision",
            usage=Usage(prompt_tokens=1200, completion_tokens=300),
            latency_ms=42,
        )

    def structured(self, **kwargs) -> Completion:
        self.structured_calls.append(kwargs)
        if self.structure_text is not None:
            text = self.structure_text
        elif isinstance(self.data, dict):
            body = {"fields": self.data.get("fields", {}), "warnings": []}
            text = json.dumps(body, ensure_ascii=False)
        else:
            text = '{"fields": {"steps": []}}'
        return Completion(
            text=text,
            model="stub-vision",
            usage=Usage(prompt_tokens=400, completion_tokens=200),
            latency_ms=35,
        )


def _payload(lines: list[str], steps: list[dict], **fields) -> str:
    return json.dumps(
        {
            "lines": lines,
            "fields": {
                "name": fields.get("name"),
                "station": fields.get("station"),
                "tools": fields.get("tools", []),
                "safety": fields.get("safety", []),
                "steps": steps,
            },
            "warnings": fields.get("warnings", []),
        },
        ensure_ascii=False,
    )


def test_missing_key_returns_503(tmp_uploads, monkeypatch):
    asset = _asset()

    def boom():
        raise LLMError("auth", "未配置 DEEPSEEK_API_KEY")

    monkeypatch.setattr(extract_router, "get_provider", boom)
    r = client.post("/api/electro/extract", json={"asset_ids": [asset]})
    assert r.status_code == 503
    assert r.json()["detail"]["code"] == "vision_not_configured"


def test_unknown_asset_returns_422(tmp_uploads):
    r = client.post("/api/electro/extract", json={"asset_ids": ["a_0000000000000000"]})
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "asset_not_found"


def test_too_many_assets_returns_422(tmp_uploads):
    asset = _asset()
    r = client.post("/api/electro/extract", json={"asset_ids": [asset] * 4})
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "too_many_assets"


def test_extract_returns_reviewable_draft(tmp_uploads, monkeypatch):
    asset = _asset()
    text = _payload(
        lines=["工序：客室侧门开关门功能试验", "工位：3 号车门", "1. 开关门各 3 次，开门时间 2.0–3.5s"],
        steps=[{"seq": 1, "action": "开关门各 3 次，开门时间 2.0–3.5s", "criterion": "2.0–3.5s", "source_line": 2}],
        name="客室侧门开关门功能试验",
        station="3 号车门",
    )
    stub = StubVision(text)
    monkeypatch.setattr(extract_router, "get_provider", lambda: stub)

    before = store.usage_summary()
    r = client.post("/api/electro/extract", json={"asset_ids": [asset]})
    assert r.status_code == 200, r.text
    body = r.json()

    assert body["needs_review"] is True
    assert body["fields"]["name"] == "客室侧门开关门功能试验"
    assert body["fields"]["steps"][0]["verified"] is True
    assert body["fields"]["steps"][0]["source_line"] == 2
    assert body["stats"]["verified_steps"] == 1
    assert stub.calls and len(stub.calls[0]["images"]) == 1
    assert stub.calls[0]["images"][0].startswith("data:image/png;base64,")

    # 默认走双通道：A 看图转录（带图），B 只吃文本（不带图）。两次都记账。
    assert body["channels"]["mode"] == "dual"
    assert body["channels"]["calls"] == 2
    assert stub.structured_calls and "images" not in stub.structured_calls[0]

    after = store.usage_summary()
    assert after["calls"] == before["calls"] + 2
    assert after["cost_micros"] > before["cost_micros"]


def test_dual_reports_channel_coverage(tmp_uploads, monkeypatch):
    """覆盖度是"两通道有没有对上"的唯一量化指标，必须出现在返回里。"""
    asset = _asset()
    text = _payload(
        lines=["工序：开关门试验", "工位：3 号门", "1. 开关门各 3 次", "2. 记录时间"],
        steps=[
            {"seq": 1, "action": "开关门各 3 次", "source_line": 2},
            {"seq": 2, "action": "记录时间", "source_line": 3},
        ],
    )
    monkeypatch.setattr(extract_router, "get_provider", lambda: StubVision(text))

    body = client.post("/api/electro/extract", json={"asset_ids": [asset]}).json()
    assert body["channels"]["mode"] == "dual"
    assert body["channels"]["transcribe"]["lines"] == 4
    # 4 行里被结构化阶段引用 2 行 → 0.5
    assert body["channels"]["structure"]["coverage"] == 0.5
    assert body["channels"]["fallback"] is None


def test_structure_failure_falls_back_to_single(tmp_uploads, monkeypatch):
    """通道 B 输出不合法时回退单通道，并把原因如实带回去。

    静默回退是这里最危险的失败模式：结果看起来一模一样，
    但少了一层"字段必须能在原文里找到"的保证，核对强度不同。
    """
    asset = _asset()
    text = _payload(
        lines=["1. 开关门各 3 次"],
        steps=[{"seq": 1, "action": "开关门各 3 次"}],
    )
    stub = StubVision(text, structure_text="字段大概是这个意思")
    monkeypatch.setattr(extract_router, "get_provider", lambda: stub)

    body = client.post("/api/electro/extract", json={"asset_ids": [asset]}).json()
    assert body["channels"]["mode"] == "single"
    assert body["channels"]["fallback"] == "structure_invalid"
    # 回退路径仍要给出可用结果，而不是 502
    assert body["fields"]["steps"][0]["action"] == "开关门各 3 次"


def test_single_mode_calls_once(tmp_uploads, monkeypatch):
    """`EXTRACT_MODE=single` 保留原行为：一次调用、不出通道统计。"""
    monkeypatch.setenv("EXTRACT_MODE", "single")
    asset = _asset()
    text = _payload(
        lines=["1. 开关门各 3 次"],
        steps=[{"seq": 1, "action": "开关门各 3 次"}],
    )
    stub = StubVision(text)
    monkeypatch.setattr(extract_router, "get_provider", lambda: stub)

    body = client.post("/api/electro/extract", json={"asset_ids": [asset]}).json()
    assert body["channels"]["mode"] == "single"
    assert body["channels"]["calls"] == 1
    assert not stub.structured_calls


def test_fabricated_numbers_are_stripped(tmp_uploads, monkeypatch):
    asset = _asset()
    # 图里只写了 2.0–3.5s，模型却给出 1.0–2.0s：判据必须被清空并标 unverified
    text = _payload(
        lines=["1. 开关门各 3 次，开门时间 2.0–3.5s"],
        steps=[{"seq": 1, "action": "开关门各 3 次", "criterion": "1.0–2.0s", "source_line": 0}],
    )
    monkeypatch.setattr(extract_router, "get_provider", lambda: StubVision(text))

    body = client.post("/api/electro/extract", json={"asset_ids": [asset]}).json()
    step = body["fields"]["steps"][0]
    assert step["criterion"] is None
    assert any("1.0" in item for item in body["unverified"])
    assert any("已清空判据" in item for item in body["unverified"])


def test_missing_fields_are_marked_unverified(tmp_uploads, monkeypatch):
    asset = _asset()
    text = _payload(
        lines=["1. 开关门各 3 次"],
        steps=[{"seq": 1, "action": "开关门各 3 次"}],
        name="凭空冒出来的工序名",
    )
    monkeypatch.setattr(extract_router, "get_provider", lambda: StubVision(text))

    body = client.post("/api/electro/extract", json={"asset_ids": [asset]}).json()
    assert body["fields"]["name"] is None
    assert any("工序名称" in item for item in body["unverified"])


def test_invalid_json_returns_502(tmp_uploads, monkeypatch):
    asset = _asset()
    monkeypatch.setattr(extract_router, "get_provider", lambda: StubVision("这张图看起来是工艺文件"))
    r = client.post("/api/electro/extract", json={"asset_ids": [asset]})
    assert r.status_code == 502
    assert r.json()["detail"]["code"] == "extract_invalid"


def test_vision_timeout_returns_504(tmp_uploads, monkeypatch):
    """模型超时必须映射成 504，而不是被兜底处理器接成 500。

    这条是 2026-11-02 线上事故的回归测试：重写双通道时把 `extract()` 里
    那层 `except LLMError` 弄丢了，超时冒泡到 `main.py` 的兜底处理器，
    前端拿到「服务内部错误」，日志里还多一份无意义的堆栈。
    """
    asset = _asset()
    error = LLMError("timeout", "图片识别超过 60s")
    monkeypatch.setattr(extract_router, "get_provider", lambda: StubVision("", error=error))

    r = client.post("/api/electro/extract", json={"asset_ids": [asset]})
    assert r.status_code == 504
    assert r.json()["detail"]["code"] == "extract_timeout"


def test_vision_truncated_returns_502(tmp_uploads, monkeypatch):
    """输出被 max_tokens 截断：要说「内容太多」，不能只说"失败"。

    实测教训：`deepseek-flash` 的 reasoning 也计入 completion，
    3000 的上限被思考吃满，正文一个字都没输出。
    """
    asset = _asset()
    error = LLMError("truncated", "输出被截断")
    monkeypatch.setattr(extract_router, "get_provider", lambda: StubVision("", error=error))

    r = client.post("/api/electro/extract", json={"asset_ids": [asset]})
    assert r.status_code == 502
    assert r.json()["detail"]["code"] == "extract_truncated"


def test_vision_budget_is_8192_tokens(tmp_uploads, monkeypatch):
    """识别链路的 max_tokens 必须留够"想 + 说"的空间。

    3000 是事故值；这条断言防的是有人顺手把它调回去。
    """
    asset = _asset()
    text = _payload(lines=["1. 检查门机"], steps=[{"seq": 1, "action": "检查门机"}])
    stub = StubVision(text)
    monkeypatch.setattr(extract_router, "get_provider", lambda: stub)

    assert client.post("/api/electro/extract", json={"asset_ids": [asset]}).status_code == 200
    assert stub.calls[0]["max_tokens"] >= 8192
    assert stub.structured_calls[0]["max_tokens"] >= 8192


def test_rate_limited(tmp_uploads, monkeypatch):
    asset = _asset()
    text = _payload(lines=["1. 检查门机"], steps=[{"seq": 1, "action": "检查门机"}])
    monkeypatch.setattr(extract_router, "get_provider", lambda: StubVision(text))

    for _ in range(3):
        assert client.post("/api/electro/extract", json={"asset_ids": [asset]}).status_code == 200
    r = client.post("/api/electro/extract", json={"asset_ids": [asset]})
    assert r.status_code == 429
    assert r.json()["detail"]["code"] == "rate_limited"
