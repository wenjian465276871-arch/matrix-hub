"""批量生成评测：量一次通过率与延迟分布。

为什么要有这个脚本，而不是"跑一份看看差不多就行"：
生成是**概率性**的。单次成功说明不了任何问题；五份不同子系统的文本各跑一次，
才能看出"模型是不是只会写车门"。一次通过率低于 80% 就不该接 API 给访客用——
访客不会重试，只会关掉页面。

用法：
    python scripts/eval_generate.py --env-file /path/to/.env \
        --out-dir eval-results --report eval-results/report.md
    （`--env-file` 缺省依次找 `api/.env`、仓库根 `.env`，见 `scripts/_bootstrap.py`）

    python scripts/eval_generate.py --dry-run          # 只列用例，不调模型
    python scripts/eval_generate.py --only hvac        # 只跑某一份

退出码：0 达标；1 未达标或有失败；2 配置/输入问题。
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from llm import LLMError, generate_guide, get_provider  # noqa: E402
from llm.prompts import set_system_prompt_override, system_prompt, system_prompt_sha  # noqa: E402
from models.visual import Primitive  # noqa: E402
from scripts._bootstrap import find_env_file, load_env_file  # noqa: E402
from scripts._evalcompare import compare_markdown, load_run  # noqa: E402

CORPUS_DIR = Path(__file__).resolve().parent.parent / "data" / "corpus"


def percentile(values: list[float], p: float) -> float:
    """最近秩法。样本量只有 5 时，P95 实际就是最大值——如实呈现，不插值粉饰。"""
    if not values:
        return 0.0
    ordered = sorted(values)
    rank = max(1, math.ceil(p / 100 * len(ordered)))
    return ordered[min(rank, len(ordered)) - 1]


@dataclass
class CaseResult:
    name: str
    status: str                  # ok | error:<kind> | input_error
    run: int = 1                 # 第几遍（`--repeat 2` 时同一份语料会有两条）
    attempts: int = 0
    repaired: bool = False
    wall_ms: int = 0
    model_ms: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    reasoning_tokens: int = 0
    cached_tokens: int = 0
    cost_micros: int = 0
    guide_id: str = ""
    steps: int = 0
    figures: int = 0
    primitives: list[str] = field(default_factory=list)
    detail: str = ""
    repairs: list[str] = field(default_factory=list)
    raw: str = ""
    guide_json: dict | None = None


def collect_cases(only: str | None, limit: int | None) -> list[tuple[str, str]]:
    files = sorted(CORPUS_DIR.glob("*.txt"))
    if only:
        files = [f for f in files if only in f.name]
    if limit:
        files = files[:limit]
    return [(f.stem, f.read_text(encoding="utf-8")) for f in files]


def run_case(provider, name: str, text: str, budget: float, timeout: float) -> CaseResult:
    started = time.monotonic()
    try:
        draft = generate_guide(provider, text, budget_s=budget, call_timeout_s=timeout)
    except LLMError as exc:
        # 失败也要记用量：token 已经花掉了，不记就会让成本报告失真
        detail = " ".join(line.strip() for line in str(exc).splitlines()[:4])[:400]
        return CaseResult(
            name=name,
            status=f"error:{exc.kind}",
            attempts=exc.attempts,
            wall_ms=int((time.monotonic() - started) * 1000),
            prompt_tokens=exc.usage.prompt_tokens,
            completion_tokens=exc.usage.completion_tokens,
            reasoning_tokens=exc.usage.reasoning_tokens,
            cost_micros=exc.cost_micros,
            detail=detail,
            raw=exc.raw or "",
        )
    except ValueError as exc:
        return CaseResult(name=name, status="input_error", detail=str(exc)[:200])

    primitives = sorted({f.primitive.value for s in draft.guide.steps for f in s.figures})
    return CaseResult(
        name=name,
        status="ok",
        attempts=draft.attempts,
        repaired=draft.repaired,
        wall_ms=int((time.monotonic() - started) * 1000),
        model_ms=draft.latency_ms,
        prompt_tokens=draft.usage.prompt_tokens,
        completion_tokens=draft.usage.completion_tokens,
        reasoning_tokens=draft.usage.reasoning_tokens,
        cached_tokens=draft.usage.cached_tokens,
        cost_micros=draft.cost_micros,
        guide_id=draft.guide.id,
        steps=len(draft.guide.steps),
        figures=sum(len(s.figures) for s in draft.guide.steps),
        primitives=primitives,
        repairs=draft.repairs,
        guide_json=draft.guide.model_dump(mode="json"),
    )


def result_row(r: CaseResult) -> dict:
    """落盘用的行。**不含 `guide_json`**：几百 KB，对照表用不上，留着只会让 JSON 难读。"""
    return {
        "name": r.name,
        "run": r.run,
        "status": r.status,
        "attempts": r.attempts,
        "repaired": r.repaired,
        "wall_ms": r.wall_ms,
        "model_ms": r.model_ms,
        "prompt_tokens": r.prompt_tokens,
        "completion_tokens": r.completion_tokens,
        "reasoning_tokens": r.reasoning_tokens,
        "cached_tokens": r.cached_tokens,
        "cost_micros": r.cost_micros,
        "steps": r.steps,
        "figures": r.figures,
        "detail": r.detail[:200],
    }


def render_report(results: list[CaseResult], meta: dict) -> str:
    ok = [r for r in results if r.status == "ok"]
    first_pass = [r for r in ok if r.attempts == 1]
    walls = [r.wall_ms / 1000 for r in ok]
    used = {p for r in ok for p in r.primitives}
    missing = {p.value for p in Primitive} - used

    n = len(results)
    cases_n = len({r.name for r in results})
    repeat = n // cases_n if cases_n else 1
    lines = [
        f"# 生成评测报告（{meta['at']}）",
        "",
        f"> 语料 {cases_n} 份 × {repeat} 遍 = **{n} 次运行** · 模型 `{meta['model']}` · "
        f"单次 {meta['timeout']:.0f}s / 总预算 {meta['budget']:.0f}s",
        f"> 变体 `{meta.get('variant', '?')}` · 提示词 sha `{meta.get('prompt_sha', '?')}`"
        "（对照用 `--compare A B`，不给孤立百分比）",
        "",
        "## 汇总",
        "",
        "| 指标 | 值 | 门槛 |",
        "|---|---|---|",
        f"| 成功（过 schema） | {len(ok)}/{n} | {n}/{n} |",
        f"| 一次通过率 | {len(first_pass) / n:.0%} | ≥80% |",
        f"| 自纠后通过 | {len(ok) - len(first_pass)} | — |",
        f"| 延迟 P50 | {percentile(walls, 50):.1f}s | ≤60s |",
        f"| 延迟 P95 | {percentile(walls, 95):.1f}s | ≤90s |",
        f"| 总成本 | ¥{sum(r.cost_micros for r in results) / 1e6:.4f} | — |",
        "",
        "## 逐例",
        "",
        "| 用例 | 状态 | 尝试 | 耗时 | 输入/输出 token | 步数/图数 | 成本 |",
        "|---|---|---|---|---|---|---|",
    ]
    for r in results:
        if r.status == "ok":
            lines.append(
                f"| {r.name} | ok | {r.attempts} | {r.wall_ms / 1000:.1f}s | "
                f"{r.prompt_tokens}/{r.completion_tokens} | {r.steps}/{r.figures} | "
                f"¥{r.cost_micros / 1e6:.4f} |"
            )
        else:
            lines.append(
                f"| {r.name} | **{r.status}** | {r.attempts} | {r.wall_ms / 1000:.1f}s | "
                f"{r.prompt_tokens}/{r.completion_tokens} | — | ¥{r.cost_micros / 1e6:.4f} |"
            )

    lines += ["", "## 图元使用", "", f"覆盖：{', '.join(sorted(used)) or '无'}"]
    if missing:
        lines.append(f"\n未出现：**{', '.join(sorted(missing))}**（可能是文本不适合，也可能是模型不会用）")

    repair_reasons: dict[str, int] = {}
    for r in ok:
        for reason in r.repairs:
            first = reason.splitlines()[0].strip("- ").strip()
            repair_reasons[first] = repair_reasons.get(first, 0) + 1
    if repair_reasons:
        lines += ["", "## 被打回的原因", ""]
        for reason, count in sorted(repair_reasons.items(), key=lambda kv: -kv[1]):
            lines.append(f"- {count}× {reason[:120]}")

    failures = [r for r in results if r.status != "ok"]
    if failures:
        lines += ["", "## 失败详情", ""]
        for r in failures:
            lines.append(f"- **{r.name}**（{r.status}）：{r.detail}")

    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description="批量生成评测")
    parser.add_argument(
        "--env-file",
        help="含 DEEPSEEK_API_KEY 的 .env；缺省依次找 api/.env、仓库根 .env",
    )
    parser.add_argument("--only", help="文件名包含该子串的用例")
    parser.add_argument("--limit", type=int)
    parser.add_argument("--budget", type=float, default=90.0)
    parser.add_argument("--timeout", type=float, default=40.0)
    parser.add_argument("--min-first-pass", type=float, default=0.8)
    parser.add_argument("--out-dir", help="保存每份生成的 JSON")
    parser.add_argument("--report", help="输出 Markdown 报告路径")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--variant", default="current", help="这一跑的标签（baseline / treat / 自定义）")
    parser.add_argument(
        "--prompt-file",
        help="用这份文本整体替换系统提示词（冻结的旧版本）；不给就用代码里现拼的那份",
    )
    parser.add_argument(
        "--repeat", type=int, default=1, help="每份语料跑几遍；≥2 才能把'抽签'与'真差异'分开"
    )
    parser.add_argument("--save", help="结果 JSON 路径；缺省 eval-results/<日期>-<variant>.json")
    parser.add_argument(
        "--compare",
        nargs=2,
        metavar=("A", "B"),
        help="只做对照：读两份结果 JSON，输出 pp 差异表，不调模型、不花钱",
    )
    parser.add_argument(
        "--save-prompt",
        help="把当前系统提示词冻结到文件后退出（不调模型）。改提示词**之前**先跑它",
    )
    args = parser.parse_args()

    if args.save_prompt:
        # 对照组的第一块砖：改提示词之前先把旧的那份存下来，否则改完就找不回来了
        text = system_prompt()
        path = Path(args.save_prompt)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        print(f"系统提示词已冻结到 {path}（{len(text)} 字符，sha {system_prompt_sha(text)}）")
        return 0

    if args.compare:
        try:
            a_data = load_run(args.compare[0])
            b_data = load_run(args.compare[1])
        except (OSError, ValueError) as exc:
            print(f"[输入问题] {exc}", file=sys.stderr)
            return 2
        print(compare_markdown(a_data, b_data))
        return 0

    cases = collect_cases(args.only, args.limit)
    if not cases:
        print("[输入问题] 没有匹配的用例", file=sys.stderr)
        return 2
    if args.dry_run:
        for name, text in cases:
            print(f"{name}  {len(text)} 字符")
        return 0

    env_path = find_env_file(args.env_file)
    if env_path is None and args.env_file:
        print(f"[配置错误] --env-file 指向的文件不存在：{args.env_file}", file=sys.stderr)
        return 2
    load_env_file(env_path)

    # 提示词决定这一跑测的是哪一版：给了 --prompt-file 就用冻结文本，
    # 并把 sha 写进结果——否则两份 JSON 放一起，谁也说不清哪个是旧版。
    prompt_text = system_prompt()
    if args.prompt_file:
        prompt_path = Path(args.prompt_file)
        if not prompt_path.is_file():
            print(f"[配置错误] --prompt-file 不存在：{prompt_path}", file=sys.stderr)
            return 2
        prompt_text = prompt_path.read_text(encoding="utf-8")
        set_system_prompt_override(prompt_text)
    prompt_sha = system_prompt_sha(prompt_text)
    print(
        f"[提示词] variant={args.variant}  {len(prompt_text)} 字符  sha={prompt_sha}"
        f"  repeat={args.repeat}",
        file=sys.stderr,
        flush=True,
    )

    try:
        provider = get_provider()
    except LLMError as exc:
        print(f"[配置错误] {exc}", file=sys.stderr)
        return 2

    out_dir = Path(args.out_dir) if args.out_dir else None
    if out_dir:
        out_dir.mkdir(parents=True, exist_ok=True)

    results: list[CaseResult] = []
    try:
        for index, (name, text) in enumerate(cases, start=1):
            for run in range(1, args.repeat + 1):
                label = f"第 {run}/{args.repeat} 遍" if args.repeat > 1 else ""
                print(f"[{index}/{len(cases)}] {name} {label} …", file=sys.stderr, flush=True)
                result = run_case(provider, name, text, args.budget, args.timeout)
                result.run = run
                results.append(result)
                flag = "ok" if result.status == "ok" else result.status
                print(
                    f"    {flag}  尝试 {result.attempts}  {result.wall_ms / 1000:.1f}s  "
                    f"{result.steps} 步 / {result.figures} 图  ¥{result.cost_micros / 1e6:.4f}",
                    file=sys.stderr,
                    flush=True,
                )
                if out_dir and result.guide_json:
                    suffix = f"-r{run}" if args.repeat > 1 else ""
                    (out_dir / f"{name}{suffix}.json").write_text(
                        json.dumps(result.guide_json, ensure_ascii=False, indent=2), encoding="utf-8"
                    )
    finally:
        close = getattr(provider, "close", None)
        if callable(close):
            close()

    meta = {
        "at": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "model": getattr(provider, "name", "unknown"),
        "budget": args.budget,
        "timeout": args.timeout,
        "variant": args.variant,
        "prompt_sha": prompt_sha,
    }
    report = render_report(results, meta)
    print(report)

    if args.report:
        path = Path(args.report)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(report, encoding="utf-8")
        print(f"报告已写入 {path}")

    save_path = (
        Path(args.save)
        if args.save
        else Path("eval-results") / f"{datetime.now():%Y-%m-%d}-{args.variant}.json"
    )
    save_path.parent.mkdir(parents=True, exist_ok=True)
    save_path.write_text(
        json.dumps(
            {
                "schema": 1,
                "variant": args.variant,
                "at": meta["at"],
                "model": meta["model"],
                "prompt_sha": prompt_sha,
                "prompt_chars": len(prompt_text),
                "repeat": args.repeat,
                "budget": args.budget,
                "timeout": args.timeout,
                "corpus": [name for name, _ in cases],
                "results": [result_row(r) for r in results],
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"结果已写入 {save_path}（对照：--compare 旧 新）")

    ok = [r for r in results if r.status == "ok"]
    first_pass_rate = len([r for r in ok if r.attempts == 1]) / len(results)
    if len(ok) < len(results):
        return 1
    if first_pass_rate < args.min_first_pass:
        print(
            f"[未达标] 一次通过率 {first_pass_rate:.0%} < {args.min_first_pass:.0%}",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
