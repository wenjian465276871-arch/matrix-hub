"""生成快照回放：把一份**已经通过过的模型输出**冻成夹具，不触网跑完整条生成链。

## 为什么值得单独一个文件

`test_llm_runner.py` 里的假输出是手写的，它证明"运行器能处理各种错误"，
但不证明"真实模型写出来的东西能过今天的校验"。

每次收紧契约（例如 2026-11-09 把 `device_scene.t` 收成只认设备表里的瞬间），
都需要一个"昨天真实通过、今天还能通过"的样本；否则只能靠再花钱跑一次真实生成，
而且结果还是概率性的——跑一次通过不代表规则没问题，跑一次失败也说不清是谁的问题。

夹具里存的是**模型原文**（连 json 代码围栏都留着），所以这一遍会真的走
`extract_json → json.loads → Guide 校验 → 降级`，与线上是同一条代码路径。

## 两类断言

- 正向：夹具必须**一次通过**（一次调用、降级处数与冻结时一致），且产出的
  步骤/图示/三维参数与冻结时一致。任何一项变了，都说明契约动了，人必须来看一眼。
- 反向：把夹具里的 `t` 改成一个表外的值（0.5），必须被拦下来。这一条同时锁住了
  当前取舍——拦下之后的结局是**这张图被丢掉**，而不是"画一张停在别的工步的图"。

新增夹具：`python scripts/capture_generation.py --case <语料>`（见脚本 docstring）。
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from llm.base import Completion, Usage
from llm.prompts import system_prompt
from llm.runner import extract_json, generate_guide
from models.visual import DEVICE_MOMENTS, DEVICE_PART_LABELS, DEVICE_T_TOLERANCE

FIXTURE_DIR = Path(__file__).resolve().parent / "fixtures" / "generations"
FIXTURES = sorted(FIXTURE_DIR.glob("*.json"))


class SnapshotProvider:
    """把夹具里的原文当成"模型的回答"喂回去，并记录被调用了几次。"""

    name = "snapshot"

    def __init__(self, text: str, usage: Usage | None = None) -> None:
        self.text = text
        self.usage = usage or Usage()
        self.calls = 0

    def structured(self, *, system, user, schema, timeout_s, max_tokens=4096, thinking=True):
        self.calls += 1
        if self.calls > 1:
            # 只该有一次调用：第二次说明第一份输出被拒了，夹具已经不是"已知能过"。
            raise AssertionError("回放夹具触发了重试，说明它已经过不了当前校验")
        return Completion(text=self.text, model="snapshot", usage=self.usage, latency_ms=1)


def _load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _scenes(guide) -> list[dict]:
    return [
        {
            "seq": step.seq,
            "subject": fig.params.get("subject"),
            "t": fig.params.get("t"),
            "part": fig.params.get("part"),
        }
        for step in guide.steps
        for fig in step.figures
        if fig.primitive.value == "device_scene"
    ]


def test_fixture_dir_is_not_empty():
    """夹具目录空了也要红——空目录下所有参数化用例会"全部通过"，假绿最危险。"""
    assert FIXTURES, f"{FIXTURE_DIR} 下没有回放夹具"


@pytest.mark.parametrize("path", FIXTURES, ids=lambda p: p.stem)
def test_snapshot_passes_untouched(path: Path):
    """夹具必须一次通过：一次调用、降级处数与冻结时一致、产出一致。

    为什么允许"有降级"：真实模型经常给 `device_scene` 挂 `motion`，那个原语没有
    可动槽位，运行器会按规矩剔掉——这是**设计内的确定性降级**，不是失败。
    夹具记下当时的处数，改一条规则就多一处，红得正好。

    只要这一条红了，要么是有人把校验线画到了真实模型够不着的地方，要么是
    降级路径变了——两种都得有人来看，**不能**改夹具来迁就。
    """
    fixture = _load(path)
    provider = SnapshotProvider(fixture["raw"], Usage(**fixture["usage"]))
    draft = generate_guide(provider, fixture["input"])

    assert provider.calls == 1, "一次通过的输出不该触发第二次调用"
    assert draft.attempts == 1
    expect = fixture["expect"]
    assert len(draft.repairs) == expect.get("repairs", 0), f"降级处数变了：{draft.repairs}"

    assert len(draft.guide.steps) == expect["steps"]
    assert sorted(
        {fig.primitive.value for step in draft.guide.steps for fig in step.figures}
    ) == expect["primitives"]
    assert _scenes(draft.guide) == expect["device_scenes"]


@pytest.mark.parametrize("path", FIXTURES, ids=lambda p: p.stem)
def test_snapshot_scenes_point_at_real_moments(path: Path):
    """夹具里的每个三维场景都必须落在设备表的瞬间上。

    这条与 SPEC 层的校验重复，但重复得值得：如果哪天有人放宽了校验，
    单元测试可能被一起改掉，而这里冻结的是**真实输出**的取值，改不动。
    """
    fixture = _load(path)
    for scene in fixture["expect"]["device_scenes"]:
        valid_t = [t for t, _, _ in DEVICE_MOMENTS[scene["subject"]]]
        assert scene["t"] in valid_t, f"{scene['subject']} 没有 t={scene['t']} 这个瞬间"
        if scene["part"] is not None:
            assert scene["part"] in DEVICE_PART_LABELS[scene["subject"]]


def test_wrong_moment_is_dropped_not_misrendered():
    """把 t 改成表外的值：结局是"这张图被丢掉"，不是"画一张别的工步的图"。

    这是 `t` 收紧之后真正的行为边界，也是这个夹具最有价值的一条：
    校验拒绝 → `_salvage` 逐步丢图 → 正文与判据一字不动地保留。
    宁可少一张图，也不要一张停在别的工步、而页面上完全看不出来的图。

    反例取 0.5 而不是 0.6：受电弓 0.61 的容差窗口是 0.59–0.63，**0.6 是合法的**
    （会被吸附成 0.61）。第一版就是拿 0.6 当反例，测出来"没有降级"，白跑一轮——
    容差吸附把"看起来错"的值先兜住了，反例必须落在表外。

    只改**第一张**三维图：`_salvage` 是一步一步试的，它只能丢掉"出问题的那一步"
    的全部图示。两份都改就会一路试到底、最后交给模型重试——那是另一条路径，
    由 `test_llm_runner.py` 的校验失败用例负责，这里不重复。
    """
    bad_t = 0.5
    moments = [t for t, _, _ in DEVICE_MOMENTS["pantograph"]]
    assert min(abs(bad_t - t) for t in moments) > DEVICE_T_TOLERANCE, "反例落在容差里了"

    base = _load(FIXTURE_DIR / "pantograph_raise.json")
    scenes = base["expect"]["device_scenes"]
    assert scenes, "夹具里没有三维场景，这条用例测不到东西"
    target = scenes[0]

    payload = json.loads(extract_json(base["raw"]))
    touched = 0
    for step in payload.get("steps", []):
        for figure in step.get("figures", []):
            if figure.get("primitive") == "device_scene" and step.get("seq") == target["seq"]:
                figure["params"]["t"] = bad_t
                touched += 1
    assert touched == 1, f"第 {target['seq']} 步应当正好一张三维图"

    provider = SnapshotProvider(json.dumps(payload, ensure_ascii=False))
    draft = generate_guide(provider, base["input"])

    assert provider.calls == 1, "降级能救回来的不该再花一次调用"
    assert draft.repairs, "表外的 t 必须留下降级记录"
    assert _scenes(draft.guide) == scenes[1:], "只有出问题那一步的图被丢，其余不动"
    assert len(draft.guide.steps) == base["expect"]["steps"]
    # 正文与判据是这份指导书的实体，丢图不能连它们一起丢。
    assert all(step.action and step.criteria for step in draft.guide.steps)


def test_prompt_still_lists_the_snapshot_moments():
    """夹具里用到的瞬间必须仍在 prompt 的设备表里。

    夹具与 prompt 是两处独立演进的东西：某天把 `升弓到位` 从表里删掉，
    夹具照样能过（它只走校验），但模型再也选不到那个瞬间了。这条把两头钉在一起。
    """
    prompt = system_prompt()
    for path in FIXTURES:
        for scene in _load(path)["expect"]["device_scenes"]:
            for t, _, label in DEVICE_MOMENTS[scene["subject"]]:
                if t == scene["t"]:
                    assert label in prompt, f"prompt 里没有「{label}」这个瞬间了"
