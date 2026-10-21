"""受限 LLM 重排：只排序，不生成事实。

为什么要模型参与、又为什么只让它排序：

- 混合检索能把候选找出来，但"哪条更像现场这辆车"需要语义判断；
- 让模型"自由诊断"会编部件号、故障码和阈值，现场照着拆会出事；
- 因此模型只拿到**候选 id + 标题 + 已有人工原因**，只能重排，不能新增。
  输出里的未知 id 一律丢弃；调用失败、超时、JSON 不合法都回退到检索顺序。

成本与可用性：默认开（`DIAGNOSE_RERANK=0` 可关），只在配置了 Key 时生效；
每次最多 5 个候选、512 token、8s 超时；失败不影响主流程。
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
from datetime import datetime, timedelta, timezone

from llm import get_provider
from llm.pricing import PRICE_VERSION, cost_micros

import store
from models.knowledge import KnowledgeEntry

from . import quota

log = logging.getLogger("electro.rerank")

MAX_CANDIDATES = 5
MAX_TOKENS = 512
TIMEOUT_S = 8.0

# 重排是"加分项"，不能把生成的钱花掉：
# 单独记一份日预算（默认 ¥0.3 ≈ 300 次调用），花完就静默关掉重排。
# 单次调用实测约 900–1100 micros，估算值留一点余量。
DEFAULT_DAY_MICROS = 300_000
ESTIMATE_MICROS = 1_500

# 同一句话在演示里会被反复问：缓存 10 分钟，避免重复付费与重复等待。
CACHE_TTL_S = 600
CACHE_MAX = 128

CST = timezone(timedelta(hours=8))
_cache: dict[tuple[str, tuple[str, ...]], tuple[float, dict]] = {}
_spend: dict[str, int] = {}
_state_lock = threading.Lock()

SYSTEM = """你是故障排查检索系统的重排器，不是诊断器。
你只能对给定候选条目排序，不能新增条目、原因、部件、故障码、阈值或步骤。
只输出 JSON：{"order": ["候选id", ...], "reason": "不超过60字的排序理由"}。
order 必须包含全部候选 id，且只能使用给定 id。"""

SCHEMA = {
    "type": "object",
    "properties": {
        "order": {"type": "array", "items": {"type": "string"}},
        "reason": {"type": "string", "maxLength": 80},
    },
    "required": ["order", "reason"],
}


def enabled() -> bool:
    if os.getenv("DIAGNOSE_RERANK", "1").strip() == "0":
        return False
    return bool(os.getenv("DEEPSEEK_API_KEY", "").strip())


def day_limit_micros() -> int:
    raw = os.getenv("RERANK_DAY_MICROS", "")
    try:
        return max(0, int(raw)) if raw.strip() else DEFAULT_DAY_MICROS
    except ValueError:
        return DEFAULT_DAY_MICROS


def _today() -> str:
    return datetime.now(timezone.utc).astimezone(CST).date().isoformat()


def spent_today() -> int:
    with _state_lock:
        return _spend.get(_today(), 0)


def reset_state() -> None:
    """仅测试使用：清空缓存与当日花费。"""
    with _state_lock:
        _cache.clear()
        _spend.clear()


def cache_size() -> int:
    with _state_lock:
        return len(_cache)


def _cache_get(key: tuple[str, tuple[str, ...]]) -> dict | None:
    now = time.monotonic()
    with _state_lock:
        item = _cache.get(key)
        if item is None:
            return None
        stored_at, payload = item
        if now - stored_at > CACHE_TTL_S:
            _cache.pop(key, None)
            return None
        return dict(payload)


def _cache_put(key: tuple[str, tuple[str, ...]], payload: dict) -> None:
    now = time.monotonic()
    with _state_lock:
        if len(_cache) >= CACHE_MAX:
            # 简单淘汰：先清过期，仍满就丢最早插入的一条。
            expired = [k for k, (ts, _) in _cache.items() if now - ts > CACHE_TTL_S]
            for k in expired:
                _cache.pop(k, None)
            if len(_cache) >= CACHE_MAX:
                _cache.pop(next(iter(_cache)), None)
        _cache[key] = (now, dict(payload))


def _record_spend(cost: int) -> None:
    day = _today()
    with _state_lock:
        _spend[day] = _spend.get(day, 0) + max(0, cost)


def _user_prompt(query: str, entries: list[KnowledgeEntry]) -> str:
    lines = [f"现场现象：{query}", "", "候选："]
    for index, entry in enumerate(entries, start=1):
        causes = "；".join(entry.likely_causes[:3])
        lines.append(f"{index}. id={entry.id}｜{entry.title}｜可能原因：{causes}")
    lines.append("")
    lines.append("按“最可能解释现场现象”排序，输出 JSON。")
    return "\n".join(lines)


def rerank(query: str, entries: list[KnowledgeEntry]) -> dict | None:
    """返回重排结果；任何异常都返回 None，调用方保持原顺序。"""
    if len(entries) < 2 or not enabled():
        return None
    if len(entries) > MAX_CANDIDATES:
        entries = entries[:MAX_CANDIDATES]

    ids = [entry.id for entry in entries]
    key = (query.strip().lower(), tuple(ids))
    cached = _cache_get(key)
    if cached is not None:
        cached["cached"] = True
        return cached

    # 重排走自己的日预算：检索是免费功能，不该把生成的钱花掉。
    if spent_today() + ESTIMATE_MICROS > day_limit_micros():
        log.info("重排日预算已用尽（%d micros），跳过", spent_today())
        return None

    # 全站预算已耗尽时不发这次调用；费用口径对所有人一致。
    if not quota.check("diagnose-rerank", unlimited=True).ok:
        return None
    provider = None
    try:
        provider = get_provider()
        completion = provider.structured(
            system=SYSTEM,
            user=_user_prompt(query, entries),
            schema=SCHEMA,
            timeout_s=TIMEOUT_S,
            max_tokens=MAX_TOKENS,
        )
        data = json.loads(completion.text)
        raw_order = data.get("order")
        if not isinstance(raw_order, list):
            return None

        order: list[str] = []
        for item in raw_order:
            if isinstance(item, str) and item in ids and item not in order:
                order.append(item)
        if not order:
            return None
        # 模型漏掉的候选按原顺序补回，避免"重排后条目消失"。
        order.extend(item for item in ids if item not in order)

        cost = cost_micros(completion.usage)
        _record_spend(cost)
        try:
            store.record_usage(
                model=completion.model,
                prompt_tokens=completion.usage.prompt_tokens,
                completion_tokens=completion.usage.completion_tokens,
                reasoning_tokens=completion.usage.reasoning_tokens,
                cached_tokens=completion.usage.cached_tokens,
                cost_micros=cost,
                price_version=PRICE_VERSION,
            )
        except Exception:  # noqa: BLE001 - 计费失败不该让排查失败
            log.warning("重排用量记录失败", exc_info=True)

        reason = data.get("reason")
        payload = {
            "order": order,
            "reason": str(reason)[:80] if reason else "",
            "model": completion.model,
            "latency_ms": completion.latency_ms,
            "cost_micros": cost,
            "cached": False,
        }
        if cost <= day_limit_micros():
            _cache_put(key, payload)
        return payload
    except Exception as exc:  # noqa: BLE001 - 重排是可选增强
        log.warning("LLM 重排失败，回退检索顺序：%s", exc)
        return None
    finally:
        if provider is not None:
            try:
                provider.close()
            except Exception:  # noqa: BLE001
                pass
