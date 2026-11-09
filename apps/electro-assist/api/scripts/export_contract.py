#!/usr/bin/env python3
"""把「前端必须知道的后端枚举」导出成 JSON，供前端测试直接比对。

## 为什么需要它

设备部件键（`leaf_l` / `drive2` …）在后端 `models/visual.py` 定义，前端
`figures/devices/*.ts` 的 `parts` 是另一份手抄表。两边靠人眼对齐的代价已经付过一次：
`pantograph` 白名单里有 `lamp`，前端没登记，模型选 `part=lamp` 时高亮静默失效——
不报错、不提示、点了没反应。

当时补的"一致性用例"其实是**前端硬编码数组**，给后端加一个部件键它照样全绿，
形同虚设（2026-11-10 评审 P2-1，L2 复现）。真正的一致性必须由**后端生成、前端读**。

## 用法

    python scripts/export_contract.py            # 重写 web/src/contract/devices.json
    python scripts/export_contract.py --check    # 只比对（CI 用，漂移即 exit 1）

CI 在 `export_openapi.py --check` 旁边再跑一次 `--check`：改了 `visual.py` 却忘了
重新导出，这条当场红。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(API_DIR))

from models.visual import device_catalog  # noqa: E402

WEB_DIR = API_DIR.parent / "web"
DEFAULT_OUT = WEB_DIR / "src" / "contract" / "devices.json"

HEADER = {
    "_comment": "由 apps/electro-assist/api/scripts/export_contract.py 生成，不要手改。",
    "_source": "apps/electro-assist/api/models/visual.py",
}


def render() -> str:
    """契约文件正文。排序 + 固定缩进：同一份代码重复导出必须逐字节一致。"""
    payload = {
        **HEADER,
        "devices": device_catalog(),
    }
    return json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="导出前后端共享的设备契约")
    parser.add_argument("--check", action="store_true", help="只比对，不写文件")
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    args = parser.parse_args(argv)

    out = Path(args.out)
    fresh = render()
    if args.check:
        if not out.is_file():
            print(f"[FAIL] 契约文件不存在：{out}", file=sys.stderr)
            return 1
        if out.read_text(encoding="utf-8") != fresh:
            print(
                f"[FAIL] {out.name} 与 models/visual.py 不一致，"
                "请运行 python scripts/export_contract.py 重新导出",
                file=sys.stderr,
            )
            return 1
        print(f"[OK] {out} 与后端枚举一致")
        return 0

    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(fresh, encoding="utf-8")
    devices = device_catalog()
    parts = sum(len(info["parts"]) for info in devices.values())
    print(f"写入 {out}：{len(devices)} 台设备 / {parts} 个部件键")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
