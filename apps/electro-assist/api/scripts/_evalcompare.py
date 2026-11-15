"""生成评测的对照计算（R24-5）。**纯函数，不调模型。**

## 为什么单独成文件

对照组的价值全在"算得对、口径写死"。把汇总与比较放进 `eval_generate.py` 里，
就只能靠真调模型来测它——一次 ¥0.1、九十秒，改一个百分比格式要等半天。
抽出来之后，两份固定的 JSON 就能把每个口径钉住（`tests/test_eval_compare.py`）。

## 口径（与上游 `modern-web-guidance` 的仪表盘对齐）

1. **n 必须和通过率一起出现**。8 份语料跑 2 遍就是 n=16；只写"通过率 87.5%"而不写
   n=16，等于让人以为精度是 0.1%。
2. **提升用百分点（pp），不用百分比**。40% → 50% 是 **+10 pp**，不是 +25%。
3. **小于一份语料的变化叫"无法分辨"**。n=16 时一份 = 6.25 pp，实际差异 2 pp
   可能只是抽签 —— 这种时候说"略好"就是自欺。
4. 成本与 token 报**绝对值 + 相对变化**，因为成本翻倍和通过率涨 6 pp 是两件事。
"""
from __future__ import annotations

import json
import statistics
from pathlib import Path
from typing import Any, Iterable

SCHEMA = 1


def load_run(path: str | Path) -> dict[str, Any]:
    """读一份评测结果。缺字段直接抛，不做"尽量理解"——口径错了比没数据更糟。"""
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(data, dict) or "results" not in data:
        raise ValueError(f"{path} 不是评测结果（缺 results）")
    if data.get("schema") != SCHEMA:
        raise ValueError(f"{path} 的 schema={data.get('schema')}，期望 {SCHEMA}")
    return data


def _rows(data: dict[str, Any]) -> list[dict[str, Any]]:
    rows = data.get("results")
    if not isinstance(rows, list):
        raise ValueError("results 必须是列表")
    return rows


def summarize(data: dict[str, Any]) -> dict[str, Any]:
    """把一份结果压成可比较的指标。n = 运行次数（语料数 × repeat）。"""
    rows = _rows(data)
    n = len(rows)
    if n == 0:
        raise ValueError("results 为空，无法汇总")

    ok = [r for r in rows if r.get("status") == "ok"]
    first_pass = [r for r in ok if int(r.get("attempts", 1)) == 1]
    walls = [float(r.get("wall_ms", 0)) / 1000 for r in ok]
    costs = [int(r.get("cost_micros", 0)) for r in rows]
    prompt_tokens = sum(int(r.get("prompt_tokens", 0)) for r in rows)

    return {
        "variant": data.get("variant", "?"),
        "at": data.get("at", "?"),
        "model": data.get("model", "?"),
        "prompt_sha": data.get("prompt_sha", "?"),
        "prompt_chars": int(data.get("prompt_chars", 0)),
        "n": n,
        "ok": len(ok),
        "first_pass": len(first_pass),
        "ok_rate": len(ok) / n,
        "first_pass_rate": len(first_pass) / n,
        # 每种失败类型各几条 —— 只看总通过率，会漏掉"换个失败法"这种退步
        "failures": _failure_counts(rows),
        "attempts": round(sum(int(r.get("attempts", 1)) for r in ok) / len(ok), 2) if ok else 0.0,
        "repairs": sum(max(0, int(r.get("attempts", 1)) - 1) for r in ok),
        "prompt_tokens": prompt_tokens,
        "avg_prompt_tokens": round(prompt_tokens / n),
        "completion_tokens": sum(int(r.get("completion_tokens", 0)) for r in rows),
        "cost_micros": sum(costs),
        "p50_wall_s": round(statistics.median(walls), 1) if walls else 0.0,
        "steps": sum(int(r.get("steps", 0)) for r in ok),
        "figures": sum(int(r.get("figures", 0)) for r in ok),
    }


def _failure_counts(rows: Iterable[dict[str, Any]]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for r in rows:
        status = str(r.get("status", "?"))
        if status == "ok":
            continue
        counts[status] = counts.get(status, 0) + 1
    return counts


def smallest_resolvable_pp(n: int) -> float:
    """n 次运行里，"一份语料"值多少个百分点。差异小于它就叫无法分辨。"""
    if n <= 0:
        return 0.0
    return 100.0 / n


def _pp(value: float) -> str:
    return f"{value * 100:.1f}%"


def _delta_pp(a: float, b: float) -> str:
    return f"{'+' if b - a >= 0 else '−'}{abs(b - a) * 100:.1f} pp"


def _delta_abs(a: float, b: float, unit: str = "") -> str:
    diff = b - a
    sign = "+" if diff >= 0 else "−"
    return f"{sign}{abs(diff):,.1f}{unit}"


def _delta_pct(a: float, b: float) -> str:
    if a == 0:
        return "—" if b == 0 else "新增"
    diff = (b - a) / a * 100
    sign = "+" if diff >= 0 else "−"
    return f"{sign}{abs(diff):.1f}%"


def verdict(a: dict[str, Any], b: dict[str, Any]) -> str:
    """一句话结论。**三档，不给"略好/略差"。**

    差一份语料就叫"更好"，是拿 n=4 的样本说 n=400 的话——这正是对照组最容易骗人的地方。
    """
    n = min(a["n"], b["n"])
    floor = smallest_resolvable_pp(n)
    gap = (b["first_pass_rate"] - a["first_pass_rate"]) * 100
    if abs(gap) < floor:
        return f"无法分辨：差 {_signed(gap)}，小于一份语料（{floor:.1f} pp）"
    if abs(gap) < 2 * floor:
        return (
            f"证据很弱：差 {_signed(gap)} 约等于一份语料（{floor:.1f} pp），"
            f"n={n} 太小，别据此定论"
        )
    direction = "更好" if gap > 0 else "更差"
    return f"{direction}：一次通过率 {_signed(gap)}（n={n}，一份语料 {floor:.1f} pp）"


def _signed(pp: float) -> str:
    """带符号的百分点。负号统一用 U+2212，与对照表里保持一致（别一个 ASCII 一个 U+2212）。"""
    return f"{'+' if pp >= 0 else '−'}{abs(pp):.1f} pp"


def compare_markdown(a_data: dict[str, Any], b_data: dict[str, Any]) -> str:
    """两份结果的对照表。A = 对照（旧提示词），B = 处理（新提示词）。"""
    a = summarize(a_data)
    b = summarize(b_data)

    lines = [
        f"# 提示词对照：{a['variant']} → {b['variant']}",
        "",
        f"> A `{a['variant']}`：提示词 {a['prompt_chars']} 字符 / sha `{a['prompt_sha']}` / n={a['n']}",
        f"> B `{b['variant']}`：提示词 {b['prompt_chars']} 字符 / sha `{b['prompt_sha']}` / n={b['n']}",
        f"> 判定门槛：一份语料 = **{smallest_resolvable_pp(min(a['n'], b['n'])):.1f} pp**，小于它的差异视为无法分辨",
        "",
        "| 指标 | A（对照） | B（处理） | 变化 |",
        "|---|---|---|---|",
        f"| 一次通过率 | {_pp(a['first_pass_rate'])}（{a['first_pass']}/{a['n']}） | "
        f"{_pp(b['first_pass_rate'])}（{b['first_pass']}/{b['n']}） | "
        f"**{_delta_pp(a['first_pass_rate'], b['first_pass_rate'])}** |",
        f"| 最终成功率 | {_pp(a['ok_rate'])} | {_pp(b['ok_rate'])} | "
        f"{_delta_pp(a['ok_rate'], b['ok_rate'])} |",
        f"| 平均尝试次数 | {a['attempts']} | {b['attempts']} | "
        f"{_delta_abs(a['attempts'], b['attempts'])} |",
        f"| 自纠次数 | {a['repairs']} | {b['repairs']} | "
        f"{_delta_abs(a['repairs'], b['repairs'], ' 次')} |",
        f"| 平均输入 token | {a['avg_prompt_tokens']:,} | {b['avg_prompt_tokens']:,} | "
        f"{_delta_pct(a['avg_prompt_tokens'], b['avg_prompt_tokens'])} |",
        f"| 总成本 | ¥{a['cost_micros'] / 1e6:.4f} | ¥{b['cost_micros'] / 1e6:.4f} | "
        f"{_delta_pct(a['cost_micros'], b['cost_micros'])} |",
        f"| 耗时 P50 | {a['p50_wall_s']}s | {b['p50_wall_s']}s | "
        f"{_delta_abs(a['p50_wall_s'], b['p50_wall_s'], 's')} |",
        f"| 步数合计 | {a['steps']} | {b['steps']} | {_delta_abs(a['steps'], b['steps'])} |",
        f"| 图数合计 | {a['figures']} | {b['figures']} | {_delta_abs(a['figures'], b['figures'])} |",
        "",
        f"**结论**：{verdict(a, b)}",
    ]

    if a["failures"] or b["failures"]:
        lines += ["", "## 失败分布（只看总通过率，会漏掉「换个失败法」这种退步）", ""]
        kinds = sorted(set(a["failures"]) | set(b["failures"]))
        lines += ["| 失败类型 | A | B |", "|---|---|---|"]
        for kind in kinds:
            lines.append(f"| `{kind}` | {a['failures'].get(kind, 0)} | {b['failures'].get(kind, 0)} |")

    return "\n".join(lines) + "\n"
