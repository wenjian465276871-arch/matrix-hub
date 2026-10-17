"""切图：把整页工艺截图切成"可识别的块"，而不是整图硬啃。

为什么切：
- 表格线、引出线、小字混在一张图里，整图识别时小字只占几像素；
- 局部放大 2–3 倍后，`M6×12`、`0.8 N·m` 这类关键值才稳定可读；
- 切块之间保留重叠，避免把一个字切两半。

实现说明：这里用 numpy 做像素统计（行/列暗像素游程 + 网格密度）。
检索层仍然不用 numpy（见开发计划 §9.4），这是图像处理单独引入的依赖。
"""
from __future__ import annotations

import io
import os
from dataclasses import dataclass, asdict

import numpy as np
from PIL import Image

WORK_MAX_WIDTH = 900          # 检测时的工作分辨率
DARK_THRESHOLD = 200          # 灰度低于此值视为"墨"
LINE_RUN_RATIO = 0.40         # 行/列连续暗像素占比超过此值视为表格线
GRID = 50                     # 密度网格边长（工作图坐标）
DENSITY_MIN, DENSITY_MAX = 0.04, 0.55
MAX_REGIONS = 6
CROP_LONG_SIDE = 1600
MAX_SCALE = 3.0
PADDING = 24


@dataclass
class Region:
    id: str
    reason: str                 # table | dense_text | full
    bbox: tuple[int, int, int, int]   # 原图坐标 x, y, w, h
    scale: float
    width: int
    height: int
    path: str
    bytes: int

    def to_dict(self) -> dict:
        d = asdict(self)
        d["bbox"] = list(self.bbox)
        return d


def _longest_run(bool_row: np.ndarray) -> int:
    """一行/一列里最长的连续 True 长度。"""
    if not bool_row.any():
        return 0
    idx = np.flatnonzero(np.diff(np.concatenate(([0], bool_row.view(np.int8), [0]))))
    return int((idx[1::2] - idx[0::2]).max()) if idx.size else 0


def _find_table_boxes(dark: np.ndarray) -> list[tuple[int, int, int, int]]:
    """逐对相邻横线判断：这对线之间是否存在贯穿的竖线。

    为什么不用"整页竖线比例"：一张 320px 高的表放在 1300px 页里，
    竖线只占页高的 25%，任何按页高取的比例阈值都会漏掉它。
    改成以相邻横线间距为分母，尺度问题自然消失。
    """
    h, w = dark.shape
    h_lines = [y for y in range(h) if _longest_run(dark[y]) >= w * 0.25]
    if len(h_lines) < 2:
        return []

    rows: list[tuple[int, int, int, int]] = []
    for i in range(len(h_lines) - 1):
        y0, y1 = h_lines[i], h_lines[i + 1]
        bh = y1 - y0
        if bh < max(8, h // 80):
            continue
        sub = dark[y0:y1 + 1, :]
        v_lines = [x for x in range(w) if _longest_run(sub[:, x]) >= bh * 0.7]
        if len(v_lines) < 2:
            continue
        x0, x1 = v_lines[0], v_lines[-1]
        if (x1 - x0) < w * 0.12:
            continue
        rows.append((x0, y0, x1 - x0, bh))

    # 相邻行合并成整张表
    merged: list[tuple[int, int, int, int]] = []
    for r in sorted(rows, key=lambda t: t[1]):
        if merged:
            px, py, pw, ph = merged[-1]
            if abs(r[0] - px) <= w * 0.05 and r[1] <= py + ph + max(6, h // 50):
                nx, ny = min(px, r[0]), py
                nx1 = max(px + pw, r[0] + r[2])
                ny1 = max(py + ph, r[1] + r[3])
                merged[-1] = (nx, ny, nx1 - nx, ny1 - ny)
                continue
        merged.append(r)
    return [m for m in merged if m[3] >= h * 0.04]


def _find_dense_blocks(dark: np.ndarray) -> list[tuple[int, int, int, int]]:
    h, w = dark.shape
    gh, gw = h // GRID, w // GRID
    if gh < 2 or gw < 2:
        return []
    grid = dark[: gh * GRID, : gw * GRID].reshape(gh, GRID, gw, GRID).mean(axis=(1, 3))
    mask = (grid > DENSITY_MIN) & (grid < DENSITY_MAX)

    seen = np.zeros_like(mask, dtype=bool)
    blocks: list[tuple[int, int, int, int]] = []
    for y in range(gh):
        for x in range(gw):
            if not mask[y, x] or seen[y, x]:
                continue
            stack = [(y, x)]
            seen[y, x] = True
            ys, xs = [], []
            while stack:
                cy, cx = stack.pop()
                ys.append(cy); xs.append(cx)
                for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    ny, nx = cy + dy, cx + dx
                    if 0 <= ny < gh and 0 <= nx < gw and mask[ny, nx] and not seen[ny, nx]:
                        seen[ny, nx] = True
                        stack.append((ny, nx))
            if len(ys) < 2:
                continue
            y0, y1 = min(ys) * GRID, (max(ys) + 1) * GRID
            x0, x1 = min(xs) * GRID, (max(xs) + 1) * GRID
            blocks.append((x0, y0, x1 - x0, y1 - y0))
    return blocks


def _iou(a: tuple[int, int, int, int], b: tuple[int, int, int, int]) -> float:
    ax0, ay0, aw, ah = a; bx0, by0, bw, bh = b
    ix0, iy0 = max(ax0, bx0), max(ay0, by0)
    ix1, iy1 = min(ax0 + aw, bx0 + bw), min(ay0 + ah, by0 + bh)
    if ix1 <= ix0 or iy1 <= iy0:
        return 0.0
    inter = (ix1 - ix0) * (iy1 - iy0)
    return inter / (aw * ah + bw * bh - inter)


def slice_image(raw: bytes, asset_id: str, out_dir: str,
                max_regions: int = MAX_REGIONS) -> list[Region]:
    """生成整图视图 + 若干局部放大块，返回带坐标的清单。"""
    os.makedirs(out_dir, exist_ok=True)
    with Image.open(io.BytesIO(raw)) as im:
        im = im.convert("L") if im.mode != "L" else im
        full = im.copy()

    # 工作图：只用于检测，坐标最后按比例映射回原图
    ratio = min(1.0, WORK_MAX_WIDTH / max(full.size))
    work = full.resize((max(1, round(full.width * ratio)), max(1, round(full.height * ratio))), Image.LANCZOS)
    dark = np.asarray(work, dtype=np.uint8) < DARK_THRESHOLD

    table_boxes = _find_table_boxes(dark)
    text_blocks = [b for b in _find_dense_blocks(dark)
                   if b[2] * b[3] < dark.size * 0.25
                   and all(_iou(b, t) < 0.2 for t in table_boxes)]
    boxes = table_boxes + text_blocks

    # 去重：面积大的优先，重叠超过 0.6 的丢掉
    boxes.sort(key=lambda b: b[2] * b[3], reverse=True)
    kept: list[tuple[int, int, int, int]] = []
    for b in boxes:
        if all(_iou(b, k) < 0.6 for k in kept):
            kept.append(b)
    kept = kept[: max_regions]

    regions: list[Region] = []
    # 1) 整图视图：建立全局结构（标题、章节顺序）
    regions.append(_emit(full, asset_id, "full", (0, 0, full.width, full.height), out_dir, ratio=1.0))

    # 2) 局部块：映射回原图坐标、加 padding、放大
    for i, (x, y, w, h) in enumerate(kept, start=1):
        ox, oy = round(x / ratio), round(y / ratio)
        ow, oh = round(w / ratio), round(h / ratio)
        ox, oy = max(0, ox - PADDING), max(0, oy - PADDING)
        ow = min(full.width - ox, ow + PADDING * 2)
        oh = min(full.height - oy, oh + PADDING * 2)
        if ow < 60 or oh < 40:
            continue
        reason = "table" if _looks_like_table(dark, (x, y, w, h)) else "dense_text"
        regions.append(_emit(full, asset_id, reason, (ox, oy, ow, oh), out_dir, ratio=1.0, index=i))

    return regions


def _looks_like_table(dark: np.ndarray, box: tuple[int, int, int, int]) -> bool:
    x, y, w, h = box
    sub = dark[y:y + h, x:x + w]
    if sub.size == 0:
        return False
    h_lines = sum(1 for row in sub if _longest_run(row) >= w * LINE_RUN_RATIO)
    return h_lines >= 2


def _emit(img: Image.Image, asset_id: str, reason: str, box: tuple[int, int, int, int],
          out_dir: str, ratio: float, index: int | None = None) -> Region:
    x, y, w, h = box
    crop = img.crop((x, y, x + w, y + h))
    if reason == "full":
        scale = min(1.0, CROP_LONG_SIDE / max(crop.size)) if max(crop.size) > CROP_LONG_SIDE else 1.0
    else:
        scale = min(MAX_SCALE, CROP_LONG_SIDE / max(crop.size))
        scale = max(scale, 1.0)
    if abs(scale - 1.0) > 0.01:
        crop = crop.resize((max(1, round(crop.width * scale)), max(1, round(crop.height * scale))), Image.LANCZOS)

    name = f"{asset_id}_full.png" if reason == "full" else f"{asset_id}_r{index}.png"
    path = os.path.join(out_dir, name)
    crop.save(path, format="PNG", optimize=True)
    return Region(
        id=f"{asset_id}-{reason}-{index or 0}",
        reason=reason,
        bbox=(x, y, w, h),
        scale=round(scale, 2),
        width=crop.width,
        height=crop.height,
        path=name,
        bytes=os.path.getsize(path),
    )
