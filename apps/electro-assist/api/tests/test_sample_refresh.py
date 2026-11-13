"""样例刷新的两道闸门。

## 为什么这组用例存在（2026-11-13 第六轮阶段评审 P1-1）

`refresh_sample_guide` 原来只比 `step_id` 序列：只要 id 还是 `s01…s06`，内容整段
对调也照写。而 `sessions.report()` 的**标题与 seq 取自当前指导书**，记录只存
`step_id`——于是"在 s02 提交的记录"从"上电激活"变成了"MON 屏逐项确认"。
记录本身没变，解读变了；对一份作业记录来说等于伪造。

本阶段就真实发生过一次（`7d79af7` 对调 s02/s03 → `79e91cb` 刷新放行），
只因该样例当时 0 条记录才没有产生错误报告。

## 这组用例钉什么

1. 有记录的步骤，含义变了 → **拒绝**（且报错里点名 step_id）；
2. 整个样例没有任何记录 → **允许**（否则机制被一刀切，样例就没法改了）；
3. 记录只在 s02 时改 s04 → **允许**（只挡被记录引用的那几步，不过度拦截）；
4. 内容没变只是 revision 提高 → **允许**（幂等，不误伤）；
5. 显式 `allow_record_rewrite=True` → 允许，并在返回值里交代改写了多少条。

反向验证（2026-11-13 实测）：把 `recorded and not allow_record_rewrite` 整段
去掉 → 第 1 条红，失败信息为「刷新放行了：记录 s02 原本是『上电激活…』，
现在被解释成『MON 屏逐项确认』」。
"""
from __future__ import annotations

import json
import logging

import pytest

import services.library as library
import services.sessions as sessions
import store

GUIDE_ID = "g_pantograph_raise_test"
SAMPLE = "pantograph_raise_test.json"


@pytest.fixture()
def demo(tmp_path, monkeypatch):
    """临时样例目录 + 临时库：绝不碰仓库里的 `app_data/electro.db`。"""
    src = library.guide_dir()
    guides = tmp_path / "samples"
    guides.mkdir()
    (guides / SAMPLE).write_text(
        (src / SAMPLE).read_text(encoding="utf-8"), encoding="utf-8"
    )
    monkeypatch.setenv("GUIDE_DIR", str(guides))
    monkeypatch.setenv("DB_PATH", str(tmp_path / "electro.db"))
    store.init_db()
    library._seeded_paths.clear()
    library.ensure_seeded()
    return guides


def _values(step: dict) -> dict:
    """按判据类型给一个能过校验的值。"""
    out = {}
    for item in step.get("criteria", []):
        kind = item.get("type")
        if kind == "manual":
            out[item["id"]] = "确认"
        elif kind == "range":
            out[item["id"]] = item.get("min", 0)
        elif kind == "enum":
            options = item.get("options") or []
            out[item["id"]] = options[0] if options else "正常"
        else:
            out[item["id"]] = "正常"
    return out


def _record_on(guide_id: str, seq: int, *, key: str) -> str:
    """从第 1 步一路提交到第 seq 步（顺序闸门要求逐步推进），返回 session_id。"""
    guide = store.get_guide(guide_id)["guide"]
    session_id = sessions.start(guide_id)["session"]["id"]
    for index in range(1, seq + 1):
        sessions.submit(
            session_id,
            index,
            _values(guide["steps"][index - 1]),
            note="",
            idempotency_key=f"{key}-{index}",
        )
    return session_id


def _rewrite(guides, mutate) -> None:
    path = guides / SAMPLE
    data = json.loads(path.read_text(encoding="utf-8"))
    mutate(data)
    data["meta"]["revision"] = data["meta"].get("revision", 0) + 1
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    library._seeded_paths.clear()


def _swap_two_steps(data, first: int, second: int) -> None:
    """只换内容、id 与 seq 原位不动 —— 就是 `7d79af7` 那次改法。"""
    a, b = data["steps"][first], data["steps"][second]
    keep_a = {k: a[k] for k in ("id", "seq") if k in a}
    keep_b = {k: b[k] for k in ("id", "seq") if k in b}
    body_a = {k: v for k, v in a.items() if k not in ("id", "seq")}
    body_b = {k: v for k, v in b.items() if k not in ("id", "seq")}
    data["steps"][first] = {**keep_a, **body_b}
    data["steps"][second] = {**keep_b, **body_a}


def test_rejects_content_change_on_recorded_step(demo, caplog):
    """有记录的步骤含义变了 → 拒绝，且报错点名 step_id 与记录条数。

    注意断言口径：`ensure_seeded()` **会吞掉** `ValueError` 并记 ERROR 日志
    （一份样例刷新失败不该拖垮启动/列表接口），所以这里断的是「一条都没刷」+
    「库里的旧内容原样还在」+「日志说清了原因」，而不是 `pytest.raises`。
    """
    caplog.set_level(logging.ERROR, logger="electro.library")
    _record_on(GUIDE_ID, 2, key="gate-a")
    old_title = store.get_guide(GUIDE_ID)["guide"]["steps"][1]["title"]

    _rewrite(demo, lambda data: _swap_two_steps(data, 1, 2))

    assert library.ensure_seeded() == 0

    # 拒绝之后不允许留下半套更新
    assert store.get_guide(GUIDE_ID)["guide"]["steps"][1]["title"] == old_title
    # 报错要说清是哪一步、有几条记录、以及怎么强制
    assert "s02" in caplog.text
    assert "1 条" in caplog.text
    assert "allow-record-rewrite" in caplog.text


def test_allows_content_change_when_no_records(demo):
    """整个样例没有任何记录 → 照常刷新（否则样例就再也改不动了）。"""
    before = store.get_guide(GUIDE_ID)["guide"]["steps"][1]["title"]
    _rewrite(demo, lambda data: _swap_two_steps(data, 1, 2))

    assert library.ensure_seeded() == 1

    after = store.get_guide(GUIDE_ID)["guide"]["steps"][1]["title"]
    assert after != before


def test_allows_change_on_step_without_records(demo):
    """记录只在 s02：改 s04 不该被拦（只挡被记录引用的那几步）。"""
    _record_on(GUIDE_ID, 2, key="gate-c")

    def rename_s04(data):
        data["steps"][3]["title"] = "选择受电弓单元（改名不拦截）"

    _rewrite(demo, rename_s04)

    assert library.ensure_seeded() == 1
    assert store.get_guide(GUIDE_ID)["guide"]["steps"][3]["title"].endswith("（改名不拦截）")


def test_allows_identical_content_with_higher_revision(demo):
    """内容没变、只是 revision 提高 → 幂等写入，不误伤。"""
    _record_on(GUIDE_ID, 2, key="gate-d")
    _rewrite(demo, lambda data: None)

    assert library.ensure_seeded() == 1


def test_force_flag_rewrites_records_and_reports_count(demo):
    """显式强制：允许改写历史解读，但必须交代改了多少条。"""
    for index in range(1, 4):
        _record_on(GUIDE_ID, 2, key=f"gate-e{index}")
    _rewrite(demo, lambda data: _swap_two_steps(data, 1, 2))

    guide = next(item for item in library.load_fixtures(demo) if item.id == GUIDE_ID)
    result = store.refresh_sample_guide(guide, allow_record_rewrite=True)

    assert result["rewrote_records"] is True
    assert result["records_affected"] == 3


def test_warns_when_file_changed_but_revision_not_bumped(demo, caplog):
    """文件变了、revision 没提 → 不刷新，但要在启动日志里说一句（R20-6）。

    2026-11-13 线上就是这么发现 `g_door_clearance_001` 差一个参数的：机制**正确地**
    没刷新，却没有任何声音，只能靠人想起来跑一次 dry-run。
    """
    caplog.set_level(logging.WARNING, logger="electro.library")
    path = demo / SAMPLE
    data = json.loads(path.read_text(encoding="utf-8"))
    data["steps"][3]["title"] = "改过的标题"
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")  # 不提 revision
    library._seeded_paths.clear()

    assert library.ensure_seeded() == 0

    assert "没提高" in caplog.text
    assert GUIDE_ID in caplog.text
    # 线上内容一个字没动
    assert store.get_guide(GUIDE_ID)["guide"]["steps"][3]["title"] != "改过的标题"
