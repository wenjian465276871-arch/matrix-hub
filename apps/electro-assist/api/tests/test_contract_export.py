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
