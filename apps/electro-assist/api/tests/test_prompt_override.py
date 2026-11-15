"""提示词覆盖与指纹（R24-5 的地基）。

为什么单独测：A/B 对照如果"跑的不是我以为的那版提示词"，所有数字都是假的。
这里钉三件事——默认取代码里现拼的那份、覆盖后整体替换、指纹跟着变。
"""
from __future__ import annotations

import hashlib

from llm.prompts import set_system_prompt_override, system_prompt, system_prompt_sha


def _restore() -> None:
    set_system_prompt_override(None)


def test_default_prompt_comes_from_code() -> None:
    try:
        _restore()
        text = system_prompt()
        assert "结构化生成器" in text
        assert "<document>" in text
    finally:
        _restore()


def test_override_replaces_whole_prompt() -> None:
    frozen = "这是一份冻结的旧提示词。"
    try:
        set_system_prompt_override(frozen)
        assert system_prompt() == frozen
        # 覆盖期间指纹必须跟着变，否则两版结果会共用同一个 sha
        assert system_prompt_sha() == hashlib.sha256(frozen.encode()).hexdigest()[:12]
    finally:
        _restore()


def test_sha_is_12_hex_and_stable() -> None:
    try:
        _restore()
        first = system_prompt_sha()
        assert len(first) == 12
        int(first, 16)  # 不是十六进制就会抛
        assert system_prompt_sha() == first
    finally:
        _restore()
