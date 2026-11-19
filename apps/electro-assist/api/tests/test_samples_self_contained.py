"""样例 JSON 必须**自包含**：接口会补的键，文件里也得写全。

## 为什么单独一条

`Guide` 的 `disclaimers` / `Step` 的 `safety` / `tools` 在 pydantic 里都有默认值
（`default_factory`），所以：

- 走接口（`GET /guides/{id}`）时，服务端永远补上 → 页面完全正常；
- 但 `render-grader.spec.ts` 是**直接把 `data/samples/*.json` 喂给渲染器**，
  绕过接口默认值 → `GuideView` 的 `guide.disclaimers.join(' · ')` 抛 TypeError，
  整页不渲染，`.pager` 永远等不到。

2026-11-19 就是这样红的：`door_network_check.json` 省了 `disclaimers`，
CI 的 render-grader 一条 10 分钟，本地第一次验证还看不出来（本地走真接口）。

`Guide.model_validate` **抓不到**这类问题——它会给缺的键补默认值，
校验完看着完美。所以这里检查的是**原始 JSON 的键**，不是校验后的模型。

## 判据（只钉 normalize **不补**的那几个键）

`render-grader.spec.ts` 的 `normalize()` 会补 `safety` / `tools` / `figures` 三个键，
所以存量样例缺它们（`door_clearance` / `door_power_selfcheck` 就有）不会崩，
这里**不硬要求**——否则为了洁癖去改存量样例，会白白触发一次 H13 重新确认。

硬要求的是它**不补**的那些：`disclaimers`（`GuideView` 直接 `.join()`）、
每个 step 的 `criteria`（`StepPage` 直接读 `.length`），以及顶层核心键。

将来 `normalize()` 少补了哪个键，就把哪个键挪进 `REQUIRED_STEP_KEYS`——
判据和 normalize 的实现必须对得上，否则这条测试保护的是个假前提。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
SAMPLES = API_DIR / "data" / "samples"

REQUIRED_GUIDE_KEYS = ("id", "title", "summary", "meta", "steps", "disclaimers")
REQUIRED_STEP_KEYS = ("id", "seq", "title", "action", "criteria")

FILES = sorted(SAMPLES.glob("*.json"))


def problems(path: Path) -> list[str]:
    """返回这份样例缺失的键；空列表表示自包含。"""
    data = json.loads(path.read_text(encoding="utf-8"))
    out: list[str] = []

    for key in REQUIRED_GUIDE_KEYS:
        if key not in data:
            out.append(f"缺少顶层键 {key}")
    if "disclaimers" in data and not data["disclaimers"]:
        out.append("disclaimers 是空数组——纸上就没有免责声明了")

    for step in data.get("steps", []):
        sid = step.get("id", "?")
        for key in REQUIRED_STEP_KEYS:
            if key not in step:
                out.append(f"{sid} 缺少键 {key}")
        if "criteria" in step and not isinstance(step["criteria"], list):
            out.append(f"{sid}.criteria 不是数组")
    return out


@pytest.mark.parametrize("path", FILES, ids=[p.stem for p in FILES])
def test_sample_is_self_contained(path: Path):
    missing = problems(path)
    assert not missing, (
        f"{path.name} 不是自包含的，render-grader 会崩：\n  "
        + "\n  ".join(missing)
        + "\n（接口会用 pydantic 默认值补，所以真页面看不出来；样例文件必须写全）"
    )


def test_checker_actually_catches_missing_disclaimers(tmp_path: Path):
    """负例：删掉 disclaimers 必须被这条检查抓到，否则它只是装饰。"""
    src = FILES[0]
    data = json.loads(src.read_text(encoding="utf-8"))
    data.pop("disclaimers", None)
    broken = tmp_path / "broken.json"
    broken.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")

    missing = problems(broken)
    assert any("disclaimers" in m for m in missing), f"负例没被抓到：{missing}"


def test_checker_actually_catches_missing_step_key(tmp_path: Path):
    """负例：删掉某个 step 的 criteria（normalize 不补它）也要被抓到。"""
    src = FILES[0]
    data = json.loads(src.read_text(encoding="utf-8"))
    data["steps"][0].pop("criteria", None)
    broken = tmp_path / "broken.json"
    broken.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")

    missing = problems(broken)
    assert any("criteria" in m for m in missing), f"负例没被抓到：{missing}"
