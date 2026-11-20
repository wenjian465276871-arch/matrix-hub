"""生成 og:image（1200×630 PNG）。

为什么是脚本、不是一张手工另存的图：微信/搜索的摘要卡要**绝对 URL 的 PNG**，
而项目里所有渲染产物都是 webp。这张是派生件——源是
`apps/electro-assist/web/public/figures/pantograph/step1.webp`（受电弓整机落弓位主图），
源图重烘了就应该重跑本脚本，而不是靠人记得手动另存。

选 step1 不选 step3：step3 是底架近景，裁进 1200×630 之后认不出是受电弓；
step1 是整机全貌、留白够、宽高比 2.03 与 1.90 只差两侧一点。

口径：
- cover 裁切（等比放大到刚好盖住 1200×630，居中裁），**不拉伸**；
- RGBA 平铺到 `--c-surface` 白，与页面里面板底色一致；
- 只做等比缩放与裁切，不加文字、不加阴影——图上没有一个像素是新造的；
- 存 **JPEG q86**：同一张图 PNG 是 690KB，JPEG 是 130KB 量级。
  摘要是"看一眼决定点不点"，不值得为无损多背 5 倍流量。

用法：python tools/make_og_cover.py
产物：apps/electro-assist/web/public/og-cover.jpg
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "apps/electro-assist/web/public/figures/pantograph/step1.webp"
OUT = ROOT / "apps/electro-assist/web/public/og-cover.jpg"

W, H = 1200, 630
BG = (255, 255, 255)


def main() -> int:
    if not SRC.exists():
        print(f"缺源图：{SRC}")
        return 2

    im = Image.open(SRC).convert("RGBA")
    canvas = Image.new("RGB", im.size, BG)
    canvas.paste(im, mask=im.split()[-1])

    scale = max(W / canvas.width, H / canvas.height)
    scaled = canvas.resize(
        (round(canvas.width * scale), round(canvas.height * scale)),
        Image.LANCZOS,
    )
    left = (scaled.width - W) // 2
    top = (scaled.height - H) // 2
    cover = scaled.crop((left, top, left + W, top + H))

    cover.save(OUT, format="JPEG", quality=86, optimize=True, progressive=True)
    kb = OUT.stat().st_size / 1000
    print(f"{OUT.relative_to(ROOT)}  {cover.width}×{cover.height}  {kb:.1f}KB  (源 {SRC.name})")
    return 0 if kb <= 300 else 1


if __name__ == "__main__":
    sys.exit(main())
