"""DeepSeek Provider 的错误映射测试。

全部走 `httpx.MockTransport`，不触网、不花钱、可在 CI 跑。
这里真正要钉住的是**该不该重试**：把 401 判成可重试，会在错误的 Key 上
连打两次并各自等 40 秒；把 429 判成不可重试，则高峰期必然大面积失败。
"""
from __future__ import annotations

import json

import httpx
import pytest

from llm.base import LLMError
from llm.deepseek import DeepSeekProvider

SCHEMA = {"type": "object", "properties": {"id": {"type": "string"}}}
CALL = dict(system="sys", user="usr", schema=SCHEMA, timeout_s=1.0)


def _provider(handler) -> DeepSeekProvider:
    return DeepSeekProvider("sk-test-key", transport=httpx.MockTransport(handler))


def _ok_body(content: str = '{"id":"g_x"}', finish: str = "stop") -> dict:
    return {
        "model": "deepseek-flash",
        "choices": [{"message": {"content": content}, "finish_reason": finish}],
        "usage": {
            "prompt_tokens": 1200,
            "completion_tokens": 300,
            "prompt_cache_hit_tokens": 200,
            "completion_tokens_details": {"reasoning_tokens": 120},
        },
    }


def test_success_parses_usage_and_headers():
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["auth"] = request.headers.get("authorization")
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json=_ok_body())

    with _provider(handler) as p:
        out = p.structured(**CALL)

    assert out.text == '{"id":"g_x"}'
    assert out.model == "deepseek-flash"
    assert out.usage.prompt_tokens == 1200
    assert out.usage.cached_tokens == 200
    assert out.usage.reasoning_tokens == 120
    assert out.latency_ms >= 0

    # 请求侧：JSON 模式、鉴权头、模型名
    assert seen["auth"].startswith("Bearer sk-")
    assert seen["body"]["response_format"] == {"type": "json_object"}
    assert seen["body"]["model"] == "deepseek-flash"
    assert seen["body"]["stream"] is False


def test_empty_content_is_validation_error():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=_ok_body(content="   "))

    with _provider(handler) as p, pytest.raises(LLMError) as info:
        p.structured(**CALL)
    assert info.value.kind == "validation"
    assert info.value.retryable is True


def test_truncated_output_is_distinct_error():
    """截断与校验失败要分开：前者要放宽预算/要求精简，后者要回喂错误。"""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=_ok_body(content='{"id":', finish="length"))

    with _provider(handler) as p, pytest.raises(LLMError) as info:
        p.structured(**CALL)
    assert info.value.kind == "truncated"
    assert "截断" in str(info.value)


def test_429_is_retryable_and_keeps_retry_after():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            429, json={"error": {"message": "rate limited"}}, headers={"retry-after": "7"}
        )

    with _provider(handler) as p, pytest.raises(LLMError) as info:
        p.structured(**CALL)
    assert info.value.kind == "rate_limit"
    assert info.value.retryable is True
    assert info.value.retry_after == 7.0


def test_401_is_not_retryable():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"error": {"message": "invalid key"}})

    with _provider(handler) as p, pytest.raises(LLMError) as info:
        p.structured(**CALL)
    assert info.value.kind == "auth"
    assert info.value.retryable is False


def test_400_is_not_retryable():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json={"error": {"message": "bad param"}})

    with _provider(handler) as p, pytest.raises(LLMError) as info:
        p.structured(**CALL)
    assert info.value.kind == "bad_request"
    assert info.value.retryable is False


def test_500_is_retryable():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, text="upstream down")

    with _provider(handler) as p, pytest.raises(LLMError) as info:
        p.structured(**CALL)
    assert info.value.kind == "server"
    assert info.value.retryable is True


def test_timeout_is_retryable():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("timed out", request=request)

    with _provider(handler) as p, pytest.raises(LLMError) as info:
        p.structured(**CALL)
    assert info.value.kind == "timeout"
    assert info.value.retryable is True


def test_network_error_is_retryable_and_does_not_leak_key():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("dns failed", request=request)

    with _provider(handler) as p, pytest.raises(LLMError) as info:
        p.structured(**CALL)
    assert info.value.kind == "network"
    assert "sk-test-key" not in str(info.value)


def test_missing_key_rejected_at_construction():
    with pytest.raises(ValueError):
        DeepSeekProvider("   ")
