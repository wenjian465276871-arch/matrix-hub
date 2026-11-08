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
from models.guide import AssetRef, Criterion, CriterionType, Guide, Provenance

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


def _locate_step(lines: list[str], step, asset_id: str | None) -> Provenance | None:
    """步骤级来源：只看 `action`，且只接受"整句能在原文里找到"（`ok`），**不做数值回退**。

    为什么不像判据那样按数字兜底：一步动作里常有好几个数值，按数字集合匹配很容易
    指到"另一条也在说 2.0mm"的行——**指错行比指不回去更危险**，人会拿着错误的一行
    核对，然后以为对上了。

    为什么不拿 `title` 兜底：标题是两三个字的概括语（"开关门"），原文里到处都能命中，
    命中了也不说明这一行是它的来源。实测 `title="开关门"` 会指到"开关门各 3 次…"
    那一行——看起来对，其实是碰巧。
    """
    if not step.action:
        return None
    line, source = locate(lines, step.action)
    if line is None:
        return None
    return Provenance(
        asset_id=asset_id,
        line=line,
        raw_text=source[:MAX_RAW_TEXT],
        flag="ok",
    )


def backfill(guide: Guide, text: str, assets: list[AssetRef]) -> int:
    """给 `guide` 的判据与步骤回填 provenance，返回**判据**回填条数（供日志）。原地修改。

    步骤级 provenance 单独记在 `step.provenance`，不并进返回值——两者粒度不同，
    合成一个数字会让日志里的 `sources=N` 说不清是"几条判据"还是"几步动作"。

    `assets` 必须是**校验过的 `AssetRef`**，不是请求体里的裸 dict：
    请求体的字段叫 `asset_id`，裸 dict 若当成 `["id"]` 取会抛 KeyError，
    而这里的外层 `try/except` 会把它吞成一行 warning——2026-11-08 生产上
    就是这样"静默零回填"的。用模型对象，字段名错了当场 AttributeError。

    `asset_id` 只在**本次提交恰好 1 张图**时才填：多张图是合并转录的，识别期
    本来就没记录行号属于哪张图，这里硬指一张就是编。0 张（纯文本输入）时为 None，
    靠 `line` 做锚点。
    """
    lines = split_lines(text)
    if not lines:
        return 0

    asset_id = assets[0].asset_id if len(assets) == 1 else None
    filled = 0
    for step in guide.steps:
        # 步骤级：这一步的作业描述来自原文哪一行。判据级更精确，但两者回答的问题不同
        # ——"这一整步是抄的还是编的"与"这个数值是抄的还是编的"。
        if step.provenance is None:
            step.provenance = _locate_step(lines, step, asset_id)
        for criterion in step.criteria:
            if criterion.provenance is not None:
                continue
            found = _locate_criterion(lines, criterion, asset_id)
            if found is not None:
                criterion.provenance = found
                filled += 1
    return filled
