"""Provider 工厂：按环境变量选择实现。

Key 缺失时**在调用点失败**而不是启动时失败：站点上有大量只读页面（列表、指导书详情、
引导记录），它们不需要模型也能用。让整站因为没配 Key 而起不来，是把可用性拿去换洁癖。
"""
from __future__ import annotations

import os

from .base import LLMError, LLMProvider
from .deepseek import DeepSeekProvider


def get_provider(name: str | None = None, *, api_key: str | None = None) -> LLMProvider:
    provider = (name or os.getenv("LLM_PROVIDER", "deepseek")).strip().lower()

    if provider == "deepseek":
        key = api_key if api_key is not None else os.getenv("DEEPSEEK_API_KEY", "")
        if not key.strip():
            raise LLMError("auth", "未配置 DEEPSEEK_API_KEY，无法调用模型")
        return DeepSeekProvider(key)

    raise LLMError("bad_request", f"未知的 LLM_PROVIDER：{provider}")
