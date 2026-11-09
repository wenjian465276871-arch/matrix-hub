#!/usr/bin/env python3
"""把一次生成输出固化成**离线回放夹具**（`tests/fixtures/generations/*.json`）。

## 为什么要有这个脚本

生成是概率性的：今天模型给出 `t=0.72`、`part=head`，明天可能给 `t=0.6`。
校验规则却是确定性的——每次把它调紧一点，都只能靠"再跑一次真实生成"来验证，
而真实生成要花钱、要等 15–20s、结果还不稳定。三次之后就没人愿意改了。

所以把一份**已知能过的输出**存下来：原文一字不改（连代码围栏都留着），
测试里用假 provider 喂回去，走完 `extract_json → Guide 校验 → 降级` 整条链。
它锁的不是 prompt，而是**契约**：这份输出今天能过，改了校验器还能过。

与 `replay_samples.py` 的分工（两者都叫"回放"，但冻的不是同一头）：
- `replay_samples.py` 冻**存量的已发布指导书**，验的是"读得懂旧数据"（向后兼容）；
- 本脚本冻**模型原始输出**，验的是"真实模型写得出今天能过的内容"（向前可达）。
过不去就是有人把线画到了真实模型够不着的地方——那正是要拦的事。

## 两种来源

- `--case` / `--text-file`：**真实调用**一次模型，把 Completion 原文存下来
  （`source: model_output`）。带重试（`attempts > 1`）时拒绝——第一份是坏样本，
  最后一份又丢掉了"它本来会被拒"的信息，两种都让夹具语义变模糊。
- `--from-sample`：不调模型，把已发布样例包成"模型形状"的 JSON 存下来
  （`source: sample_snapshot`）。没有 Key 的环境（CI、别人的机器）也能建夹具。

用法（在 `apps/electro-assist/api` 下）：
    ./.venv/Scripts/python.exe scripts/capture_generation.py --case 05_pantograph_raise
    ./.venv/Scripts/python.exe scripts/capture_generation.py --from-sample data/samples/pantograph_raise.json
    ./.venv/Scripts/python.exe scripts/capture_generation.py --case 01_door_switch --force

已存在的夹具默认**拒绝覆盖**：覆盖等于悄悄换掉回归基线，必须显式 `--force`。
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(API_DIR))

from llm import LLMError, generate_guide, get_provider  # noqa: E402
from llm.base import Completion, Usage  # noqa: E402
from models.guide import Guide  # noqa: E402
from models.visual import Primitive  # noqa: E402
from scripts._bootstrap import find_env_file, load_env_file  # noqa: E402

CORPUS_DIR = API_DIR / "data" / "corpus"
DEFAULT_OUT_DIR = API_DIR / "tests" / "fixtures" / "generations"

# 服务端所有的字段：模型看不到，也不该出现在"模型输出"里。
# 从样例转快照时必须剔掉，否则夹具里躺着一份模型永远写不出来的东西，
# 回放就变成了"测一个不存在的场景"。
SERVER_ONLY_TOP = ("assets",)
SERVER_ONLY_STEP = ("assets", "provenance")
SERVER_ONLY_META = ("source_type", "station")


class RecordingProvider:
    """包一层真 provider，把每个成功的 Completion 原文留下来。

    不改行为、不改参数、不吞异常——只是把返回值多存一份。
    存原文而不是解析后的 dict：夹具要证明的是"模型写出来的这段文本能过校验"，
    存 dict 就把 `extract_json`（剥围栏那段）跳过了，而那正是最容易坏的一环。
    """

    name = "recording"

    def __init__(self, inner) -> None:
        self.inner = inner
        self.completions: list[Completion] = []

    def structured(self, **kwargs) -> Completion:
        completion = self.inner.structured(**kwargs)
        self.completions.append(completion)
        return completion


def scene_summary(guide: Guide) -> list[dict]:
    return [
        {
            "seq": step.seq,
            "subject": fig.params.get("subject"),
            "t": fig.params.get("t"),
            "part": fig.params.get("part"),
        }
        for step in guide.steps
        for fig in step.figures
        if fig.primitive is Primitive.device_scene
    ]


def model_shaped(payload: dict) -> dict:
    """把样例裁成"模型会写出来的样子"：只留模型看得见的字段。"""
    body = {k: v for k, v in payload.items() if k not in SERVER_ONLY_TOP}
    if isinstance(body.get("meta"), dict):
        body["meta"] = {k: v for k, v in body["meta"].items() if k not in SERVER_ONLY_META}
    steps = body.get("steps")
    if isinstance(steps, list):
        body["steps"] = [
            {k: v for k, v in step.items() if k not in SERVER_ONLY_STEP}
            if isinstance(step, dict)
            else step
            for step in steps
        ]
    return body


def build_fixture(
    *,
    name: str,
    text: str,
    raw: str,
    model: str,
    usage: Usage,
    guide: Guide,
    repairs: list[str],
    source: str,
    input_source: str,
) -> dict:
    return {
        "case": name,
        "source": source,
        "captured_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "model": model,
        "input_source": input_source,
        # 输入文本一起存：语料改字后夹具不会"半新半旧"，回放与原文始终配对。
        "input": text,
        "usage": {
            "prompt_tokens": usage.prompt_tokens,
            "completion_tokens": usage.completion_tokens,
            "reasoning_tokens": usage.reasoning_tokens,
        },
        # 原文一字不改：连 ```json 围栏也留着，回放时同样要过 extract_json。
        "raw": raw,
        "expect": {
            "steps": len(guide.steps),
            # 确定性降级也记下来：真实输出经常带一条挂错槽位的动效，运行器会剔掉它。
            # 记数量而不是记原文——文案会改，改文案不该让夹具变红。
            "repairs": len(repairs),
            "repair_notes": repairs,
            "primitives": sorted(
                {fig.primitive.value for step in guide.steps for fig in step.figures}
            ),
            "device_scenes": scene_summary(guide),
        },
        "note": (
            "离线回放夹具。内容取公开资料改写 + 演示虚构参数，不含内部资料；"
            "参数不代表任何车型图纸或实测结果。"
        ),
    }


def write_fixture(path: Path, fixture: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(fixture, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"write {path}（{path.stat().st_size} 字节）")


def run_live(args, out_path: Path) -> int:
    if args.case:
        text_path = CORPUS_DIR / f"{args.case}.txt"
        if not text_path.is_file():
            print(f"[FAIL] 语料不存在：{text_path}", file=sys.stderr)
            return 2
        name = args.name or args.case
        input_source = f"data/corpus/{args.case}.txt"
    else:
        text_path = Path(args.text_file)
        if not text_path.is_file():
            print(f"[FAIL] 文本不存在：{text_path}", file=sys.stderr)
            return 2
        name = args.name or text_path.stem
        input_source = str(text_path)

    text = text_path.read_text(encoding="utf-8").strip()
    env_file = find_env_file(args.env_file)
    if env_file:
        load_env_file(env_file)
        print(f"env  {env_file}")
    else:
        print("env  未找到 .env，沿用当前环境变量")

    recorder = RecordingProvider(get_provider())
    print(f"run  {name} …")
    try:
        draft = generate_guide(recorder, text)
    except LLMError as exc:
        # 失败也要如实报：raw 里是模型写坏的那份，是排查素材，不该混进夹具。
        print(f"[FAIL] {exc.kind}：{exc}", file=sys.stderr)
        if exc.raw:
            print(f"       原始输出 {len(exc.raw)} 字符（未写入夹具）", file=sys.stderr)
        return 1

    if draft.attempts != 1 or not recorder.completions:
        print(
            f"[FAIL] 这次生成用了 {draft.attempts} 次调用（repairs={draft.repairs}）。"
            "夹具只接受一次通过的真实输出，请重跑或换一份语料。",
            file=sys.stderr,
        )
        return 1

    completion = recorder.completions[0]
    fixture = build_fixture(
        name=name,
        text=text,
        raw=completion.text,
        model=completion.model,
        usage=completion.usage,
        guide=draft.guide,
        repairs=draft.repairs,
        source="model_output",
        input_source=input_source,
    )
    if draft.repairs:
        # 不算失败：真实模型确实会给 device_scene 挂 motion，运行器按规矩剔掉了。
        # 但要打出来——"这份快照需要 N 处降级"是事实，藏起来就成了假干净。
        print(f"note {len(draft.repairs)} 处降级（已记入 expect.repairs）：")
        for note in draft.repairs:
            print(f"     · {note}")
    write_fixture(out_path, fixture)
    report(fixture)
    return 0


def run_from_sample(args, out_path: Path) -> int:
    sample_path = Path(args.from_sample)
    if not sample_path.is_file():
        print(f"[FAIL] 样例不存在：{sample_path}", file=sys.stderr)
        return 2
    name = args.name or sample_path.stem
    payload = model_shaped(json.loads(sample_path.read_text(encoding="utf-8")))
    # 围栏要留着：真实模型确实会包一层 ```json，回放时得走同一条剥离逻辑。
    raw = "```json\n" + json.dumps(payload, ensure_ascii=False, indent=2) + "\n```"
    # 输入文本按文件名就近找语料（样例 `pantograph_raise` ↔ 语料 `05_pantograph_raise`）；
    # 找不到就写一句说明——回放只用 `input` 过长度校验，不靠它还原语义。
    candidates = sorted(CORPUS_DIR.glob(f"*{sample_path.stem}*.txt"))
    input_text = (
        candidates[0].read_text(encoding="utf-8").strip()
        if candidates
        else "离线快照：原始输入文本未随样例保存。"
    )
    try:
        guide = Guide.model_validate(payload)
    except Exception as exc:  # noqa: BLE001 - 这里只关心"能不能过"，错误原样报
        print(f"[FAIL] 样例本身过不了当前校验：{exc}", file=sys.stderr)
        return 1

    fixture = build_fixture(
        name=name,
        text=input_text,
        raw=raw,
        model="sample-snapshot",
        usage=Usage(),
        guide=guide,
        repairs=[],
        source="sample_snapshot",
        input_source=str(sample_path),
    )
    write_fixture(out_path, fixture)
    report(fixture)
    return 0


def report(fixture: dict) -> None:
    print(
        f"ok   {fixture['case']}｜{fixture['expect']['steps']} 步｜"
        f"{fixture['usage']['prompt_tokens']}/{fixture['usage']['completion_tokens']} tok｜"
        f"source={fixture['source']}"
    )
    for scene in fixture["expect"]["device_scenes"]:
        print(f"     device_scene seq={scene['seq']} t={scene['t']} part={scene['part']}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="固化一份输出为离线回放夹具")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--case", help="语料名（data/corpus 下的文件名，不含扩展名）")
    source.add_argument("--text-file", help="自定义输入文本文件")
    source.add_argument("--from-sample", help="从已发布样例转快照（不调模型）")
    parser.add_argument("--name", help="夹具名（默认取用例/文件/样例的文件名）")
    parser.add_argument("--out-dir", default=str(DEFAULT_OUT_DIR))
    parser.add_argument("--env-file", help=".env 路径；缺省按 api/.env → 仓库根 .env 找")
    parser.add_argument("--force", action="store_true", help="允许覆盖已存在的夹具")
    args = parser.parse_args(argv)

    stem = args.name or (args.case or Path(args.text_file or args.from_sample).stem)
    out_path = Path(args.out_dir) / f"{stem}.json"
    if out_path.exists() and not args.force:
        print(f"[FAIL] 夹具已存在：{out_path}（覆盖请加 --force）", file=sys.stderr)
        return 2

    if args.from_sample:
        return run_from_sample(args, out_path)
    return run_live(args, out_path)


if __name__ == "__main__":
    raise SystemExit(main())
