"""B 模块：故障知识检索（混合召回 + 受限重排）。

为什么不直接让模型"自由诊断"：

- 现场要的是"下一步查什么"，不是一篇分析文章。检索能给出可执行的顺序；
- 生成式诊断会编出不存在的部件号、故障码和处理步骤。作业现场照着一段
  编出来的文字去拆东西，是会出事的；
- 检索是确定性的，可以评测：多少条查询命中几条，能写成数字。

2026-10-21 升级（演示版 L3）：

1. **混合召回**：字符 n-gram + IDF 的稀疏向量余弦（纯 Python，零外部依赖）
   与人工关键词分数合并；向量负责"换个说法也能找到"，关键词负责"现场原话必中"。
2. **受限重排**：只把候选 id + 标题 + 已有人工原因交给模型，模型只能排序，
   不能新增事实；失败/超时/JSON 不合法一律回退检索顺序。
3. **故障树与回填**在 `services/diagnosis.py`，本模块只负责"找条目"。

`KnowledgeProvider` 仍是可替换点；将来接 embedding 只需实现同一协议，
路由与返回结构不变。
"""

from __future__ import annotations

import json
import logging
import math
import os
import re
import threading
import time
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from models.knowledge import EvalSet, KnowledgeBase, KnowledgeEntry

from . import rerank as rerank_service

log = logging.getLogger("electro.knowledge")

DEFAULT_TOP_K = 3
MAX_TOP_K = 5
DISCLAIMER = "演示数据 · 非实际作业依据"

# 关键词分低于该值视为"不够接近"。调高 → 更多"未覆盖"。
MIN_SCORE = float(os.getenv("DIAGNOSE_MIN_SCORE", "3.0"))
# 向量余弦低于该值不进入结果。0.10 是实测值：再高只剩单候选（重排无从发挥），
# 再低会把"面板温度显示不对"拉到车门条目上；当前阈值下评测仍 21/21、无关提问仍 no_match。
MIN_VECTOR = float(os.getenv("DIAGNOSE_MIN_VECTOR", "0.10"))

SYSTEM_LABELS = {"door": "客室侧门", "hvac": "空调", "pantograph": "受电弓"}

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
    "冷气": "制冷",
    "空调不凉": "空调制冷不足",
    "升不起": "升弓无动作",
    "降不下来": "降弓无动作",
}

# 子系统关键词。用于两件事：显式过滤，以及"问的是没收录的子系统"时直接回未覆盖。
SYSTEM_HINTS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("pantograph", ("受电弓", "升弓", "降弓", "弓网", "碳滑板", "受电")),
    ("hvac", ("空调", "制冷", "压缩机", "冷凝", "出风口", "客室温度", "冷气")),
    ("door", ("车门", "门控器", "门扇", "隔离锁", "紧急解锁", "塞拉门")),
    # 下面两个不是知识库子系统，只用于把"没收录"与"描述不匹配"区分开。
    ("brake", ("制动", "刹车", "闸瓦", "制动缸")),
    ("wiper", ("雨刷", "刮水器", "风挡玻璃")),
)


def kb_dir() -> Path:
    env = os.getenv("KNOWLEDGE_DIR")
    if env:
        return Path(env)
    return Path(__file__).resolve().parent.parent / "data" / "knowledge"


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
    """关键词相关度。四路信号相加，权重是手调的，但每一项都有明确含义。"""
    qn = _norm(query)
    qb = _bigrams(qn)
    qc = set(qn)

    # 1) 人工关键词：最强的信号。命中即意味着"这条就是为这种说法写的"。
    keywords = [_norm(k) for k in entry.keywords]
    hits = sum(1 for k in keywords if k and k in qn)
    total = min(hits, 3) * 4.0

    # 2) 正文覆盖：标题 + 现象 + 原因 + 检查动作。
    body = "".join(
        [
            entry.title,
            *entry.symptoms,
            *(cause.text for cause in entry.likely_causes),
            *(c.action for c in entry.checks),
        ]
    )
    bn = _norm(body)
    total += 3.0 * _cos(qb, _bigrams(bn))
    total += 1.2 * _cos(qc, set(bn))

    # 3) 标题与现象的局部匹配：现象描述最接近现场原话。
    total += 2.5 * _cos(qb, _bigrams(_norm(entry.title)))
    best_symptom = max((_cos(qb, _bigrams(_norm(s))) for s in entry.symptoms), default=0.0)
    total += 3.0 * best_symptom
    return round(total, 3)


def _entry_text(entry: KnowledgeEntry) -> str:
    return "".join(
        [
            entry.title,
            *entry.symptoms,
            *entry.keywords,
            *(cause.text for cause in entry.likely_causes),
            *(c.action for c in entry.checks),
            *(c.expect for c in entry.checks),
            entry.escalation,
            entry.safety,
        ]
    )


def _tokens(text: str) -> list[str]:
    """字符二元组 + ASCII 词。中文短查询用二元组比单字稳定。"""
    normalized = _norm(text)
    grams = [normalized[i : i + 2] for i in range(len(normalized) - 1)]
    grams.extend(re.findall(r"[a-z0-9]{2,}", normalized))
    return grams


class _VectorIndex:
    """IDF 加权的稀疏向量索引，纯 Python，规模到几千条都够用。"""

    def __init__(self, entries: list[KnowledgeEntry]) -> None:
        self._ids = [entry.id for entry in entries]
        docs = [_tokens(_entry_text(entry)) for entry in entries]
        df: Counter[str] = Counter()
        for doc in docs:
            df.update(set(doc))
        total = max(1, len(docs))
        self._idf = {token: math.log((total + 1) / (count + 1)) + 1.0 for token, count in df.items()}
        self._vectors: dict[str, dict[str, float]] = {}
        for entry, doc in zip(entries, docs):
            tf = Counter(doc)
            vector = {
                token: (1.0 + math.log(count)) * self._idf.get(token, 1.0)
                for token, count in tf.items()
            }
            norm = math.sqrt(sum(value * value for value in vector.values())) or 1.0
            self._vectors[entry.id] = {token: value / norm for token, value in vector.items()}

    def score(self, query: str, entry_id: str) -> float:
        vector = self._vectors.get(entry_id)
        if not vector:
            return 0.0
        tf = Counter(_tokens(query))
        if not tf:
            return 0.0
        query_vector = {
            token: (1.0 + math.log(count)) * self._idf.get(token, 1.0)
            for token, count in tf.items()
        }
        norm = math.sqrt(sum(value * value for value in query_vector.values())) or 1.0
        dot = sum(
            value / norm * vector.get(token, 0.0) for token, value in query_vector.items()
        )
        return round(dot, 4)


@dataclass(frozen=True)
class Hit:
    entry: KnowledgeEntry
    score: float
    keyword: float
    vector: float

    def signals(self) -> dict:
        return {
            "keyword": round(self.keyword, 3),
            "vector": round(self.vector, 4),
            "combined": round(self.score, 3),
        }


class KnowledgeProvider(Protocol):
    """检索协议。返回 (条目, 分数)，已按分数降序。"""

    name: str

    def search(
        self, query: str, *, system: str | None = None, top_k: int = DEFAULT_TOP_K
    ) -> list[tuple[KnowledgeEntry, float]]: ...

    def systems(self) -> set[str]: ...


class KeywordProvider:
    """纯关键词实现，保留用于对照与降级。"""

    name = "keyword"

    def __init__(self, directory: Path | None = None) -> None:
        self._dir = directory or kb_dir()
        self._entries: list[KnowledgeEntry] = []
        self._version = ""
        self.reload()

    def reload(self) -> None:
        paths = sorted(self._dir.glob("*_faults.json"))
        if not paths:
            raise FileNotFoundError(f"知识库目录没有 *_faults.json：{self._dir}")
        entries: list[KnowledgeEntry] = []
        versions: set[str] = set()
        for path in paths:
            kb = KnowledgeBase.model_validate(json.loads(path.read_text(encoding="utf-8")))
            entries.extend(kb.entries)
            versions.add(kb.version)
        ids = [entry.id for entry in entries]
        if len(set(ids)) != len(ids):
            raise ValueError("知识库条目 id 重复")
        self._entries = entries
        self._version = "+".join(sorted(versions))
        log.info("知识库已加载：%d 条（%s，v%s）", len(entries), self._dir, self._version)

    @property
    def version(self) -> str:
        return self._version

    def entries(self) -> list[KnowledgeEntry]:
        return list(self._entries)

    def get(self, entry_id: str) -> KnowledgeEntry | None:
        return next((entry for entry in self._entries if entry.id == entry_id), None)

    def systems(self) -> set[str]:
        return {entry.system.value for entry in self._entries}

    def search_detailed(
        self, query: str, *, system: str | None = None, top_k: int | None = DEFAULT_TOP_K
    ) -> list[Hit]:
        candidates = [
            entry for entry in self._entries if system is None or entry.system.value == system
        ]
        hits = []
        for entry in candidates:
            keyword = score(query, entry)
            if keyword >= MIN_SCORE:
                hits.append(Hit(entry, keyword, keyword, 0.0))
        hits.sort(key=lambda hit: (-hit.score, hit.entry.id))
        return hits[:top_k] if top_k is not None else hits

    def search(
        self, query: str, *, system: str | None = None, top_k: int = DEFAULT_TOP_K
    ) -> list[tuple[KnowledgeEntry, float]]:
        capped = max(1, min(top_k, MAX_TOP_K))
        return [
            (hit.entry, hit.score)
            for hit in self.search_detailed(query, system=system, top_k=capped)
        ]


class HybridProvider:
    """关键词 + 稀疏向量的混合召回。

    关键词分负责精度（现场原话必中），向量分负责召回（换个说法也能找到）。
    两者都过阈值才进入结果；排序用 0.65/0.35 的加权，关键词优先。
    """

    name = "hybrid"

    def __init__(self, directory: Path | None = None) -> None:
        self._keyword = KeywordProvider(directory)
        self._index = _VectorIndex(self._keyword.entries())

    def reload(self) -> None:
        self._keyword.reload()
        self._index = _VectorIndex(self._keyword.entries())

    @property
    def version(self) -> str:
        return self._keyword.version

    def entries(self) -> list[KnowledgeEntry]:
        return self._keyword.entries()

    def get(self, entry_id: str) -> KnowledgeEntry | None:
        return self._keyword.get(entry_id)

    def systems(self) -> set[str]:
        return self._keyword.systems()

    def search_detailed(
        self, query: str, *, system: str | None = None, top_k: int = DEFAULT_TOP_K
    ) -> list[Hit]:
        candidates = [
            entry
            for entry in self._keyword.entries()
            if system is None or entry.system.value == system
        ]
        hits: list[Hit] = []
        for entry in candidates:
            keyword = score(query, entry)
            vector = self._index.score(query, entry.id)
            if keyword < MIN_SCORE and vector < MIN_VECTOR:
                continue
            combined = 0.65 * min(1.0, keyword / 12.0) + 0.35 * vector
            hits.append(Hit(entry, round(combined * 10, 3), keyword, vector))
        hits.sort(key=lambda hit: (-hit.score, -hit.keyword, hit.entry.id))
        return hits[: max(1, min(top_k, MAX_TOP_K))]

    def search(
        self, query: str, *, system: str | None = None, top_k: int = DEFAULT_TOP_K
    ) -> list[tuple[KnowledgeEntry, float]]:
        return [(hit.entry, hit.score) for hit in self.search_detailed(query, system=system, top_k=top_k)]


# 全量注入的上限：18 条知识库约 1.5K token，20 条留余量。
# 超过这个规模就该走检索，否则 prompt 成本与延迟都不可控。
FULL_INJECT_MAX = 20


class FullInjectionProvider:
    """全量注入：不做阈值过滤，把所有条目交给重排模型（计划 §2.3 的对照实现）。

    与 HybridProvider 的区别只有一个：**召回阶段不淘汰**。它适合"知识库很小、
    宁可由模型排序也不要漏掉"的场景，代价是每次排查都会把全部条目的标题与原因
    塞进 prompt。默认关闭，用 `KNOWLEDGE_PROVIDER=full` 切换，评测脚本可对比。

    排序仍先用关键词分算一遍：模型失败/超预算时要有一个确定的回退顺序，
    不能因为"全量注入"就把未过滤的条目按文件顺序返回。
    """

    name = "full"

    def __init__(self, directory: Path | None = None) -> None:
        self._keyword = KeywordProvider(directory)
        entries = self._keyword.entries()
        if len(entries) > FULL_INJECT_MAX:
            raise ValueError(
                f"全量注入只适用于 ≤{FULL_INJECT_MAX} 条的知识库，当前 {len(entries)} 条"
            )
        self._index = _VectorIndex(entries)

    def reload(self) -> None:
        self._keyword.reload()
        self._index = _VectorIndex(self._keyword.entries())

    @property
    def version(self) -> str:
        return self._keyword.version

    def entries(self) -> list[KnowledgeEntry]:
        return self._keyword.entries()

    def get(self, entry_id: str) -> KnowledgeEntry | None:
        return self._keyword.get(entry_id)

    def systems(self) -> set[str]:
        return self._keyword.systems()

    def search_detailed(
        self, query: str, *, system: str | None = None, top_k: int | None = None
    ) -> list[Hit]:
        candidates = [
            entry
            for entry in self._keyword.entries()
            if system is None or entry.system.value == system
        ]
        hits: list[Hit] = []
        for entry in candidates:
            keyword = score(query, entry)
            vector = self._index.score(query, entry.id)
            combined = 0.65 * min(1.0, keyword / 12.0) + 0.35 * vector
            hits.append(Hit(entry, round(combined * 10, 3), keyword, vector))
        hits.sort(key=lambda hit: (-hit.score, -hit.keyword, hit.entry.id))
        return hits[:top_k] if top_k is not None else hits

    def search(
        self, query: str, *, system: str | None = None, top_k: int = DEFAULT_TOP_K
    ) -> list[tuple[KnowledgeEntry, float]]:
        hits = self.search_detailed(query, system=system, top_k=top_k)
        return [(hit.entry, hit.score) for hit in hits]


def load_eval_set(path: Path | None = None) -> EvalSet:
    target = path or (kb_dir() / "eval_queries.json")
    return EvalSet.model_validate(json.loads(target.read_text(encoding="utf-8")))


_provider: HybridProvider | KeywordProvider | FullInjectionProvider | None = None
_provider_name = ""
_provider_lock = threading.Lock()


def _build_provider(name: str):
    if name == "full":
        try:
            return FullInjectionProvider()
        except ValueError as exc:
            # 知识库超出全量注入上限：不要因此让整个 B 模块起不来，回退混合召回。
            log.warning("全量注入不可用，回退 hybrid：%s", exc)
            return HybridProvider()
    if name == "keyword":
        return KeywordProvider()
    if name != "hybrid":
        log.warning("未知 KNOWLEDGE_PROVIDER=%r，回退 hybrid", name)
    return HybridProvider()


def get_provider(name: str | None = None):
    """按 `KNOWLEDGE_PROVIDER`（或显式参数）选择实现，默认 hybrid。

    缓存按名字区分：评测脚本可以在同一进程里切 full/hybrid 做对比，
    不必重启，也不会让线上请求拿到评测用的实例。
    """
    global _provider, _provider_name
    wanted = (name or os.getenv("KNOWLEDGE_PROVIDER", "hybrid") or "hybrid").strip().lower()
    if _provider is not None and _provider_name == wanted:
        return _provider
    with _provider_lock:
        if _provider is None or _provider_name != wanted:
            _provider = _build_provider(wanted)
            _provider_name = _provider.name
    return _provider


def reset_provider() -> None:
    """仅测试使用：换知识库目录、改分数阈值或切 Provider 后重新加载。"""
    global _provider, _provider_name
    with _provider_lock:
        _provider = None
        _provider_name = ""


def get_entry(entry_id: str) -> KnowledgeEntry | None:
    return get_provider().get(entry_id)


def _uncovered_message(covered: set[str]) -> str:
    labels = "、".join(SYSTEM_LABELS[system] for system in sorted(covered) if system in SYSTEM_LABELS)
    return (
        f"未覆盖：当前知识库只收录{labels}故障，该子系统尚未建立条目。"
        "建议按车型手册排查，并把这起现象上报给技术组补充条目。"
    )


_UNCOVERED_NO_MATCH = (
    "未覆盖：现有条目没有与描述足够接近的故障。"
    "建议先记录故障码、发生时机与操作顺序，再上报处理，不要凭经验强行拆检。"
)


def uncovered_message(reason: str) -> str:
    if reason == "system_not_covered":
        return _uncovered_message(get_provider().systems())
    return _UNCOVERED_NO_MATCH


def recall(
    query: str, *, system: str | None = None, top_k: int = DEFAULT_TOP_K
) -> tuple[list[Hit], str | None]:
    """只召回，不重排。返回 (命中, 未覆盖原因)。

    拆出来是为了 SSE（2026-11-01）：重排是一次模型调用，秒级；召回是毫秒级。
    两者捆在一个函数里，前端就只能等最慢的那一步才开始画界面。
    """
    text = query.strip()
    provider = get_provider()
    guessed = system or infer_system(text)
    if guessed and guessed not in provider.systems():
        return [], "system_not_covered"
    hits = provider.search_detailed(
        text,
        system=guessed,
        # full 模式不截断：所有条目都进重排 prompt，这才叫"全量注入"。
        top_k=None if provider.name == "full" else max(top_k, DEFAULT_TOP_K),
    )
    if not hits:
        return [], "no_match"
    return hits, None


def _cap(hits: list[Hit], top_k: int) -> list[Hit]:
    return hits[: max(1, min(top_k, MAX_TOP_K))]


def apply_rerank(query: str, hits: list[Hit]) -> tuple[list[Hit], dict | None]:
    """受限重排。失败时原样返回检索顺序——排序可以退化，"找不到"不能。"""
    if len(hits) <= 1:
        return hits, None
    limit = (
        FULL_INJECT_MAX
        if get_provider().name == "full"
        else rerank_service.MAX_CANDIDATES
    )
    info = rerank_service.rerank(
        query, [hit.entry for hit in hits], max_candidates=limit
    )
    if not info:
        return hits, None
    order = {entry_id: index for index, entry_id in enumerate(info["order"])}
    return sorted(hits, key=lambda hit: order.get(hit.entry.id, len(order))), info


def search_entries(
    query: str,
    *,
    system: str | None = None,
    top_k: int = DEFAULT_TOP_K,
    use_rerank: bool = True,
) -> tuple[list[Hit], dict | None, str | None]:
    """返回 (命中, 重排信息, 未覆盖原因)。一次性路径，行为与拆分前完全一致。"""
    hits, reason = recall(query, system=system, top_k=top_k)
    if reason:
        return [], None, reason
    if not use_rerank:
        return _cap(hits, top_k), None, None
    hits, info = apply_rerank(query.strip(), hits)
    # full 模式的召回不截断，这里统一收口到 top_k；hybrid 的命中本来就更少。
    return _cap(hits, top_k), info, None


def _hit_payload(hit: Hit) -> dict:
    """一条命中的完整字段。SSE 的最终帧与一次性 JSON 共用，避免两份结构。"""
    return {
        "id": hit.entry.id,
        "title": hit.entry.title,
        "system": hit.entry.system.value,
        "score": hit.score,
        # 匹配度：combined 的满分是 10，归一化后落到 0–1。
        # 对外必须叫"匹配度"而不是"置信度"——combined 天然落在 4–6，
        # 直接说置信度会让一条完全正确的 Top-1 命中显示成"47%"，
        # 现场会误判为不可靠。它是"这条条目有多贴近现场描述"，不是"结论一定对"。
        "confidence": round(min(1.0, hit.score / 10.0), 2),
        "signals": hit.signals(),
        "likely_causes": [cause.model_dump() for cause in hit.entry.likely_causes],
        "checks": [check.model_dump() for check in hit.entry.checks],
        "escalation": hit.entry.escalation,
        "safety": hit.entry.safety,
        "sources": hit.entry.sources,
    }


def _build_result(
    text: str,
    hits: list[Hit],
    rerank_info: dict | None,
    reason: str | None,
    started: float,
) -> dict:
    results = [_hit_payload(hit) for hit in hits]
    if reason:
        message = uncovered_message(reason)
        suggestion = "记录现象与故障码后上报，不要凭经验拆检。"
    else:
        message = ""
        suggestion = results[0]["escalation"]

    return {
        "query": text,
        "matched": reason is None,
        "uncovered_reason": reason,
        "message": message,
        "suggestion": suggestion,
        "results": results,
        "count": len(results),
        # 最可能那条的匹配度。未覆盖时没有结论，给 0 而不是编一个数。
        "confidence": results[0]["confidence"] if results else 0.0,
        "took_ms": int((time.perf_counter() - started) * 1000),
        "kb_version": get_provider().version,
        "provider": get_provider().name,
        "rerank": rerank_info,
        "disclaimer": DISCLAIMER,
    }


def diagnose(query: str, *, system: str | None = None, top_k: int = DEFAULT_TOP_K) -> dict:
    """一次性返回排查建议；重排失败时仍是可用的检索结果。"""
    started = time.perf_counter()
    text = query.strip()
    hits, rerank_info, reason = search_entries(text, system=system, top_k=top_k)
    return _build_result(text, hits, rerank_info, reason, started)


def iter_diagnose(
    query: str, *, system: str | None = None, top_k: int = DEFAULT_TOP_K
):
    """分三阶段产出，给 `POST /diagnose?stream=1` 用。

    `recall` → `rerank` → `done`，每一帧都是**真的完成了一步**，不是把同一份
    结果切片假装流式：召回帧之后前端就能列出候选，重排帧之后才改顺序。

    未覆盖的情况只有两帧（`recall` 带空列表 + `done`）：没有候选就没有重排，
    发一个空的 rerank 帧只会让人以为"还在算"。
    """
    started = time.perf_counter()
    text = query.strip()

    hits, reason = recall(text, system=system, top_k=top_k)
    yield "recall", {
        "stage": "recall",
        "matched": reason is None,
        "uncovered_reason": reason,
        "candidates": [
            {"id": hit.entry.id, "title": hit.entry.title, "score": hit.score}
            for hit in hits
        ],
        "count": len(hits),
        "took_ms": int((time.perf_counter() - started) * 1000),
    }
    if reason:
        yield "done", _build_result(text, [], None, reason, started)
        return

    hits, info = apply_rerank(text, hits)
    yield "rerank", {
        "stage": "rerank",
        "applied": info is not None,
        # 重排被关掉、模型没 Key、超时，都属于"没应用"：三者对用户的含义一样，
        # 都是"顺序按检索分数排"。细节在 done 帧的 rerank 字段里。
        "order": info["order"] if info else [hit.entry.id for hit in hits],
        "took_ms": int((time.perf_counter() - started) * 1000),
    }
    yield "done", _build_result(text, _cap(hits, top_k), info, None, started)
