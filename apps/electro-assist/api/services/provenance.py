"""判据来源回填：给每条判据写上"这个数值来自原文第几行"。

**为什么由服务端算，不让模型写**：模型看不到图、也数不准行。生成时一律剥掉模型
给的 `provenance`（`llm/runner.py`），改由这里在落库前用原文重新定位。所以
provenance 的可信度不依赖模型诚实，只依赖"这段字在不在原文里"这个可复现的判断。

**为什么复用 `llm/extract.py` 的 `locate`**：识别期和生成期必须用**同一套**比较规则
（NFKC 折叠、横线统一、跨行拼接）。两处各写一份，迟早出现"同一条判据在确认页
指得回去、在指导书里指不回去"这种自相矛盾。

**指不回去就不填**：`provenance=None` 表示"没有来源"，前端据此显示"无据"。
填一个 `raw_text=None` 的空壳等于制造"看起来有溯源"的假象，比不填更糟。
"""
from __future__ import annotations

import unicodedata

from llm.extract import NUM_RE, locate
from models.guide import Criterion, CriterionType, Guide, Provenance

# 一行原文最多留这么多字进 `raw_text`（与 `Provenance` 字段上限一致）。
MAX_RAW_TEXT = 200


def split_lines(text: str) -> list[str]:
    """把工艺原文切成"行"，与识别期 `_clean_lines` 同一口径：去空行、去首尾空白。

    不对齐这一步，行号就会在"空行算不算"上漂一格。空行不承载内容，
    算进去只会让人翻到一行空白去核对。
    """
    return [line.strip() for line in text.splitlines() if line.strip()]


def _number_keys(text: str) -> set[str]:
    """归一化的数字集合：`2.0` 与 `2` 视为同一个。

    工艺卡上「2～3.5s」和「2.0～3.5s」都常见，模型填进 Guide 的 `min` 一定是
    float（2.0）。按字符串比会把这两种写法判成不同值，回填率会莫名其妙地低，
    而且低得没有规律——这种"看起来随机"的失败最难查。
    """
    keys: set[str] = set()
    for raw in NUM_RE.findall(unicodedata.normalize("NFKC", text)):
        try:
            keys.add(f"{float(raw):g}")
        except ValueError:
            continue
    return keys


def _line_holding(lines: list[str], wanted: set[str]) -> tuple[int, str] | None:
    """找第一条**包含全部**目标数字的行。

    要求全部命中而不是命中一个：范围判据的两个端点必须来自同一行，
    否则「2.0」取自第 3 行、「3.5」取自第 9 行，拼出来的范围原文里根本没写过。
    """
    if not wanted:
        return None
    for index, line in enumerate(lines):
        if wanted <= _number_keys(line):
            return index, line
    return None


def _locate_criterion(lines: list[str], criterion: Criterion, asset_id: str | None) -> Provenance | None:
    """先按标签整句定位（ok），再退到数值（suspect），都不行就放弃。"""
    line, source = locate(lines, criterion.label)
    if line is not None:
        return Provenance(
            asset_id=asset_id,
            line=line,
            raw_text=source[:MAX_RAW_TEXT],
            flag="ok",
        )

    if criterion.type is CriterionType.range and criterion.min is not None and criterion.max is not None:
        # 端点用 `:g` 格式化，避免 float 的 `2.0` 引入一个原文里没有的小数点。
        wanted = {f"{criterion.min:g}", f"{criterion.max:g}"}
        found = _line_holding(lines, wanted)
        if found is not None:
            index, text = found
            return Provenance(
                asset_id=asset_id,
                line=index,
                raw_text=text[:MAX_RAW_TEXT],
                flag="suspect",
            )
    return None


def backfill(guide: Guide, text: str, assets: list[dict]) -> int:
    """给 `guide` 的每条判据回填 provenance，返回回填条数（供日志）。原地修改。

    `asset_id` 只在**本次提交恰好 1 张图**时才填：多张图是合并转录的，识别期
    本来就没记录行号属于哪张图，这里硬指一张就是编。0 张（纯文本输入）时为 None，
    靠 `line` 做锚点。
    """
    lines = split_lines(text)
    if not lines:
        return 0

    asset_id = assets[0]["id"] if len(assets) == 1 else None
    filled = 0
    for step in guide.steps:
        for criterion in step.criteria:
            if criterion.provenance is not None:
                continue
            found = _locate_criterion(lines, criterion, asset_id)
            if found is not None:
                criterion.provenance = found
                filled += 1
    return filled
