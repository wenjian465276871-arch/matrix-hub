"""图片准入：格式、尺寸、清晰度门槛与安全重编码。

原则：
- 不信任扩展名与 Content-Type，只看文件魔数；
- 一律剥离 EXIF 后重编码（隐私 + 去潜在载荷）；
- 门槛在入口处硬卡，不合格直接拒，不进入后续识别链路。
"""
from __future__ import annotations

import hashlib
import io
from dataclasses import dataclass, field
from enum import Enum

from PIL import Image, ImageOps, UnidentifiedImageError

MAX_BYTES = 5 * 1024 * 1024
MIN_LONG_SIDE = 1000
MAX_LONG_SIDE = 8000
MIN_ASPECT, MAX_ASPECT = 0.3, 3.3
MAX_PIXELS = 40_000_000  # 防止解压炸弹


class Code(str, Enum):
    too_large = "too_large"
    bad_format = "bad_format"
    too_small = "too_small"
    bad_aspect = "bad_aspect"
    too_many_pixels = "too_many_pixels"
    unreadable = "unreadable"


@dataclass
class Issue:
    code: Code
    message: str


@dataclass
class ImageInfo:
    format: str
    width: int
    height: int
    mode: str
    bytes: int
    sha256: str

    @property
    def long_side(self) -> int:
        return max(self.width, self.height)

    @property
    def aspect(self) -> float:
        return round(self.width / self.height, 3) if self.height else 0.0


@dataclass
class Inspection:
    info: ImageInfo | None
    issues: list[Issue] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return self.info is not None and not self.issues


def _sniff(raw: bytes) -> str | None:
    """按魔数判断格式。只认 PNG / JPEG / WebP。"""
    if raw[:8] == b"\x89PNG\r\n\x1a\n":
        return "PNG"
    if raw[:3] == b"\xff\xd8\xff":
        return "JPEG"
    if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return "WEBP"
    return None


def inspect(raw: bytes) -> Inspection:
    """准入检查。不抛异常，返回结构化结论。"""
    issues: list[Issue] = []
    warnings: list[str] = []

    if len(raw) == 0:
        return Inspection(None, [Issue(Code.unreadable, "空文件")])
    if len(raw) > MAX_BYTES:
        return Inspection(None, [Issue(Code.too_large, f"超过 {MAX_BYTES // 1024 // 1024} MB")])

    fmt = _sniff(raw)
    if fmt is None:
        return Inspection(None, [Issue(Code.bad_format, "仅支持 PNG / JPEG / WebP，请确认不是改了扩展名的其他文件")])

    try:
        with Image.open(io.BytesIO(raw)) as im:
            width, height = im.size
            mode = im.mode
    except (UnidentifiedImageError, OSError):
        return Inspection(None, [Issue(Code.unreadable, "图片无法解析，可能已损坏")])

    if width * height > MAX_PIXELS:
        issues.append(Issue(Code.too_many_pixels, f"像素总数 {width * height:,} 超过上限"))
    long_side = max(width, height)
    if long_side < MIN_LONG_SIDE:
        issues.append(Issue(Code.too_small, f"长边 {long_side}px 低于 {MIN_LONG_SIDE}px，小字将无法识别，请重拍或重新截图"))
    if long_side > MAX_LONG_SIDE:
        warnings.append(f"长边 {long_side}px 超过 {MAX_LONG_SIDE}px，将等比缩小")
    aspect = width / height if height else 0
    if not (MIN_ASPECT <= aspect <= MAX_ASPECT):
        issues.append(Issue(Code.bad_aspect, f"长宽比 {aspect:.2f} 异常，疑似被截断"))

    info = ImageInfo(format=fmt, width=width, height=height, mode=mode, bytes=len(raw),
                     sha256=hashlib.sha256(raw).hexdigest())
    return Inspection(info, issues, warnings)


def normalize(raw: bytes) -> tuple[bytes, ImageInfo]:
    """剥离 EXIF、统一色彩模式、必要时缩小，重新编码。

    返回 (新字节, 新信息)。调用前应先通过 inspect()。
    """
    with Image.open(io.BytesIO(raw)) as im:
        im = ImageOps.exif_transpose(im)  # 按 EXIF 方向摆正，再丢弃 EXIF
        if im.mode not in ("RGB", "L"):
            im = im.convert("RGB")

        long_side = max(im.size)
        if long_side > MAX_LONG_SIDE:
            ratio = MAX_LONG_SIDE / long_side
            im = im.resize((round(im.width * ratio), round(im.height * ratio)), Image.LANCZOS)

        buf = io.BytesIO()
        if im.mode == "L":
            im.save(buf, format="PNG", optimize=True)
            fmt = "PNG"
        else:
            # 统一存 PNG：无损，避免二次压缩把小字糊掉；体积由尺寸上限控制
            im.save(buf, format="PNG", optimize=True)
            fmt = "PNG"
        out = buf.getvalue()

    info = ImageInfo(format=fmt, width=im.width, height=im.height, mode=im.mode,
                     bytes=len(out), sha256=hashlib.sha256(out).hexdigest())
    return out, info
