"""判据来源回填：模型不写 provenance，服务端用原文定位后补上。

守的四件事：

1. **能定位就填 `ok`，只对得上数字填 `suspect`，都定位不到就不填**——不填
   比填一个空壳好：`provenance=None` 让前端显示"无据"，空壳会让它显示"有据"；
2. **`asset_id` 只在恰好 1 张图时才填**。多张图是合并转录的，硬指一张就是编；
3. **范围判据的两个端点必须来自同一行**，跨行拼出来的范围原文里没写过；
4. `Provenance` 至少有一个锚点，两个都空的构造必须被拒——否则这张表会退化成
   "谁都能塞一个看起来像来源的东西"。

反向验证：把 `_line_holding` 的 `wanted <= ...` 改成 `wanted & ...`（任一命中），
`test_range_endpoints_must_share_one_line` 立刻红。
"""
from __future__ import annotations

import json

import pytest

import store
from models.guide import AssetRef, Guide, Provenance
from services import generation
from services.jobqueue import job_queue
from services.provenance import backfill, split_lines

TEXT = "工序：开关门试验\n\n1. 开关门各 3 次，开门时间 2.0–3.5s\n2. 记录结果"


@pytest.fixture()
def env(tmp_path, monkeypatch):
    """独立库 + 干净队列。与 `test_generate.py` 的 `env` 同构，但不设配额环境变量。

    为什么不用 `conftest` 的 `_isolated_db`：那是 session 级、跨文件共享的，
    这里写 job 与 usage 会污染别的文件的统计断言。
    """
    monkeypatch.setenv("DB_PATH", str(tmp_path / "electro.db"))
    store.init_db()
    job_queue.reset()
    yield


def _guide(criteria: list[dict]) -> Guide:
    return Guide(
        id="g_trace_test_001",
        title="开关门功能试验",
        summary="用于测试的指导书摘要，内容为虚构演示数据",
        meta={"system": "door", "source_note": "公开资料改写（演示）", "model": "stub"},
        steps=[
            {
                "id": "s01",
                "seq": 1,
                "title": "开关门",
                "action": "开关门各 3 次，开门时间 2.0–3.5s",
                "criteria": criteria,
            }
        ],
    )


def _range(cid: str = "c_door_time", label: str = "开门时间", lo: float = 2.0, hi: float = 3.5) -> dict:
    return {"id": cid, "label": label, "type": "range", "unit": "s", "min": lo, "max": hi}


def test_split_lines_drops_blanks() -> None:
    assert split_lines(TEXT) == [
        "工序：开关门试验",
        "1. 开关门各 3 次，开门时间 2.0–3.5s",
        "2. 记录结果",
    ]


def test_label_hit_is_ok_with_line_and_raw_text() -> None:
    guide = _guide([_range()])
    filled = backfill(guide, TEXT, [])
    assert filled == 1
    prov = guide.steps[0].criteria[0].provenance
    assert prov is not None
    assert prov.flag == "ok"
    assert prov.line == 1
    assert "2.0–3.5s" in (prov.raw_text or "")
    assert prov.asset_id is None


def test_label_miss_but_numbers_hit_is_suspect() -> None:
    """标签被改写（"关门时间" vs 原文"开门时间"），但两端数字都在同一行。"""
    guide = _guide([_range(label="关门时间")])
    backfill(guide, TEXT, [])
    prov = guide.steps[0].criteria[0].provenance
    assert prov is not None
    assert prov.flag == "suspect"
    assert prov.line == 1


def test_nothing_matches_leaves_no_provenance() -> None:
    """指不回去就不填——`None` 让前端说"无据"，空壳会让它说"有据"。"""
    guide = _guide([_range(cid="c_ins", label="绝缘电阻", lo=500, hi=1000)])
    assert backfill(guide, TEXT, []) == 0
    assert guide.steps[0].criteria[0].provenance is None


def test_range_endpoints_must_share_one_line() -> None:
    """2.0 在第 2 行、3.5 在第 9 行时，不能拼出一个原文里没有的范围。"""
    text = "\n".join(
        [
            "1. 开门时间上限 3.5s",
            "2. 关门时间下限 2.0s",
            "3. 无关内容",
        ]
    )
    guide = _guide([_range(label="开门时间应为")])
    assert backfill(guide, text, []) == 0
    assert guide.steps[0].criteria[0].provenance is None


def test_asset_id_only_when_exactly_one_image() -> None:
    one = _guide([_range()])
    backfill(one, TEXT, [AssetRef(asset_id="a_0123456789abcdef", caption="现场照片")])
    assert one.steps[0].criteria[0].provenance.asset_id == "a_0123456789abcdef"

    two = _guide([_range()])
    backfill(
        two,
        TEXT,
        [
            AssetRef(asset_id="a_0123456789abcdef", caption="现场照片"),
            AssetRef(asset_id="a_fedcba9876543210", caption="另一张"),
        ],
    )
    assert two.steps[0].criteria[0].provenance.asset_id is None


def test_attach_assets_hands_over_validated_refs() -> None:
    """回归：请求体字段是 `asset_id`，不是 `id`。

    2026-11-08 生产实测：`backfill` 里写成 `assets[0]["id"]` → `KeyError: 'id'`，
    被外层 `except` 吞成一行 warning，前端表现为「provenance 恒为 null」。
    当时这份测试用的是我自己编的 `{"id": ...}`，与真实请求形状不一致，所以全绿——
    **测试数据编错形状，等于给 bug 发通行证**。这里改成走真实的
    `_attach_assets`（它吃 `{"asset_id", "caption"}` 的 JSON）。
    """
    from services.generation import _attach_assets

    guide = _guide([_range()])
    refs = _attach_assets(
        guide,
        {
            "id": "j_test",
            "assets_json": json.dumps([{"asset_id": "a_0123456789abcdef", "caption": "现场照片"}]),
        },
    )
    assert [r.asset_id for r in refs] == ["a_0123456789abcdef"]

    assert backfill(guide, TEXT, refs) == 1
    prov = guide.steps[0].criteria[0].provenance
    assert prov.asset_id == "a_0123456789abcdef"
    assert prov.line == 1


def test_existing_provenance_is_not_overwritten() -> None:
    guide = _guide([_range()])
    guide.steps[0].criteria[0].provenance = Provenance(line=7, raw_text="已有的", flag="suspect")
    backfill(guide, TEXT, [])
    assert guide.steps[0].criteria[0].provenance.line == 7


def test_provenance_requires_an_anchor() -> None:
    with pytest.raises(ValueError, match="锚点"):
        Provenance(raw_text="哪张图、第几行都不知道")


class _NoopProvider:
    def close(self) -> None:
        return None


def _draft(guide: Guide):
    from types import SimpleNamespace

    return SimpleNamespace(
        guide=guide,
        model="stub",
        usage=SimpleNamespace(
            prompt_tokens=10, completion_tokens=10, reasoning_tokens=0, cached_tokens=0
        ),
        cost_micros=0,
        attempts=1,
        latency_ms=1.0,
        repairs=[],
    )


def test_generation_run_backfills_provenance(env, monkeypatch) -> None:
    """接线验证：`generation.run` 落库前**真的**调了 backfill。

    单测只证明回填本身算得对；这条证明它长在生成链路里。接线漏掉时
    没有任何一条单测会红——只会在线上悄悄少一个字段，谁也不知道。
    """
    import store
    from services import generation

    job_id = store.create_job(kind="generate", client_ip="203.0.113.50", input_text=TEXT)
    monkeypatch.setattr(generation, "generate_guide", lambda *a, **kw: _draft(_guide([_range()])))

    generation.run(job_id, TEXT, provider_factory=lambda: _NoopProvider())

    job = store.get_job(job_id)
    assert job["status"] == "succeeded", job
    row = store.get_guide(job["guide_id"])
    prov = row["guide"]["steps"][0]["criteria"][0]["provenance"]
    assert prov["flag"] == "ok"
    assert prov["line"] == 1
    assert "2.0–3.5s" in prov["raw_text"]


def test_step_provenance_filled_when_action_is_verbatim() -> None:
    """步骤级 provenance：动作描述逐字来自原文时填 `ok`。

    这一层回答的问题与判据级不同——"这一整步是抄的还是编的" vs "这个数值是不是编的"。
    少了它，`step.provenance` 就是一个有定义、没生产者的字段（2026-11-08 之前正是）。
    """
    guide = _guide([_range()])
    backfill(guide, TEXT, [])

    assert guide.steps[0].provenance is not None
    assert guide.steps[0].provenance.flag == "ok"
    assert guide.steps[0].provenance.line == 1
    assert "开关门各 3 次" in guide.steps[0].provenance.raw_text


def test_step_provenance_left_empty_when_action_is_rewritten() -> None:
    """改写过的动作不填——步骤级不做数值回退，宁可空着。

    按数字兜底会指到"另一条也在说 2.0s"的行，人拿着错行核对还以为对上了。
    """
    guide = _guide([_range()])
    guide.steps[0].action = "手动把两扇门各开关三次并计时"
    backfill(guide, TEXT, [])

    assert guide.steps[0].provenance is None


def test_step_provenance_has_no_asset_id_when_multiple_images() -> None:
    """多张图是合并转录的，步骤级同样不许硬指一张。"""
    guide = _guide([_range()])
    backfill(
        guide,
        TEXT,
        [
            AssetRef(asset_id="a_0123456789abcdef", caption="甲图"),
            AssetRef(asset_id="a_fedcba9876543210", caption="乙图"),
        ],
    )

    assert guide.steps[0].provenance is not None
    assert guide.steps[0].provenance.asset_id is None
