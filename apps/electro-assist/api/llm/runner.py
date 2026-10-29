"""生成运行器：一次生成 = 至多两次模型调用 + 校验 + 一次纠错重试。

为什么重试放在这里而不是 provider：
- provider 只做"一次调用"，费用与耗时对调用方透明；
- 预算、退避、纠错话术是产品策略，换模型不该重写；
- 失败要能分类上报（T11 的 job 要存 error_code），不能糊成一句"调用失败"。

预算规则（开发计划 §2.1）：单次 40s、最多 2 次、总预算 90s，
**剩余预算不足一次调用就不重试**——否则第二次调用必然中途被砍，白花钱还拿不到结果。
"""
from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Callable

from pydantic import ValidationError

from models.guide import Guide

from .base import Completion, LLMError, LLMProvider, Usage
from .pricing import cost_micros
from .prompts import (
    output_schema,
    repair_prompt,
    system_prompt,
    truncation_prompt,
    user_prompt,
)

MAX_INPUT_CHARS = 20_000
MIN_INPUT_CHARS = 10


@dataclass
class GuideDraft:
    guide: Guide
    model: str
    attempts: int
    usage: Usage
    cost_micros: int
    latency_ms: int
    repaired: bool
    repairs: list[str] = field(default_factory=list)


def extract_json(text: str) -> str:
    """从模型输出里取出 JSON 主体。

    已经明确要求"只输出 JSON"，但模型偶尔仍会包一层 ```json 或加一句"好的"。
    这里做**有限**容错：只剥代码围栏和前后缀，不动内容——
    过度清洗会把"模型真的写错了"变成"看起来对了"，那才是灾难。
    """
    body = text.strip()
    if body.startswith("```"):
        first_newline = body.find("\n")
        body = body[first_newline + 1 :] if first_newline > 0 else body
        if body.rstrip().endswith("```"):
            body = body.rstrip()[:-3]
    start, end = body.find("{"), body.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("输出中没有 JSON 对象")
    return body[start : end + 1]


def _with_usage(
    err: LLMError, attempts: int, usage: Usage, at: datetime | None, raw: str | None = None
) -> LLMError:
    """把"已经花掉的钱"和"模型到底写了什么"挂到异常上。

    没有这两样，失败就是黑盒：预算统计会把失败的消耗漏掉，
    而看不到原始输出就只能靠猜模型哪里写错了。
    """
    err.attempts = attempts
    err.usage = usage
    err.cost_micros = cost_micros(usage, at)
    if raw is not None:
        err.raw = raw
    return err


def _format_validation_error(exc: ValidationError) -> str:
    lines = []
    for err in exc.errors()[:5]:
        loc = ".".join(str(p) for p in err["loc"])
        lines.append(f"- {loc or '<root>'}：{err['msg']}")
    return "\n".join(lines)


def generate_guide(
    provider: LLMProvider,
    text: str,
    *,
    budget_s: float = 90.0,
    call_timeout_s: float = 40.0,
    max_attempts: int = 2,
    max_tokens: int = 6144,
    max_chars: int = MAX_INPUT_CHARS,
    clock: Callable[[], float] = time.monotonic,
    at: datetime | None = None,
    source_note: str = "由用户输入的工艺文本生成（演示用途）",
) -> GuideDraft:
    """工艺文本 → 已通过 schema 校验的 Guide。

    失败一律抛 `LLMError`；输入问题抛 `ValueError`（由路由层映射 422）。
    """
    cleaned = text.strip()
    if len(cleaned) < MIN_INPUT_CHARS:
        raise ValueError("工艺文本过短，至少需要 10 个字符")
    if len(cleaned) > max_chars:
        raise ValueError(f"工艺文本过长（{len(cleaned)} 字符），上限 {max_chars}")

    system = system_prompt()
    prompt = user_prompt(cleaned)
    schema = output_schema()

    deadline = clock() + budget_s
    usage = Usage()
    latency_ms = 0
    attempts = 0
    last_error: LLMError | None = None
    repairs: list[str] = []

    for attempt in range(1, max_attempts + 1):
        remaining = deadline - clock()
        if remaining < call_timeout_s:
            raise _with_usage(
                LLMError(
                    "budget",
                    f"剩余预算 {remaining:.0f}s 不足单次调用 {call_timeout_s:.0f}s"
                    + (f"，上次错误：{last_error.kind}" if last_error else ""),
                ),
                attempts,
                usage,
                at,
            )
        attempts = attempt

        try:
            completion: Completion = provider.structured(
                system=system,
                user=prompt,
                schema=schema,
                timeout_s=call_timeout_s,
                max_tokens=max_tokens,
            )
        except LLMError as exc:
            last_error = exc
            # 失败调用也可能已经烧了 token（截断、5xx 前已生成部分内容）。
            # 不累加的话，预算熔断会在失败率最高的时候失灵。
            if exc.usage.prompt_tokens or exc.usage.completion_tokens:
                usage = usage + exc.usage
            if not exc.retryable or attempt == max_attempts:
                raise _with_usage(exc, attempt, usage, at) from exc
            if exc.kind == "truncated":
                # 与校验失败不同：模型不是写错，是写太多。加倍预算并要求精简，
                # 否则同样的输入会再次撞上同一个上限。
                max_tokens = min(max_tokens * 2, 8192)
                prompt = truncation_prompt(cleaned)
            continue

        usage = usage + completion.usage
        latency_ms += completion.latency_ms

        try:
            payload = json.loads(extract_json(completion.text))
            # assets 不在给模型看的 schema 里，但模型可能凭"见过类似任务"硬塞。
            # 先剔掉再校验：素材归属是服务端事实，不能让模型的一次发挥把整次生成判死。
            payload.pop("assets", None)
            for step in payload.get("steps", []):
                if isinstance(step, dict):
                    step.pop("assets", None)
            # is_demo 与 model/source_note 一样属于服务端所有：模型写 false 时
            # 不浪费一次重试去纠正，直接覆盖后再校验（模型层还有一道拒绝，防其他入口）。
            if isinstance(payload.get("meta"), dict):
                payload["meta"]["is_demo"] = True
            guide = Guide.model_validate(payload)
        except (ValueError, ValidationError) as exc:
            detail = (
                _format_validation_error(exc)
                if isinstance(exc, ValidationError)
                else f"- 无法解析 JSON：{exc}"
            )
            last_error = _with_usage(
                LLMError("validation", f"模型输出未通过校验：\n{detail}"),
                attempt,
                usage,
                at,
                raw=completion.text,
            )
            if attempt == max_attempts:
                raise last_error from exc
            repairs.append(detail)
            prompt = repair_prompt(cleaned, completion.text, detail)
            continue

        # 溯源字段必须由服务端写死。实测中模型会编造"依据公开资料整理"这种来源声明——
        # 它没有检索能力，这句话是凭空生成的，留着就是合规风险。
        guide.meta.model = completion.model
        guide.meta.generated_at = datetime.now(timezone.utc)
        guide.meta.source_note = source_note
        guide.meta.is_demo = True

        return GuideDraft(
            guide=guide,
            model=completion.model,
            attempts=attempt,
            usage=usage,
            cost_micros=cost_micros(usage, at),
            latency_ms=latency_ms,
            repaired=attempt > 1,
            repairs=repairs,
        )

    # 理论不可达：循环内要么 return，要么 raise
    raise LLMError("server", "生成流程异常结束")  # pragma: no cover
