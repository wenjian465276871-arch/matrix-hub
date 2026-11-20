"""已下架样例：后端名单与前端 render-grader 跳过名单必须一致。

为什么值得一条测试：
- 后端的 `RETIRED_SAMPLE_IDS` 决定"不进 seed、已有行降 draft"；
- 前端的 `RETIRED` 决定"不跑渲染评分"。
两边只需一边漏改，就会出现"下架了但 E2E 还在评它"或"E2E 跳过了一份在架样例"——
后者更隐蔽：它不会红，只是少测了一份产品内容。
"""
from __future__ import annotations

import re
from pathlib import Path

from services.library import RETIRED_SAMPLE_IDS

ROOT = Path(__file__).resolve().parents[4]
SPEC = ROOT / "apps" / "electro-assist" / "web" / "tests" / "e2e" / "render-grader.spec.ts"


def test_grader_retired_set_matches_backend():
    text = SPEC.read_text(encoding="utf-8")
    block = re.search(r"const RETIRED = new Set\(\[(.*?)\]\)", text, re.S)
    assert block is not None, "render-grader 里找不到 RETIRED 名单"
    listed = set(re.findall(r"'([^']+)'", block.group(1)))
    assert listed == set(RETIRED_SAMPLE_IDS), (
        f"前端跳过名单 {sorted(listed)} 与后端 {sorted(RETIRED_SAMPLE_IDS)} 不一致"
    )
    assert "RETIRED.has(" in text, "名单定义了但没用于过滤"
