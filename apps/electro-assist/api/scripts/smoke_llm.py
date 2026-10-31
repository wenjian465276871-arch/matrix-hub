"""生成冒烟脚本：文本 → Guide JSON。

T10 的批量评测会复用这里的调用方式，所以先把入口做成可复用的。
用法：
    python scripts/smoke_llm.py --text-file input.txt --out draft.json
    python scripts/smoke_llm.py --text "工序：……"

环境变量：DEEPSEEK_API_KEY（也可用 --env-file 指定 .env 路径）
退出码：0 成功；1 生成或校验失败；2 输入/配置问题
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

# 允许从仓库外直接运行：把 api 目录加入 sys.path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from llm import LLMError, generate_guide, get_provider  # noqa: E402
from scripts._bootstrap import find_env_file, load_env_file  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description="生成一份指导书草稿")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--text", help="工艺文本")
    group.add_argument("--text-file", help="工艺文本文件路径")
    parser.add_argument("--out", help="输出 JSON 路径（缺省打印摘要）")
    parser.add_argument("--env-file", help="含 DEEPSEEK_API_KEY 的 .env；缺省依次找 api/.env、仓库根 .env")
    parser.add_argument("--budget", type=float, default=90.0)
    parser.add_argument("--timeout", type=float, default=40.0)
    parser.add_argument("--debug", action="store_true", help="失败时打印模型原始输出")
    args = parser.parse_args()

    env_path = find_env_file(args.env_file)
    if env_path is None and args.env_file:
        print(f"[配置错误] --env-file 指向的文件不存在：{args.env_file}", file=sys.stderr)
        return 2
    load_env_file(env_path)

    text = args.text if args.text else Path(args.text_file).read_text(encoding="utf-8")

    try:
        provider = get_provider()
    except LLMError as exc:
        print(f"[配置错误] {exc}", file=sys.stderr)
        return 2

    started = time.monotonic()
    try:
        draft = generate_guide(provider, text, budget_s=args.budget, call_timeout_s=args.timeout)
    except LLMError as exc:
        print(f"[生成失败] kind={exc.kind} retryable={exc.retryable}", file=sys.stderr)
        print(str(exc), file=sys.stderr)
        print(
            f"[用量] 尝试 {exc.attempts} 次，输入 {exc.usage.prompt_tokens} / "
            f"输出 {exc.usage.completion_tokens}，成本 ¥{exc.cost_micros / 1e6:.4f}",
            file=sys.stderr,
        )
        if args.debug and exc.raw:
            print("---- 模型原始输出 ----", file=sys.stderr)
            print(exc.raw[:4000], file=sys.stderr)
            print("---- 结束 ----", file=sys.stderr)
        return 1
    except ValueError as exc:
        print(f"[输入问题] {exc}", file=sys.stderr)
        return 2
    finally:
        close = getattr(provider, "close", None)
        if callable(close):
            close()

    elapsed = time.monotonic() - started
    summary = {
        "ok": True,
        "guide_id": draft.guide.id,
        "title": draft.guide.title,
        "steps": len(draft.guide.steps),
        "figures": sum(len(s.figures) for s in draft.guide.steps),
        "attempts": draft.attempts,
        "repaired": draft.repaired,
        "latency_ms": draft.latency_ms,
        "wall_ms": int(elapsed * 1000),
        "usage": draft.usage.as_dict(),
        "cost_micros": draft.cost_micros,
        "cost_cny": round(draft.cost_micros / 1_000_000, 6),
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))

    if args.out:
        Path(args.out).write_text(
            json.dumps(draft.guide.model_dump(mode="json"), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        print(f"已写入 {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
