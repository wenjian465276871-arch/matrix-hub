"""LLM 层公开入口。

用法：
    provider = get_provider()
    draft = generate_guide(provider, text)
    draft.guide    # 已通过 schema 校验
    draft.usage    # 累计 token（含失败重试的那次）
    draft.cost_micros
"""
from .base import Completion, LLMError, LLMProvider, Usage
from .factory import get_provider
from .pricing import PRICE_VERSION, cost_micros, is_peak
from .prompts import system_prompt, user_prompt
from .runner import GuideDraft, extract_json, generate_guide

__all__ = [
    "LLMProvider",
    "LLMError",
    "Completion",
    "Usage",
    "get_provider",
    "generate_guide",
    "GuideDraft",
    "extract_json",
    "cost_micros",
    "is_peak",
    "PRICE_VERSION",
    "system_prompt",
    "user_prompt",
]
