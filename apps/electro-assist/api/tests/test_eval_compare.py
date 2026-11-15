"""提示词对照的计算口径（R24-5）。

**不调模型**：两份固定的 JSON 就能把每个口径钉住——
- n 必须与通过率同时出现；
- 提升用百分点（pp），不是百分比；
- 小于一份语料的差异叫"无法分辨"，不许说"略好"；
- 失败分布要单独列，因为"换个失败法"也是退步。
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from scripts._evalcompare import (
    compare_markdown,
    load_run,
    smallest_resolvable_pp,
    summarize,
    verdict,
)


def run_data(variant: str, rows: list[dict], **extra) -> dict:
    return {
        "schema": 1,
        "variant": variant,
        "at": "2026-11-15 16:00",
        "model": "deepseek-flash",
        "prompt_sha": "abc123def456",
        "prompt_chars": 8000,
        "results": rows,
        **extra,
    }


def row(name: str, attempts: int = 1, status: str = "ok", **kw) -> dict:
    base = {
        "name": name,
        "run": 1,
        "status": status,
        "attempts": attempts,
        "wall_ms": 9000,
        "prompt_tokens": 7000,
        "completion_tokens": 1500,
        "cost_micros": 9000,
        "steps": 6,
        "figures": 3,
    }
    base.update(kw)
    return base


class TestSummarize:
    def test_n_is_runs_not_cases(self) -> None:
        # 同一份语料跑两遍 = 2 次运行，n 必须按运行算，否则通过率精度是假的
        rows = [row("a"), row("a", run=2)]
        s = summarize(run_data("t", rows))
        assert s["n"] == 2
        assert s["first_pass"] == 2

    def test_first_pass_requires_attempt_one(self) -> None:
        rows = [row("a"), row("b", attempts=2), row("c", attempts=2), row("d")]
        s = summarize(run_data("t", rows))
        assert s["first_pass"] == 2
        assert s["first_pass_rate"] == pytest.approx(0.5)
        assert s["repairs"] == 2

    def test_failures_counted_by_kind_and_excluded_from_rates(self) -> None:
        rows = [
            row("a"),
            row("b", status="error:validation", attempts=2),
            row("c", status="error:truncated", attempts=1),
            row("d", status="input_error", attempts=0),
        ]
        s = summarize(run_data("t", rows))
        assert s["ok"] == 1
        assert s["first_pass_rate"] == pytest.approx(0.25)
        assert s["failures"] == {"error:validation": 1, "error:truncated": 1, "input_error": 1}

    def test_tokens_and_cost_sum_over_all_runs(self) -> None:
        rows = [row("a", prompt_tokens=1000, cost_micros=500), row("b", prompt_tokens=3000, cost_micros=1500)]
        s = summarize(run_data("t", rows))
        assert s["prompt_tokens"] == 4000
        assert s["avg_prompt_tokens"] == 2000
        assert s["cost_micros"] == 2000

    def test_empty_results_is_an_error(self) -> None:
        with pytest.raises(ValueError):
            summarize(run_data("t", []))


class TestVerdicts:
    def test_one_case_gap_is_weak_not_conclusive(self) -> None:
        # n=16 → 一份 6.25pp；只差一份语料叫"证据很弱"，不叫"更好"
        a = summarize(run_data("a", [row(str(i)) for i in range(16)]))
        b_rows = [row(str(i)) for i in range(16)]
        b_rows[0]["attempts"] = 2
        b = summarize(run_data("b", b_rows))
        assert smallest_resolvable_pp(16) == pytest.approx(6.25)
        assert "证据很弱" in verdict(a, b)

    def test_two_case_gap_is_conclusive(self) -> None:
        a = summarize(run_data("a", [row(str(i)) for i in range(8)]))
        b_rows = [row(str(i)) for i in range(8)]
        b_rows[0]["attempts"] = 2
        b_rows[1]["attempts"] = 2  # 25pp = 两份语料
        b = summarize(run_data("b", b_rows))
        assert "更差" in verdict(a, b)

    def test_costs_and_tokens_are_separate_from_pass_rate(self) -> None:
        a = summarize(run_data("a", [row("x", prompt_tokens=7000, cost_micros=9000)]))
        b = summarize(
            run_data("b", [row("x", attempts=2, prompt_tokens=9000, cost_micros=13000)])
        )
        assert a["avg_prompt_tokens"] == 7000 and b["avg_prompt_tokens"] == 9000
        assert b["cost_micros"] > a["cost_micros"]

    def test_zero_gap_is_unresolvable(self) -> None:
        rows = [row(str(i)) for i in range(8)]
        a = summarize(run_data("a", rows))
        b = summarize(run_data("b", [dict(r) for r in rows]))
        assert "无法分辨" in verdict(a, b)


class TestCompareMarkdown:
    def test_reports_pp_and_n_together(self) -> None:
        a = run_data("baseline", [row(str(i)) for i in range(4)])
        b_rows = [row(str(i)) for i in range(4)]
        b_rows[0]["attempts"] = 2
        b = run_data("treat", b_rows)
        md = compare_markdown(a, b)

        assert "baseline → treat" in md
        # 百分点而不是百分比
        assert "−25.0 pp" in md
        assert "pp" in md
        # n 与通过率同现：A 全过 4/4，B 有一条自纠过 3/4
        assert "4/4" in md
        assert "3/4" in md
        # 判定门槛显式写出
        assert "25.0 pp" in md
        assert "结论" in md

    def test_failure_breakdown_shows_new_failure_kind(self) -> None:
        a = run_data("a", [row("x"), row("y")])
        b = run_data("b", [row("x"), row("y", status="error:validation", attempts=2)])
        md = compare_markdown(a, b)
        assert "失败分布" in md
        assert "error:validation" in md


class TestLoadRun:
    def test_roundtrip(self, tmp_path: Path) -> None:
        data = run_data("t", [row("a")])
        path = tmp_path / "r.json"
        path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        assert load_run(path)["variant"] == "t"

    def test_rejects_wrong_schema(self, tmp_path: Path) -> None:
        path = tmp_path / "r.json"
        path.write_text(json.dumps({"schema": 99, "results": []}), encoding="utf-8")
        with pytest.raises(ValueError, match="schema"):
            load_run(path)

    def test_rejects_missing_results(self, tmp_path: Path) -> None:
        path = tmp_path / "r.json"
        path.write_text(json.dumps({"schema": 1}), encoding="utf-8")
        with pytest.raises(ValueError, match="results"):
            load_run(path)
