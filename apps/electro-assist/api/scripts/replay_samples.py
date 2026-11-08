#!/usr/bin/env python3
"""把「存量数据」逐份过一遍模型校验（发布前检查 / 待办 R5-5）。

**为什么需要它**：2026-11-08 删 `Provenance.confidence` 时只改了模型，
库里 5 份已发布指导书当场解析失败（`extra="forbid"`）。而 `GET /guides/{id}`
返回的是原始 JSON，第一眼看不出异常——**A1 开始、编辑、发布**三条路径才会 500。
当时的回归用例钉的是 `confidence` 这个**键名**；下次删别的字段，它不会红。

这个脚本把「读得懂旧数据」变成一条可复跑的检查：

1. 冻结样本：`tests/fixtures/legacy/` 里每份 JSON 都是**历史上真的写出去过的形状**；
2. 逐份 `Guide.model_validate` —— 删字段、改类型、加约束，都会在这里炸；
3. 再 `model_dump` 后二次校验，并断言废弃键不再写出（"读旧写新"）；
4. 任何一份失败 → 退出码 1，CI 阻断。

**删字段的规矩**（也写在 `docs/DEVELOPMENT.md`）：先把一份含该字段的真实 JSON
冻进 `tests/fixtures/legacy/`，再改模型。否则这道门禁保护不到新删的键——
它只能证明"已知的历史形状还读得懂"，不能预知未来。

用法：

    python scripts/replay_samples.py                       # 跑冻结样本
    python scripts/replay_samples.py --dir /path/to/dump    # 跑一份新的线上脱敏导出

新增样本时只加文件、不改脚本；文件名带日期，便于知道它是哪个形状。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(API_DIR))

FIXTURES = API_DIR / "tests" / "fixtures" / "legacy"

# 已废弃、但存量数据里可能出现的键：读得进，不许再写出去。
DEPRECATED_KEYS = ("confidence",)


def replay(path: Path) -> tuple[bool, str]:
    """校验一份存量 JSON；返回 (是否通过, 说明)。"""
    from models.guide import Guide  # noqa: PLC0415 - 延迟导入，--help 时不建 app

    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        return False, f"JSON 读不出来：{exc}"

    try:
        guide = Guide.model_validate(data)
    except Exception as exc:  # noqa: BLE001 - 校验失败的具体类型不重要，信息在 str 里
        return False, f"model_validate 失败：{exc}"

    dumped = guide.model_dump(mode="json")
    try:
        Guide.model_validate(dumped)
    except Exception as exc:  # noqa: BLE001
        return False, f"回写后再读失败（写出去的格式自己读不回）：{exc}"

    raw_out = json.dumps(dumped, ensure_ascii=False)
    leaked = [k for k in DEPRECATED_KEYS if f'"{k}"' in raw_out]
    if leaked:
        return False, f"废弃键又被写出去了：{leaked}（应 exclude=True）"

    return True, "ok"


def replay_dir(directory: Path) -> list[tuple[Path, bool, str]]:
    return [(p, *replay(p)) for p in sorted(directory.glob("*.json"))]


def main() -> int:
    parser = argparse.ArgumentParser(description="存量 JSON 回放校验")
    parser.add_argument("--dir", default=str(FIXTURES), help="样本目录（默认冻结样本）")
    args = parser.parse_args()

    directory = Path(args.dir)
    if not directory.is_dir():
        print(f"[FAIL] 目录不存在：{directory}")
        return 2

    results = replay_dir(directory)
    if not results:
        print(f"[FAIL] {directory} 里没有 .json 样本——这道检查现在等于没开")
        return 2

    failed = 0
    for path, ok, message in results:
        if ok:
            print(f"[OK  ] {path.name}")
        else:
            failed += 1
            print(f"[FAIL] {path.name} —— {message}")

    print(f"\n{len(results) - failed}/{len(results)} 份存量样本通过（目录：{directory}）")
    if failed:
        print("补法：字段不要删，改成「保留 + exclude=True」读旧写新；或先做数据迁移再删。")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
