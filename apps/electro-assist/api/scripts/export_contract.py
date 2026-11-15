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

from models.visual import (  # noqa: E402
    VisualSpec,
    allowed_params,
    device_catalog,
    interactive_scenes,
)

WEB_DIR = API_DIR.parent / "web"
DEFAULT_OUT = WEB_DIR / "src" / "contract" / "devices.json"
# 原语契约（R24-7）：demo + 可断言的期望，**手写在 data/ 里**，导出给前端测试读。
PRIM_DIR = API_DIR / "data" / "contract" / "primitives"
PRIM_OUT = WEB_DIR / "src" / "contract" / "primitives.json"

# 只强制这 5 个高风险原语有 demo。为什么不是全部 17 个：给其余 12 个现在写期望，
# 等于把"我以为它该怎样"写成合同，而它们至今没出过事。等真出事再加（R24-7 的降级决定）。
REQUIRED_PRIMITIVES = {"device_scene", "mon_panel", "operation_scene", "meter", "table"}
EXPECTATION_KINDS = {"text", "absent", "node"}

HEADER = {
    "_comment": "由 apps/electro-assist/api/scripts/export_contract.py 生成，不要手改。",
    "_source": "apps/electro-assist/api/models/visual.py",
}


def render() -> str:
    """契约文件正文。排序 + 固定缩进：同一份代码重复导出必须逐字节一致。"""
    payload = {
        **HEADER,
        "devices": device_catalog(),
        # 交互原语的场景口径（ops_acts / ops_views / mon_tabs / mon_modes）：
        # 前端靠它机检自己的按步裁剪表，别把这份删了（见 `interactive_scenes()`）。
        "scenes": interactive_scenes(),
    }
    return json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n"


def render_primitives() -> str:
    """原语契约文件正文。**先校验再导出**，坏 demo 直接让 CI 红。"""
    payload = {
        **HEADER,
        "_source": "apps/electro-assist/api/data/contract/primitives/*.json（demo 经 VisualSpec 校验）",
        "primitives": load_primitives(),
    }
    return json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n"


def load_primitives() -> dict[str, dict]:
    """读 `data/contract/primitives/*.json`，逐个校验。**缺一个必需原语就退出**。"""
    out: dict[str, dict] = {}
    if PRIM_DIR.is_dir():
        for path in sorted(PRIM_DIR.glob("*.json")):
            data = json.loads(path.read_text(encoding="utf-8"))
            name = str(data.get("primitive") or path.stem)
            if name != path.stem:
                raise SystemExit(f"[FAIL] {path.name} 里的 primitive 是 {name!r}，与文件名不一致")
            demo = data.get("demo")
            if not isinstance(demo, dict):
                raise SystemExit(f"[FAIL] {path.name} 缺 demo")
            # 用生产同款校验：参数键、必填项、枚举值都对不上就红——这才是"可运行的样例"
            spec = VisualSpec.model_validate(demo)
            spec.validate_against_primitive()

            expectations = data.get("expectations")
            if not isinstance(expectations, list) or len(expectations) < 1:
                raise SystemExit(f"[FAIL] {path.name} 至少要有一条期望")
            kinds = {item.get("kind") if isinstance(item, dict) else None for item in expectations}
            # 至少一条"能看出画了东西"的断言：只有 absent 那种"没出现"的期望，
            # 组件渲染成空白也能全绿。
            if not kinds & {"text", "node"}:
                raise SystemExit(f"[FAIL] {path.name} 至少要有一条 text 或 node 期望")
            for item in expectations:
                kind = item.get("kind") if isinstance(item, dict) else None
                if kind not in EXPECTATION_KINDS:
                    raise SystemExit(
                        f"[FAIL] {path.name} 的期望类型 {kind!r} 不认识（只认 {sorted(EXPECTATION_KINDS)}）"
                    )
                if kind in {"text", "absent"} and not str(item.get("value", "")).strip():
                    raise SystemExit(f"[FAIL] {path.name} 有一条 {kind} 期望没写 value")
            out[name] = {"demo": demo, "expectations": expectations}

    missing = REQUIRED_PRIMITIVES - out.keys()
    if missing:
        raise SystemExit(
            f"[FAIL] 这些原语没有 demo：{sorted(missing)} —— "
            f"新增或改名原语时，{PRIM_DIR} 里要补一份"
        )
    unknown = out.keys() - allowed_params().keys()
    if unknown:
        raise SystemExit(f"[FAIL] 这些 demo 的 primitive 不在枚举里：{sorted(unknown)}")
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="导出前后端共享的设备与原语契约")
    parser.add_argument("--check", action="store_true", help="只比对，不写文件")
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    args = parser.parse_args(argv)

    out = Path(args.out)
    prim_out = PRIM_OUT
    fresh = render()
    # 先跑一遍校验：即使设备契约没变，原语 demo 坏了也必须红
    prim_fresh = render_primitives()

    if args.check:
        for path, body in ((out, fresh), (prim_out, prim_fresh)):
            if not path.is_file():
                print(f"[FAIL] 契约文件不存在：{path}", file=sys.stderr)
                return 1
            if path.read_text(encoding="utf-8") != body:
                print(
                    f"[FAIL] {path.name} 与后端枚举不一致，"
                    "请运行 python scripts/export_contract.py 重新导出",
                    file=sys.stderr,
                )
                return 1
        print(f"[OK] {out.name} / {prim_out.name} 与后端枚举一致")
        return 0

    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(fresh, encoding="utf-8")
    prim_out.parent.mkdir(parents=True, exist_ok=True)
    prim_out.write_text(prim_fresh, encoding="utf-8")
    devices = device_catalog()
    parts = sum(len(info["parts"]) for info in devices.values())
    primitives = json.loads(prim_fresh)["primitives"]
    print(f"写入 {out}：{len(devices)} 台设备 / {parts} 个部件键")
    print(f"写入 {prim_out}：{len(primitives)} 个原语契约（{', '.join(sorted(primitives))}）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
