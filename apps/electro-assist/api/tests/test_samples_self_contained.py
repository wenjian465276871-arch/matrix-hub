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

## 判据

每份样例必须显式写出：`disclaimers`（非空）、每个 step 的 `safety` / `tools` /
`criteria` / `figures`（可以是空数组，但键要在），以及顶层核心键。

**为什么连 `safety`/`tools` 也硬要求**（2026-11-19 扩）：`render-grader` 的
`normalize()` 会补这三个键，所以缺了不会崩——但"靠渲染器兜底"意味着**样例文件
本身不是完整数据**，任何人拿它去别处用（新加一个消费方、写个离线预览）都要重新
踩一遍。存量两份（`door_clearance` / `door_power_selfcheck`）的 4 处缺口已在本日补齐，
只加了 `[]`、没动一个字，指纹按 §4.39 重新记录。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
SAMPLES = API_DIR / "data" / "samples"

REQUIRED_GUIDE_KEYS = ("id", "title", "summary", "meta", "steps", "disclaimers")
REQUIRED_STEP_KEYS = ("id", "seq", "title", "action", "safety", "tools", "criteria", "figures")

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
