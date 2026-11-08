"""判据单位：归一化与符号表校验（计划 §12.8）。

守三件事：

1. **只改写法，不改数值**：`毫米` → `mm`，但 2 cm 绝不变成 20 mm；
2. **表外符号直接拒**：`千克` 这种歧义单位不许落库——现场照错的单位读数，
   比"生成失败请重试"严重得多；
3. **它真的长在生成链路里**：单测只能证明 `normalize_guide` 算得对，
   接线漏掉时没有任何用例会红，只会在线上悄悄少一层校验。

反向验证：把 `check()` 里的成员判断去掉（任何写法都放行）→
`test_unknown_unit_fails_the_whole_generation` 立刻红。
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest

import store
from core.units import UnitError, check, normalize, normalize_guide
from models.guide import Guide
from services import generation
from services.jobqueue import job_queue

TEXT = "工序：开关门试验。测量开门时间，记录间隙。"


@pytest.fixture()
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "electro.db"))
    store.init_db()
    job_queue.reset()
    yield
    job_queue.reset()


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("毫米", "mm"),
        ("厘米", "cm"),
        ("秒", "s"),
        ("分钟", "min"),
        ("摄氏度", "°C"),
        ("℃", "°C"),          # NFKC 之后与上一行同形
        ("兆帕", "MPa"),
        ("牛顿米", "N·m"),
        ("牛·米", "N·m"),
        ("ｍｍ", "mm"),        # 全角
        (" MM ", "mm"),        # 大小写 + 空白
        ("m / s", "m/s"),
        ("m/s", "m/s"),        # 已在表内，原样返回
    ],
)
def test_normalize_maps_aliases_to_canonical(raw: str, expected: str) -> None:
    assert normalize(raw) == expected


def test_normalize_does_not_convert_values() -> None:
    """归一化只碰单位字符串本身——它拿不到数值，也不该拿到。"""
    assert normalize("2厘米") == "2厘米"  # 带数值的整串不是单位，不猜


def test_unknown_unit_raises_with_symbol_table() -> None:
    with pytest.raises(UnitError) as exc:
        check("千克")
    message = str(exc.value)
    assert "千克" in message
    # 报错必须带可用符号，否则用户只知道错了、不知道能写什么
    assert "mm" in message and "MPa" in message


def test_empty_unit_is_left_to_required_check() -> None:
    """空串不该在这里报错：range 判据漏单位由 `Criterion` 自己拒。"""
    assert check("") == ""


def _guide(unit: str) -> Guide:
    return Guide(
        id="g_unit_test_0001",
        title="开关门功能试验",
        summary="用于单位校验测试的指导书摘要（虚构演示数据）",
        meta={"system": "door", "source_note": "公开资料改写（演示）", "model": "stub"},
        steps=[
            {
                "id": "s01",
                "seq": 1,
                "title": "开关门",
                "action": "开关门各 3 次",
                "criteria": [
                    {"id": "c_time", "label": "开门时间", "type": "range", "unit": unit, "min": 2.0, "max": 3.5}
                ],
            }
        ],
    )


def test_normalize_guide_rewrites_and_counts() -> None:
    guide = _guide("毫米")
    stats = normalize_guide(guide)

    assert guide.steps[0].criteria[0].unit == "mm"
    assert stats == {"changed": 1, "checked": 1}

    # 幂等：已经是规范符号时不再算 changed
    assert normalize_guide(guide) == {"changed": 0, "checked": 1}


class _NoopProvider:
    def close(self) -> None:
        return None


def _draft(guide: Guide):
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


def test_generation_normalizes_unit_before_saving(env, monkeypatch) -> None:
    """接线验证：落库前单位已折成规范符号。"""
    job_id = store.create_job(kind="generate", client_ip="203.0.113.51", input_text=TEXT)
    monkeypatch.setattr(generation, "generate_guide", lambda *a, **kw: _draft(_guide("毫米")))

    generation.run(job_id, TEXT, provider_factory=lambda: _NoopProvider())

    job = store.get_job(job_id)
    assert job["status"] == "succeeded", job
    row = store.get_guide(job["guide_id"])
    assert row["guide"]["steps"][0]["criteria"][0]["unit"] == "mm"


def test_unknown_unit_fails_the_whole_generation(env, monkeypatch) -> None:
    """表外单位 → 整次生成失败，且错误码是 validation（不是 internal）。

    为什么不"放行 + 记一条 note"：单位错了，指导书上的数值解读就是错的，
    而页面不会把 note 显示在读数旁边。宁可让人重试一次。
    """
    job_id = store.create_job(kind="generate", client_ip="203.0.113.52", input_text=TEXT)
    monkeypatch.setattr(generation, "generate_guide", lambda *a, **kw: _draft(_guide("千克")))

    generation.run(job_id, TEXT, provider_factory=lambda: _NoopProvider())

    job = store.get_job(job_id)
    assert job["status"] == "failed"
    assert job["error_code"] == "validation"
    # 失败任务不落指导书
    assert store.get_guide("g_unit_test_0001") is None
