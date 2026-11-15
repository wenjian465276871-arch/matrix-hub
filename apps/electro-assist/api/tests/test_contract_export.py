"""前后端设备契约：`web/src/contract/devices.json` 必须与后端枚举逐字节一致。

## 为什么这条要放进 pytest，而不是只放 CI

CI 里已经有一条 `export_contract.py --check`，但那只在推送时拦。放进 pytest 后，
**本地改完 `models/visual.py` 忘记重新导出**也会红——比等到推送才发现便宜一轮。

与 `export_openapi.py --check` 同一个思路：契约由代码生成，人只负责重跑。

背景（2026-11-10 评审 P2-1）：上一版"一致性"用例是前端硬编码数组，
给后端加一个部件键它照样全绿；`pantograph.lamp` 就是这么漏掉的（高亮静默失效）。
"""
from __future__ import annotations

from scripts.export_contract import DEFAULT_OUT, render


def test_contract_file_is_up_to_date():
    assert DEFAULT_OUT.is_file(), f"契约文件不存在：{DEFAULT_OUT}"
    actual = DEFAULT_OUT.read_text(encoding="utf-8")
    assert actual == render(), (
        "契约文件与 models/visual.py 不一致；在 api/ 下运行 "
        "`python scripts/export_contract.py` 重新导出"
    )


def test_contract_covers_every_device():
    from models.visual import DEVICE_SUBJECTS

    payload = render()
    for name in DEVICE_SUBJECTS:
        # 只做存在性断言：具体内容由 devices.json 与 device_catalog() 的逐字节比对保证。
        assert f'"{name}"' in payload, f"契约里缺少设备 {name}"


# ---------------------------------------------------------------- 原语契约（R24-7）
def test_primitives_contract_up_to_date():
    from scripts.export_contract import PRIM_OUT, render_primitives

    assert PRIM_OUT.is_file(), f"原语契约定文件不存在：{PRIM_OUT}"
    assert PRIM_OUT.read_text(encoding="utf-8") == render_primitives(), (
        "原语契约与 data/contract/primitives 不一致；在 api/ 下运行 "
        "`python scripts/export_contract.py` 重新导出"
    )


def test_primitives_contract_covers_required():
    import json

    from scripts.export_contract import PRIM_OUT, REQUIRED_PRIMITIVES, render_primitives

    exported = set(json.loads(render_primitives())["primitives"])
    missing = REQUIRED_PRIMITIVES - exported
    assert not missing, f"这些高风险原语没有 demo：{sorted(missing)}"
    assert PRIM_OUT.is_file()


def test_missing_demo_fails_loudly(tmp_path, monkeypatch):
    """删掉一份 demo，导出必须**退出**而不是静默少一项。"""
    import shutil

    from scripts import export_contract

    source = export_contract.PRIM_DIR
    for path in source.glob("*.json"):
        shutil.copy(path, tmp_path / path.name)
    (tmp_path / "table.json").unlink()
    monkeypatch.setattr(export_contract, "PRIM_DIR", tmp_path)

    try:
        export_contract.load_primitives()
    except SystemExit as exc:  # noqa: PERF203 —— 这里就是要它抛
        assert "table" in str(exc)
    else:  # pragma: no cover - 走不到说明门禁失效
        raise AssertionError("缺 demo 时没有退出，门禁形同虚设")
