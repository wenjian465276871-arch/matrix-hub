"""上游错误回显里的凭据片段必须被抹掉（2026-11-18 密钥轮换演练发现）。

背景：用假 Key 起隔离实例跑一次真实生成，`job.error_message` 返回的是
`[auth] 鉴权失败：Authentication Fails, Your api key: ****-000 is invalid (request_id: …)`。
那段会被前端显示在公开站的生成页上——也就是说**换 Key 时配错，新 Key 的尾号
会出现在页面上**。尾号不可用，但 `llm/deepseek.py` 开头写着"异常信息、日志、
返回体一律不含 Key"，当时这句只对请求头成立，对上游回显不成立。

本例里的凭据串一律用 EXAMPLE 占位，不放任何形似真实 Key 的值。
"""

import httpx
import pytest

from llm.base import LLMError
from llm.deepseek import DeepSeekProvider, _scrub_secret

FAKE_KEY = "sk-EXAMPLE" + "0" * 8


def test_inline_key_tail_scrubbed_but_request_id_kept():
    raw = "Authentication Fails, Your api key: ****-000 is invalid (request_id: 1507b00b)"
    out = _scrub_secret(raw)
    assert "-000" not in out
    assert "api key: ****" in out
    # 排障要用的 request_id 不能被顺手抹掉
    assert "request_id: 1507b00b" in out


def test_bare_key_token_scrubbed():
    out = _scrub_secret("Incorrect API key provided: " + FAKE_KEY + "!")
    assert FAKE_KEY not in out
    # 内联规则先命中（"api key provided:" 后面整段抹掉），结果是 **** 而不是 sk-****——
    # 更彻底，符合意图；下面这条单独验"没有 api key 前缀"时的兜底规则。
    assert "****" in out
    assert "sk-****" in _scrub_secret("别处泄漏的串 " + FAKE_KEY + " 出现在这里")


def test_plain_message_untouched():
    raw = "Model deepseek-flash is temporarily unavailable"
    assert _scrub_secret(raw) == raw


def test_401_raises_auth_without_key_fragment():
    resp = httpx.Response(
        401,
        json={"error": {"message": "Your api key: " + FAKE_KEY + " is invalid"}},
    )
    with pytest.raises(LLMError) as info:
        DeepSeekProvider._raise_for_status(resp)
    text = str(info.value)
    assert info.value.kind == "auth"
    assert FAKE_KEY not in text
    assert "鉴权失败" in text


def test_401_without_message_still_actionable():
    resp = httpx.Response(401, json={})
    with pytest.raises(LLMError) as info:
        DeepSeekProvider._raise_for_status(resp)
    assert "DEEPSEEK_API_KEY" in str(info.value)
