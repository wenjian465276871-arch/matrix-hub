#!/usr/bin/env python3
"""知识库质量检查：重复、字段完整性、来源链接与主题匹配、自命中率。

## 为什么单独成脚本

`pytest` 只能证明"能加载"：schema 过了不代表 300 多条不是同一个意思换着说法。
这个脚本回答四个问题，每个都能给出数字：

1. **重复**：标题/关键词/现象是否撞车（二元组 Jaccard + 关键词重合）；
2. **完整**：六要素（现象、原因、检查、升级、安全、来源链接）是否真的都有内容；
3. **来源可信**：链接是否是 http(s)、域名是否属于该子系统的允许清单
   ——防"空调条目挂一篇受电弓论文"这种看起来合规、实际无关的来源；
4. **可检索**：拿每条自己的标题当查询，看 Top-1 是不是它自己。命中率低说明
   同族条目写得太像，现场换个说法就会串条。

## 退出码

- 0：无硬错误（重复 id、标题完全重复、缺链接、来源主题不匹配均为 0）；
- 1：存在硬错误，明细见输出；
- 2：知识库目录为空或加载失败。

用法：
    python scripts/check_kb_quality.py
    python scripts/check_kb_quality.py --report ../../docs/reports/kb-quality-2026-11-19.md
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from models.knowledge import KnowledgeBase  # noqa: E402
from services import knowledge as kb_service  # noqa: E402

API_DIR = Path(__file__).resolve().parents[1]
KB_DIR = API_DIR / "data" / "knowledge"

# 域名 → 允许出现的子系统。只约束"跨子系统挂错来源"，不追求穷举。
DOMAIN_SYSTEMS: dict[str, set[str]] = {
    "edl.csrzic.com": {"door", "pantograph"},
    "www.mlzp.cc": {"door", "hvac", "pantograph", "wiper"},
    "xueshu.qikan.com.cn": {"door", "hvac", "pantograph", "brake"},
    "journal.yuanpingjia.com.cn": {"door"},
    "www.11665.com": {"door"},
    "www.2winpub.com": {"door", "hvac"},
    "cscl.cbpt.cnki.net": {"door"},
    "ccnpub.com": {"door"},
    "mooc1.chaoxing.com": {"door", "pantograph"},
    "www.qikanchina.com": {"door", "brake"},
    "d.wanfangdata.com.cn": {"brake"},
    "xxjk.cbpt.cnki.net": {"brake"},
    "tljsjyy.xml-journal.net": {"brake"},
    "www.c-eu.cn": {"wiper"},
    "www.luyouqiwang.cn": {"wiper"},
    "3g.china.com": {"wiper"},
    "wap.cinn.cn": {"door"},
    "www.chinaqking.com": {"door", "hvac"},
    "baike.ecrrc.com": {"door"},
    "patents.google.com": {"door"},
    "m.renrendoc.com": {"door"},
    "search.napstic.cn": {"hvac"},
    "cjkj88.com": {"hvac"},
    "www.ebnew.com": {"hvac"},
    "www.knowcat.cn": {"hvac"},
    "www.yidocs.com": {"hvac"},
    "cqrb.cn": {"hvac"},
    "peoplerail.com": {"hvac"},
    "b2bwiki.baidu.com": {"pantograph"},
    "ojs-s-p.sg": {"pantograph"},
    "www.damishu.cn": {"pantograph"},
    "www.nra.gov.cn": {"pantograph", "wiper"},
    "zazhi.chinaet.net": {"pantograph"},
    "umt1998.tongji.edu.cn": {"pantograph"},
}

TITLE_SIMILARITY_LIMIT = 0.75
KEYWORD_OVERLAP_LIMIT = 0.9


def _bigrams(text: str) -> set[str]:
    norm = re.sub(r"[^0-9a-z\u4e00-\u9fff]+", "", text.lower())
    if len(norm) < 2:
        return {norm} if norm else set()
    return {norm[i : i + 2] for i in range(len(norm) - 1)}


def _jaccard(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def load_entries() -> list:
    paths = sorted(KB_DIR.glob("*_faults.json"))
    if not paths:
        raise SystemExit(2)
    entries = []
    for path in paths:
        payload = KnowledgeBase.model_validate(json.loads(path.read_text(encoding="utf-8")))
        for entry in payload.entries:
            entries.append((path.name, entry))
    return entries


def main() -> int:
    parser = argparse.ArgumentParser(description="知识库质量检查")
    parser.add_argument("--report", help="把结果写成 Markdown 报告")
    args = parser.parse_args()

    rows = load_entries()
    errors: list[str] = []
    warnings: list[str] = []

    ids = [entry.id for _, entry in rows]
    dup_ids = [item for item, count in Counter(ids).items() if count > 1]
    if dup_ids:
        errors.append(f"重复 id：{dup_ids}")

    # ---- 1. 标题/关键词/现象重复 ----
    title_pairs: list[tuple[float, str, str]] = []
    keyword_pairs: list[tuple[float, str, str]] = []
    symptom_dups: list[tuple[str, str, str]] = []
    for i in range(len(rows)):
        for j in range(i + 1, len(rows)):
            a = rows[i][1]
            b = rows[j][1]
            if a.system != b.system:
                continue
            ratio = _jaccard(_bigrams(a.title), _bigrams(b.title))
            if ratio >= TITLE_SIMILARITY_LIMIT:
                title_pairs.append((round(ratio, 2), a.id, b.id))
            ka, kb = set(a.keywords), set(b.keywords)
            if ka and kb and len(ka & kb) / min(len(ka), len(kb)) >= KEYWORD_OVERLAP_LIMIT:
                keyword_pairs.append((round(len(ka & kb) / min(len(ka), len(kb)), 2), a.id, b.id))
            same = set(a.symptoms) & set(b.symptoms)
            if same:
                symptom_dups.append((a.id, b.id, "；".join(sorted(same))[:60]))

    if title_pairs:
        errors.append(f"标题高度相似 {len(title_pairs)} 对（阈值 {TITLE_SIMILARITY_LIMIT}）")
    if keyword_pairs:
        warnings.append(f"关键词高度重合 {len(keyword_pairs)} 对（阈值 {KEYWORD_OVERLAP_LIMIT}）")
    if symptom_dups:
        warnings.append(f"条目间存在完全相同现象描述 {len(symptom_dups)} 处")

    # ---- 2. 六要素完整性 ----
    incomplete: list[str] = []
    for _, entry in rows:
        problems = []
        if len(entry.symptoms) < 2:
            problems.append("现象")
        if len(entry.likely_causes) < 2:
            problems.append("原因")
        if len(entry.checks) < 2:
            problems.append("检查")
        if len(entry.escalation.strip()) < 10:
            problems.append("升级条件")
        if len(entry.safety.strip()) < 4:
            problems.append("安全提示")
        if not entry.source_links:
            problems.append("来源链接")
        if not entry.sources:
            problems.append("来源批次")
        if problems:
            incomplete.append(f"{entry.id}（缺：{'、'.join(problems)}）")
    if incomplete:
        errors.append(f"六要素不完整 {len(incomplete)} 条")

    # ---- 3. 来源链接 ----
    scheme_bad: list[str] = []
    domain_bad: list[str] = []
    domain_counter: Counter[str] = Counter()
    for _, entry in rows:
        for link in entry.source_links:
            if not link.startswith(("http://", "https://")):
                scheme_bad.append(f"{entry.id}: {link[:60]}")
                continue
            host = urlparse(link).netloc
            domain_counter[host] += 1
            allowed = DOMAIN_SYSTEMS.get(host)
            if allowed is None:
                domain_bad.append(f"{entry.id}: 未登记域名 {host}")
            elif entry.system.value not in allowed:
                domain_bad.append(f"{entry.id}: {host} 不属于 {entry.system.value}")
    if scheme_bad:
        errors.append(f"来源链接协议非法 {len(scheme_bad)} 条")
    if domain_bad:
        errors.append(f"来源主题不匹配/未登记 {len(domain_bad)} 条")

    # ---- 4. 自命中率 ----
    provider = kb_service.get_provider()
    top1 = 0
    top3 = 0
    misses: list[str] = []
    for _, entry in rows:
        hits = provider.search_detailed(entry.title, system=entry.system.value, top_k=3)
        hit_ids = [hit.entry.id for hit in hits]
        if hit_ids[:1] == [entry.id]:
            top1 += 1
        elif entry.id in hit_ids:
            top3 += 1
            misses.append(entry.id)
        else:
            misses.append(f"{entry.id}(未进前3)")
    total = len(rows)
    self_top1 = round(top1 / total * 100, 1)
    self_top3 = round((top1 + top3) / total * 100, 1)

    # ---- 输出 ----
    by_system = Counter(entry.system.value for _, entry in rows)
    by_file = Counter(name for name, _ in rows)
    lines = [
        "# 知识库质量检查",
        "",
        "- 条目总数：**%d**（按系统：%s）"
        % (total, " / ".join(f"{name} {count}" for name, count in sorted(by_system.items()))),
        f"- 文件数：{len(by_file)}",
        f"- 唯一 id：{len(set(ids))}（重复 {len(dup_ids)}）",
        f"- 标题高度相似：{len(title_pairs)} 对；关键词高度重合：{len(keyword_pairs)} 对；相同现象描述：{len(symptom_dups)} 处",
        f"- 六要素不完整：{len(incomplete)} 条",
        f"- 来源链接：合法 {sum(domain_counter.values())} 条 / 非法协议 {len(scheme_bad)} / 主题不匹配或未登记域名 {len(domain_bad)}",
        f"- 自命中：Top-1 **{self_top1}%**，Top-3 **{self_top3}%**（拿标题当查询，测同族条目是否太像）",
        "",
        "## 来源域名分布",
        "",
        "| 域名 | 引用次数 | 允许系统 |",
        "|---|---|---|",
    ]
    for host, count in domain_counter.most_common():
        lines.append(f"| {host} | {count} | {'、'.join(sorted(DOMAIN_SYSTEMS.get(host, {'未登记'})))} |")

    lines += ["", "## 按文件", "", "| 文件 | 条数 |", "|---|---|"]
    for name, count in sorted(by_file.items()):
        lines.append(f"| `{name}` | {count} |")

    if title_pairs:
        lines += ["", "## 标题高度相似（需人工确认是否合并）", "", "| 相似度 | A | B |", "|---|---|---|"]
        for ratio, a, b in sorted(title_pairs, reverse=True)[:30]:
            lines.append(f"| {ratio} | `{a}` | `{b}` |")
    if keyword_pairs:
        lines += ["", "## 关键词高度重合（前 30）", "", "| 重合度 | A | B |", "|---|---|---|"]
        for ratio, a, b in sorted(keyword_pairs, reverse=True)[:30]:
            lines.append(f"| {ratio} | `{a}` | `{b}` |")
    if incomplete:
        lines += ["", "## 六要素不完整", ""] + [f"- {item}" for item in incomplete]
    if domain_bad:
        lines += ["", "## 来源主题不匹配", ""] + [f"- {item}" for item in domain_bad]
    if misses:
        lines += ["", "## 自命中未达 Top-1（前 30）", ""] + [f"- {item}" for item in misses[:30]]

    text = "\n".join(lines) + "\n"
    print(text)
    if args.report:
        target = Path(args.report)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8")
        print(f"报告已写入：{target}")

    for item in errors:
        print(f"[ERROR] {item}", file=sys.stderr)
    for item in warnings:
        print(f"[WARN] {item}", file=sys.stderr)
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
