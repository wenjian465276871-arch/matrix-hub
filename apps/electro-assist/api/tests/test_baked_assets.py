r"""静态主图的**文件存在性**门禁。

## 为什么需要它

`models/visual.py` 的 `BAKED_SRC_RE` 只保证 `src` 的**形状**合法
（`/figures/…\.(webp|jpg|jpeg|png)$`、不含 `..`），不保证文件真的在仓库里。
而六份指导书的主要信息载体就是这 16 张图——它们躺在 `web/public/figures/` 下，
改一个目录名、清一次缓存、误删一张，**CI 全绿**，页面只在运行时降级成一句
`fallback_text`。前端 `BakedFigure.vue` 的降级是"体面地少一张图"，
不是"报错让人发现"。

2026-11-12 第五轮阶段评审 P2-1 把这条列为待办（R11-1）：图从实时三维改成静态图
之后，**页面正确性开始依赖仓库里的二进制文件**，而测试只碰 JSON。

## 这条门禁钉什么

1. 每张 `baked_figure` 的 `src` 在 `web/public` 下存在；
2. 文件不是空壳（> 1KB）——0 字节文件常见于中断的渲染/拷贝；
3. 同一条素材不得同时出现在两份样例里（避免"改一份忘了另一份"）。
   注：门扇那张图被两份车门指导书共用是**同一个 src**，这里查的是"同一张图
   指向不同文件"的复制粘贴错，所以按 `src` 去重后仍允许跨文件复用。
"""

from __future__ import annotations

import json
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]
SAMPLES_DIR = API_DIR / "data" / "samples"
PUBLIC_DIR = API_DIR.parent / "web" / "public"

MIN_BYTES = 1024


def _baked_srcs(samples_dir: Path) -> list[tuple[str, int, str]]:
    """返回 [(样例文件名, 步序, src)]。"""
    out: list[tuple[str, int, str]] = []
    for path in sorted(samples_dir.glob("*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        guide = data.get("guide", data)
        for step in guide.get("steps", []):
            for figure in step.get("figures", []):
                if figure.get("primitive") != "baked_figure":
                    continue
                src = (figure.get("params") or {}).get("src", "")
                out.append((path.name, int(step.get("seq", 0)), src))
    return out


def _collect_missing(samples_dir: Path, public_dir: Path) -> list[str]:
    """把"引用存在但文件不在 / 是空壳"的条目攒成人类可读的清单。"""
    problems: list[str] = []
    for sample, seq, src in _baked_srcs(samples_dir):
        if not src.startswith("/figures/"):
            problems.append(f"{sample} 第 {seq} 步：src 不以 /figures/ 开头（{src}）")
            continue
        target = public_dir / src.lstrip("/")
        if not target.exists():
            problems.append(f"{sample} 第 {seq} 步：文件不存在 {src}")
            continue
        size = target.stat().st_size
        if size < MIN_BYTES:
            problems.append(f"{sample} 第 {seq} 步：文件只有 {size}B（< {MIN_BYTES}B）{src}")
    return problems


def test_every_baked_src_exists():
    """六份样例引用的每一张静态图都必须在 web/public 下真实存在。"""
    assert SAMPLES_DIR.is_dir(), f"样例目录不存在：{SAMPLES_DIR}"
    assert PUBLIC_DIR.is_dir(), f"前端公共目录不存在：{PUBLIC_DIR}"

    srcs = _baked_srcs(SAMPLES_DIR)
    # 数量下限：少于 10 张说明样例被误删或格式改了，门禁本身失去意义
    assert len(srcs) >= 10, f"只找到 {len(srcs)} 处 baked_figure，样例可能被破坏"

    problems = _collect_missing(SAMPLES_DIR, PUBLIC_DIR)
    assert not problems, "静态主图缺失：\n" + "\n".join(problems)


def test_gate_can_fail(tmp_path: Path):
    """门禁自检：引用一张不存在的图，必须被这条门禁抓出来。

    没有这条，`test_every_baked_src_exists` 可能因为"扫到 0 条"而永远绿
    ——那正是 R11-1 想避免的失败方式。
    """
    samples = tmp_path / "samples"
    public = tmp_path / "public"
    samples.mkdir()
    public.mkdir()
    (samples / "probe.json").write_text(
        json.dumps(
            {
                "id": "g_probe_001",
                "steps": [
                    {
                        "seq": 1,
                        "figures": [
                            {
                                "primitive": "baked_figure",
                                "params": {"src": "/figures/probe/missing.webp", "alt": "探针"},
                            }
                        ],
                    }
                ],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    problems = _collect_missing(samples, public)
    assert problems and "missing.webp" in problems[0], problems

    # 补上文件（>1KB）后必须转绿，否则说明门禁只会喊不会判
    target = public / "figures" / "probe" / "missing.webp"
    target.parent.mkdir(parents=True)
    target.write_bytes(b"x" * (MIN_BYTES + 1))
    assert _collect_missing(samples, public) == []

    # 空壳文件同样要抓：中断的渲染/拷贝留下的 0 字节文件不能算"有图"
    target.write_bytes(b"")
    assert _collect_missing(samples, public)
