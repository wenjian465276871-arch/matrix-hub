"""B 模块：故障知识检索（降级版）。

为什么不直接让模型"自由诊断"：

- 现场要的是"下一步查什么"，不是一篇分析文章。检索能给出可执行的顺序；
- 生成式诊断会编出不存在的部件号、故障码和处理步骤。作业现场照着一段
  编出来的文字去拆东西，是会出事的；
- 检索是确定性的，可以评测：10 条查询命中几条，能写成数字。

`KnowledgeProvider` 是可替换点。现在是关键词（字符二元组 + 同义词 + 人工关键词），
将来接 embedding 只需要实现同一协议，路由与返回结构都不动。
"""

from __future__ import annotations

import json
import logging
import math
import os
import re
import threading
import time
from pathlib import Path
from typing import Protocol

from models.knowledge import EvalSet, KnowledgeBase, KnowledgeEntry

log = logging.getLogger("electro.knowledge")

DEFAULT_TOP_K = 3
MAX_TOP_K = 5
DISCLAIMER = "演示数据 · 非实际作业依据"

# 低于该分数视为"没有足够接近的条目"。调高 → 更多"未覆盖"，调低 → 更容易给错条目。
# 现场宁可说"没查到"，也不要给一条看起来像但其实不对的排查链。
MIN_SCORE = float(os.getenv("DIAGNOSE_MIN_SCORE", "3.0"))

# 同义词只在归一化阶段做，不改原文：检索要能听懂现场口语，但记录里要保留原话。
SYNONYMS: dict[str, str] = {
    "门控单元": "门控器",
    "门机控制器": "门控器",
    "edcu": "门控器",
    "塞拉门": "车门",
    "侧拉门": "车门",
    "客室门": "车门",
    "关不到底": "关不到位",
    "关不上门": "关不上",
}

# 子系统关键词。用于两件事：显式过滤，以及"问的是没收录的子系统"时直接回未覆盖。
SYSTEM_HINTS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("pantograph", ("受电弓", "升弓", "降弓", "弓网", "碳滑板")),
    ("hvac", ("空调", "制冷", "压缩机", "冷凝", "出风口", "客室温度")),
    ("door", ("车门", "门控器", "门扇", "隔离锁", "紧急解锁", "塞拉门")),
)


def kb_dir() -> Path:
    env = os.getenv("KNOWLEDGE_DIR")
    if env:
        return Path(env)
    return Path(__file__).resolve().parent.parent / "knowledge"


def infer_system(text: str) -> str | None:
    """从提问里猜子系统。猜不出返回 None（不做过滤，交给打分）。"""
    for system, hints in SYSTEM_HINTS:
        if any(hint in text for hint in hints):
            return system
    return None


def _norm(text: str) -> str:
    """小写、去标点、同义词归一。中文没有空格，去掉标点后直接连写。"""
    t = text.lower().strip()
    for src, dst in SYNONYMS.items():
        t = t.replace(src, dst)
    return re.sub(r"[^0-9a-z\u4e00-\u9fff]+", "", t)


def _bigrams(text: str) -> set[str]:
    if not text:
        return set()
    if len(text) == 1:
        return {text}
    return {text[i : i + 2] for i in range(len(text) - 1)}


def _cos(a: set[str], b: set[str]) -> float:
    """集合余弦：对长短文本都稳定，不会因为条目写得多就自动占优。"""
    if not a or not b:
        return 0.0
    return len(a & b) / math.sqrt(len(a) * len(b))


def score(query: str, entry: KnowledgeEntry) -> float:
    """相关度打分。四路信号相加，权重是手调的，但每一项都有明确含义。"""
    qn = _norm(query)
    qb = _bigrams(qn)
    qc = set(qn)

    # 1) 人工关键词：最强的信号。命中即意味着"这条就是为这种说法写的"。
    keywords = [_norm(k) for k in entry.keywords]
    hits = sum(1 for k in keywords if k and k in qn)
    total = min(hits, 3) * 4.0

    # 2) 正文覆盖：标题 + 现象 + 原因 + 检查动作。
    body = "".join(
        [entry.title, *entry.symptoms, *entry.likely_causes, *(c.action for c in entry.checks)]
    )
    bn = _norm(body)
    total += 3.0 * _cos(qb, _bigrams(bn))
    total += 1.2 * _cos(qc, set(bn))

    # 3) 标题与现象的局部匹配：现象描述最接近现场原话。
    total += 2.5 * _cos(qb, _bigrams(_norm(entry.title)))
    best_symptom = max((_cos(qb, _bigrams(_norm(s))) for s in entry.symptoms), default=0.0)
    total += 3.0 * best_symptom
    return round(total, 3)


class KnowledgeProvider(Protocol):
    """检索协议。返回 (条目, 分数)，已按分数降序。"""

    name: str

    def search(
        self, query: str, *, system: str | None = None, top_k: int = DEFAULT_TOP_K
    ) -> list[tuple[KnowledgeEntry, float]]: ...

    def systems(self) -> set[str]: ...


class KeywordProvider:
    """默认实现：纯 Python 关键词检索，零外部依赖、零费用、毫秒级。"""

    name = "keyword"

    def __init__(self, directory: Path | None = None) -> None:
        self._dir = directory or kb_dir()
        self._entries: list[KnowledgeEntry] = []
        self._version = ""
        self.reload()

    def reload(self) -> None:
        path = self._dir / "door_faults.json"
        raw = json.loads(path.read_text(encoding="utf-8"))
        kb = KnowledgeBase.model_validate(raw)
        self._entries = kb.entries
        self._version = kb.version
        log.info("知识库已加载：%s，%d 条（v%s）", path.name, len(kb.entries), kb.version)

    @property
    def version(self) -> str:
        return self._version

    def entries(self) -> list[KnowledgeEntry]:
        return list(self._entries)

    def systems(self) -> set[str]:
        return {e.system.value for e in self._entries}

    def search(
        self, query: str, *, system: str | None = None, top_k: int = DEFAULT_TOP_K
    ) -> list[tuple[KnowledgeEntry, float]]:
        candidates = [e for e in self._entries if system is None or e.system.value == system]
        scored = [(e, score(query, e)) for e in candidates]
        scored = [(e, s) for e, s in scored if s >= MIN_SCORE]
        scored.sort(key=lambda pair: (-pair[1], pair[0].id))
        return scored[: max(1, min(top_k, MAX_TOP_K))]


def load_eval_set(path: Path | None = None) -> EvalSet:
    target = path or (kb_dir() / "eval_queries.json")
    return EvalSet.model_validate(json.loads(target.read_text(encoding="utf-8")))


_provider: KeywordProvider | None = None
_provider_lock = threading.Lock()


def get_provider() -> KeywordProvider:
    global _provider
    if _provider is None:
        with _provider_lock:
            if _provider is None:
                _provider = KeywordProvider()
    return _provider


def reset_provider() -> None:
    """仅测试使用：换知识库目录或改分数阈值后重新加载。"""
    global _provider
    with _provider_lock:
        _provider = None


_UNCOVERED_MESSAGES = {
    "system_not_covered": (
        "未覆盖：当前知识库只收录客室侧门故障，该子系统尚未建立条目。"
        "建议按车型手册排查，并把这起现象上报给技术组补充条目。"
    ),
    "no_match": (
        "未覆盖：现有条目没有与描述足够接近的故障。"
        "建议先记录故障码、发生时机与操作顺序，再上报处理，不要凭经验强行拆检。"
    ),
}


def diagnose(query: str, *, system: str | None = None, top_k: int = DEFAULT_TOP_K) -> dict:
    """一次性返回排查建议，不做多轮、不调用模型。"""
    started = time.perf_counter()
    provider = get_provider()

    text = query.strip()
    guessed = system or infer_system(text)
    covered = provider.systems()

    if guessed and guessed not in covered:
        hits: list[tuple[KnowledgeEntry, float]] = []
        reason: str | None = "system_not_covered"
    else:
        hits = provider.search(text, system=guessed, top_k=top_k)
        reason = None if hits else "no_match"

    results = [
        {
            "id": entry.id,
            "title": entry.title,
            "system": entry.system.value,
            "score": value,
            "likely_causes": entry.likely_causes,
            "checks": [c.model_dump() for c in entry.checks],
            "escalation": entry.escalation,
            "safety": entry.safety,
            "sources": entry.sources,
        }
        for entry, value in hits
    ]

    message = ""
    suggestion = ""
    if reason:
        message = _UNCOVERED_MESSAGES[reason]
        suggestion = "记录现象与故障码后上报，不要凭经验拆检。"
    else:
        suggestion = results[0]["escalation"]

    return {
        "query": text,
        "matched": reason is None,
        "uncovered_reason": reason,
        "message": message,
        "suggestion": suggestion,
        "results": results,
        "count": len(results),
        "took_ms": int((time.perf_counter() - started) * 1000),
        "kb_version": provider.version,
        "disclaimer": DISCLAIMER,
    }
