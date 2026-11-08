"""存量 JSON 回放门禁（评审 P2-2 / 待办 R5-5）。

**守的是什么**：删模型字段会让库里已写出去的 JSON 解析失败（`extra="forbid"`），
而 `GET /guides/{id}` 返回原始 JSON、看不出异常——坏在 A1 开始 / 编辑 / 发布三条路径上，
是"上线后才发现"的典型形态。2026-11-08 已经踩过一次（删 `Provenance.confidence`）。

**为什么用冻结样本而不是构造数据**：构造出来的 JSON 只能证明"我想得到的形状读得懂"。
冻结样本是历史真的写出去过的字节，能钉住"库里的东西还在不在"。

**它的边界（写清楚，别高估）**：只覆盖 `tests/fixtures/legacy/` 里已有的形状。
下次要删字段，必须先把一份含该字段的样本冻进来，否则这道门禁保护不到——规矩在
`scripts/replay_samples.py` 的模块注释与 `docs/DEVELOPMENT.md` 里。
"""
from __future__ import annotations

import json

from scripts.replay_samples import DEPRECATED_KEYS, FIXTURES, replay_dir


def test_frozen_legacy_samples_still_parse():
    """每份冻结样本都要能读、能回写、且废弃键不再写出。"""
    results = replay_dir(FIXTURES)
    assert results, f"{FIXTURES} 里没有样本，门禁等于没开"

    failures = [f"{p.name}：{msg}" for p, ok, msg in results if not ok]
    assert not failures, "存量 JSON 读不懂了：\n" + "\n".join(failures)


def test_fixtures_really_contain_deprecated_keys():
    """样本必须真的带废弃键，否则这条用例只是"读了几个正常文件"。

    防的是：有人为了让它变绿，把带 `confidence` 的样本换成干净样本。
    """
    raws = [p.read_text(encoding="utf-8") for p in FIXTURES.glob("*.json")]
    assert raws, "样本目录为空"
    for key in DEPRECATED_KEYS:
        assert any(f'"{key}"' in raw for raw in raws), f"没有一份样本带 `{key}`，这道门禁名不副实"


def test_replay_detects_a_broken_sample(tmp_path):
    """反向验证：塞一份缺必填字段的 JSON，脚本必须报失败。

    这条用例证明"检查会红"，而不是"检查跑过了"。
    """
    bad = tmp_path / "guide_broken.json"
    bad.write_text(json.dumps({"schema_version": "1.2"}), encoding="utf-8")

    results = replay_dir(tmp_path)

    assert len(results) == 1
    _, ok, message = results[0]
    assert ok is False and message
