"""LLM 抽象层：错误分类、用量、Provider 协议。

为什么先定错误分类再写实现：
调用方（生成管线、异步 job、配额熔断）需要对"失败"做不同的处置——
超时可以重试、鉴权失败重试一万次也没用、校验失败要带错误信息让模型自纠、
预算耗尽必须立刻停。这些判断不能散落在 `except Exception` 里。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, Protocol, runtime_checkable

ErrorKind = Literal[
    "timeout",     # 单次调用超时
    "network",     # 连接失败 / DNS / TLS
    "rate_limit",  # 429
    "auth",        # 401/403，重试无意义
    "server",      # 5xx
    "bad_request", # 400，请求本身有问题
    "validation",  # 模型输出不是合法 JSON 或不合 schema
    "truncated",   # 输出被 max_tokens 截断（与校验失败不同：要放宽预算/要求精简）
    "budget",      # 总预算耗尽，未发出调用
]

# 默认哪些错误值得重试。auth/bad_request 重试只会浪费时间和钱。
RETRYABLE: dict[str, bool] = {
    "timeout": True,
    "network": True,
    "rate_limit": True,
    "server": True,
    "validation": True,
    "truncated": True,
    "auth": False,
    "bad_request": False,
    "budget": False,
}


class LLMError(Exception):
    """失败也带着"已经花了多少"，否则失败的成本会凭空消失。

    实测教训：第一次批量评测 3 份失败，报告里成本是 ¥0——但 token 已经消耗了。
    预算熔断如果只看成功调用，被刷的时候正好是失败率最高的时候。
    """

    def __init__(
        self,
        kind: ErrorKind,
        message: str,
        *,
        status: int | None = None,
        retry_after: float | None = None,
        retryable: bool | None = None,
        attempts: int = 0,
        usage: "Usage | None" = None,
        cost_micros: int = 0,
        raw: str | None = None,
    ) -> None:
        super().__init__(message)
        self.kind: ErrorKind = kind
        self.status = status
        self.retry_after = retry_after
        self.retryable = RETRYABLE[kind] if retryable is None else retryable
        self.attempts = attempts
        self.usage = usage or Usage()
        self.cost_micros = cost_micros
        self.raw = raw

    def __str__(self) -> str:  # pragma: no cover - 仅用于日志可读性
        suffix = f"（HTTP {self.status}）" if self.status else ""
        return f"[{self.kind}] {self.args[0]}{suffix}"


@dataclass
class Usage:
    """token 用量。缓存的输入 token 单独计数——它便宜 20 倍以上，混在一起算成本会高估。"""

    prompt_tokens: int = 0
    completion_tokens: int = 0
    reasoning_tokens: int = 0
    cached_tokens: int = 0

    @property
    def billable_prompt_tokens(self) -> int:
        return max(0, self.prompt_tokens - self.cached_tokens)

    def __add__(self, other: "Usage") -> "Usage":
        return Usage(
            prompt_tokens=self.prompt_tokens + other.prompt_tokens,
            completion_tokens=self.completion_tokens + other.completion_tokens,
            reasoning_tokens=self.reasoning_tokens + other.reasoning_tokens,
            cached_tokens=self.cached_tokens + other.cached_tokens,
        )

    def as_dict(self) -> dict[str, int]:
        return {
            "prompt_tokens": self.prompt_tokens,
            "completion_tokens": self.completion_tokens,
            "reasoning_tokens": self.reasoning_tokens,
            "cached_tokens": self.cached_tokens,
        }


@dataclass
class Completion:
    """一次成功的模型调用结果。

    `reasoning_tokens` 单列：deepseek-flash 默认开思考，它计入 completion 计费，
    但不计入正文——排查"为什么输出被截断"时必须能分开看。
    """

    text: str
    model: str
    usage: Usage = field(default_factory=Usage)
    finish_reason: str | None = None
    latency_ms: int = 0


@runtime_checkable
class LLMProvider(Protocol):
    """Provider 只负责"一次调用"。

    重试、预算、校验、修复提示都在 `runner` 里——那样换模型（通义/其他）时，
    这些逻辑不用重写一遍。也避免 provider 自己偷偷重试导致费用不可控。

    **为什么只有一个 `structured` 方法（决策 #45，2026-11-08）**：
    计划 §3.2 原来写的是 `generate` / `structured_generate` / `stream` 三个方法，
    实际收敛成一个。理由：
    - `generate`（无结构文本）没有消费者——三个调用点（A2 生成、图片识别、
      B 重排）的产出都要过 schema 或只能输出 id 列表，放宽成自由文本
      等于把"输出可校验"这个最强约束丢掉；
    - `stream`（token 流）也没有消费者——B 的三帧是**业务帧**（recall → rerank →
      done），每帧对应一步真的完成；把一次调用切三段发是假流式，明确不做
      （决策 #36）。真要接流式模型，在 `runner.py` 里加一条路径比改协议更省事：
      Protocol 加方法会逼所有实现（含测试桩）一起改。

    将来要加时的落点：`generate` 放在这里，`stream` 放在 `runner`（它要管预算
    与截断）。加之前先有一个真的调用方。
    """

    name: str

    def structured(
        self,
        *,
        system: str,
        user: str,
        schema: dict[str, Any],
        timeout_s: float,
        max_tokens: int = 4096,
        thinking: bool = True,
    ) -> Completion:
        """要求模型输出符合 `schema` 的 JSON，返回原始文本（校验在调用方做）。

        `thinking` 默认开：生成指导书需要判断"该拆几步、判据放哪"。
        识别链路的结构化只是排版，传 `False` 能把延迟与 reasoning token 一起压下来。
        """
        ...
