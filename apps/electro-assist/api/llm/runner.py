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
import logging
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Callable

from pydantic import ValidationError

from models.guide import Guide
from models.visual import motion_slots, stroke_only_anims, stroke_slots

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
# 截断重试的上限。必须**远高于**初始值：旧代码写死 8192，而初始值是 6144，
# 名义上"加倍"，实际只多了 2048，遇到思考型模型（reasoning 就吃 8–10K）等于没加。
# 官方文档：thinking 模式 max_tokens 上限 384K，这里取 32768 足够且不失控。
MAX_TOKENS_CEILING = 32_768

log = logging.getLogger(__name__)


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


def _steps(payload: dict) -> list[dict]:
    steps = payload.get("steps")
    return [s for s in steps if isinstance(s, dict)] if isinstance(steps, list) else []


def _figures(payload: dict) -> list[tuple[int, dict]]:
    pairs: list[tuple[int, dict]] = []
    for index, step in enumerate(_steps(payload)):
        figures = step.get("figures")
        if not isinstance(figures, list):
            continue
        pairs.extend((index, fig) for fig in figures if isinstance(fig, dict))
    return pairs


def _strip_invalid_motion(payload: dict) -> list[str]:
    """剔掉不合法的动效轨道，返回做了什么（供日志追溯）。

    只动 `motion`：正文、判据、图示参数一个字都不碰——动效是强调手段，
    现场看不懂"要不要做"才是红线，而"这一格有没有呼吸效果"不是。
    """
    slots_by_primitive = motion_slots()
    stroke_by_primitive = stroke_slots()
    notes: list[str] = []

    for index, figure in _figures(payload):
        tracks = figure.get("motion")
        if not isinstance(tracks, list) or not tracks:
            continue
        primitive = figure.get("primitive")
        # meter 没读数时指针和读数都不渲染，任何轨道都是静默失效（见 models/visual）
        if primitive == "meter" and (figure.get("params") or {}).get("value") is None:
            notes.append(f"steps.{index} 仪表无 value，动效会静默失效，已去掉")
            figure["motion"] = []
            continue

        allowed = set(slots_by_primitive.get(primitive, []))
        stroke = set(stroke_by_primitive.get(primitive, []))
        kept: list[dict] = []
        seen: set[str] = set()
        for track in tracks:
            if not isinstance(track, dict):
                continue
            target = track.get("target")
            anim = track.get("anim")
            if target not in allowed:
                notes.append(f"steps.{index} {primitive}.{target} 不是可动槽位，已去掉")
                continue
            if anim in set(stroke_only_anims()) and target not in stroke:
                notes.append(f"steps.{index} {anim} 只能用于描边槽位，已去掉")
                continue
            if target in seen:
                notes.append(f"steps.{index} {target} 重复动效，已去重")
                continue
            seen.add(target)
            kept.append(track)
        figure["motion"] = kept

    return notes


def _salvage(payload: dict) -> tuple[Guide | None, list[str]]:
    """校验失败后的**确定性降级**：三级递进，全部失败才交给模型重跑。

    起因是 2026-11-02 的线上失败：模型只错了「一条动效挂错槽位」，
    整份 8 步指导书被判死，两次调用 62s、¥0.10 全废。装饰层的问题
    不该有这种代价，所以先降级、后重跑：

    1. 剔掉违规的动效轨道（保留图，只去掉那一格效果）；
    2. 仍不合法 → 去掉全部动效（图还在，只是静态）；
    3. 仍不合法 → 去掉全部图示（正文与判据一字不动，回到纯文字指导书）。

    任何一档通过校验就接受，并把做过什么写进 `repairs`。
    """
    notes = _strip_invalid_motion(payload)
    if notes:
        try:
            return Guide.model_validate(payload), notes
        except ValidationError:
            pass

    moved = False
    for _, figure in _figures(payload):
        if figure.get("motion"):
            figure["motion"] = []
            moved = True
    if moved:
        notes.append("动效整体去掉（剔除后仍不合法）")
        try:
            return Guide.model_validate(payload), notes
        except ValidationError:
            pass

    # 第 3 档：逐步丢图——只丢出错那一步，别让一处坏图带走七张好图
    for step in _steps(payload):
        figures = step.get("figures")
        if not figures:
            continue
        step["figures"] = []
        try:
            guide = Guide.model_validate(payload)
        except ValidationError:
            step["figures"] = figures  # 不是这步的问题，放回去再试下一步
            continue
        notes.append(f"{step.get('id')} 的图示不合法，已去掉")
        return guide, notes

    return None, notes


def generate_guide(
    provider: LLMProvider,
    text: str,
    *,
    # 2026-11-02 调整：思考模式下单次输出可达 15K token（reasoning 计入完成量），
    # 按实测约 200 token/s 推算单次需 ~75s。旧的 40s/90s 会在"预算放大"之后
    # 把截断变成超时——那只是换一种失败方式。
    budget_s: float = 170.0,
    call_timeout_s: float = 75.0,
    max_attempts: int = 2,
    max_tokens: int = 16384,
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
                max_tokens = min(max_tokens * 2, MAX_TOKENS_CEILING)
                prompt = truncation_prompt(cleaned)
            continue

        usage = usage + completion.usage
        latency_ms += completion.latency_ms

        payload: dict | None = None
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
            # 先试确定性降级：图示/动效是表达层，不值得为它重跑整份。
            # 降级后能过校验就直接用，省下一次模型调用（线上实测约 30s、¥0.05）。
            salvaged, notes = _salvage(payload) if isinstance(payload, dict) else (None, [])
            if salvaged is not None:
                guide = salvaged
                repairs.extend(notes)
                log.warning(
                    "图示降级后通过校验 job 第 %d 次调用：%s", attempt, "；".join(notes)
                )
            else:
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
