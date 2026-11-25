"""Pixel transforms and deterministic Pillow operators for BGRA8 ring frames."""

import base64
import math
from dataclasses import dataclass
from io import BytesIO
from typing import Literal

from PIL import Image, ImageChops, ImageDraw, ImageFont, ImageStat

from bellis_game.io.frame_ring import RingFrame
from bellis_game.io.protocol import NormRect


@dataclass(frozen=True, slots=True)
class PixelRect:
    left: int
    top: int
    right: int
    bottom: int

    def __post_init__(self) -> None:
        if not all(type(v) is int for v in (self.left, self.top, self.right, self.bottom)):
            raise ValueError("pixel bounds must be integers")
        if not (0 <= self.left < self.right and 0 <= self.top < self.bottom):
            raise ValueError("invalid pixel bounds")


def _unit(v: float) -> bool:
    return type(v) in (int, float) and 0 <= v <= 1


def valid_norm_rect(rect: NormRect) -> bool:
    bounds = (rect.left, rect.top, rect.right, rect.bottom)
    return all(map(_unit, bounds)) and rect.left < rect.right and rect.top < rect.bottom


def _positive(v: int) -> bool:
    return type(v) is int and v >= 1


def norm_rect_to_pixels(rect: NormRect, width: int, height: int) -> PixelRect:
    """Round outward to cover every pixel touched by the normalized rectangle."""
    if not (_positive(width) and _positive(height) and valid_norm_rect(rect)):
        raise ValueError("invalid rectangle or source dimensions")
    left, top = math.floor(rect.left * width), math.floor(rect.top * height)
    return PixelRect(left, top, math.ceil(rect.right * width), math.ceil(rect.bottom * height))


@dataclass(frozen=True, slots=True)
class FrameTransform:
    frame_number: int
    capture_ns: int
    transform_version: int
    source_width: int
    source_height: int
    crop: PixelRect
    encoded_width: int
    encoded_height: int

    def __post_init__(self) -> None:
        dims = (self.source_width, self.source_height, self.encoded_width, self.encoded_height)
        if not all(map(_positive, dims)):
            raise ValueError("invalid transform dimensions")
        if self.crop.right > self.source_width or self.crop.bottom > self.source_height:
            raise ValueError("crop exceeds source dimensions")

    def norm_to_client(self, nx: float, ny: float) -> tuple[int, int]:
        if not (_unit(nx) and _unit(ny)):
            raise ValueError("expected normalized coordinates in [0, 1]")
        c = self.crop
        return (
            min(c.right - 1, c.left + int(nx * (c.right - c.left))),
            min(c.bottom - 1, c.top + int(ny * (c.bottom - c.top))),
        )

    def client_to_norm(self, x: int, y: int) -> tuple[float, float]:
        c = self.crop
        inside = c.left <= x < c.right and c.top <= y < c.bottom
        if type(x) is not int or type(y) is not int or not inside:
            raise ValueError("expected integer coordinates inside crop")

        def lower_edge(offset: int, size: int) -> float:
            value = offset / size
            # Keep the normalized edge inside its pixel even after floating-point rounding.
            return math.nextafter(value, 1.0) if value * size < offset else value

        return lower_edge(x - c.left, c.right - c.left), lower_edge(y - c.top, c.bottom - c.top)


@dataclass(frozen=True, slots=True)
class EncodedFrame:
    transform: FrameTransform
    media_type: str
    data: bytes
    base64_data: str

    @property
    def data_url(self) -> str:
        return f"data:{self.media_type};base64,{self.base64_data}"


def ring_frame_to_rgb(frame: RingFrame) -> Image.Image:
    w, h, stride = frame.width, frame.height, frame.row_stride
    if not (_positive(w) and _positive(h) and type(stride) is int and stride >= w * 4):
        raise ValueError("invalid BGRA8 dimensions or row stride")
    if len(frame.pixels) != stride * h:
        raise ValueError("BGRA8 buffer length does not match row stride and height")
    return Image.frombytes("RGB", (w, h), frame.pixels, "raw", "BGRX", stride, 1)


def _region(
    frame: RingFrame, roi: NormRect | None, edge: int | None = None
) -> tuple[Image.Image, PixelRect]:
    image = ring_frame_to_rgb(frame)
    c = PixelRect(0, 0, *image.size) if roi is None else norm_rect_to_pixels(roi, *image.size)
    if roi is not None:
        image = image.crop((c.left, c.top, c.right, c.bottom))
    if edge is not None:
        if not _positive(edge):
            raise ValueError("long edge must be a positive integer")
        image.thumbnail((edge, edge), Image.Resampling.BOX)
    return image, c


def _draw_grid(image: Image.Image) -> Image.Image:
    w, h = image.size
    overlay = Image.new("RGBA", image.size)
    draw = ImageDraw.Draw(overlay)
    minor = (190, 245, 255, 45)
    major = (190, 245, 255, 105)
    for i in range(1, 20, 2):
        x, y = i * w // 20, i * h // 20
        draw.line((x, 0, x, h - 1), fill=minor)
        draw.line((0, y, w - 1, y), fill=minor)
    ticks = [(i * w // 10, i * h // 10, f"0.{i}") for i in range(1, 10)]
    for x, y, _ in ticks:
        draw.line((x, 0, x, h - 1), fill=major)
        draw.line((0, y, w - 1, y), fill=major)

    font = ImageFont.load_default_imagefont()

    def pill(text: str, opacity: int) -> Image.Image:
        left, top, right, bottom = font.getbbox(text)
        label = Image.new("RGBA", (right - left + 4, bottom - top + 2))
        pen = ImageDraw.Draw(label)
        pen.rounded_rectangle((0, 0, label.width - 1, label.height - 1), 2, fill=(0, 0, 0, opacity))
        pen.text((2 - left, 1 - top), text, fill="white", font=font)
        return label

    if min(w, h) >= 320:
        for i in (2, 4, 6, 8):
            for j in (2, 4, 6, 8):
                tag = pill(f".{i},.{j}", 130)
                overlay.paste(tag, (i * w // 10 - tag.width // 2, j * h // 10 - tag.height // 2))

    for x, y, text in ticks:
        label = pill(text, 165)
        label.thumbnail((w // 10, h // 16), Image.Resampling.LANCZOS)
        lw, lh = label.size
        for pos in (
            (x - lw // 2, 0),
            (x - lw // 2, h - lh),
            (0, y - lh // 2),
            (w - lw, y - lh // 2),
        ):
            overlay.paste(label, pos)
    return Image.alpha_composite(image.convert("RGBA"), overlay).convert("RGB")


def encode_frame(
    frame: RingFrame,
    *,
    max_long_edge: int = 1024,
    crop: NormRect | None = None,
    image_format: Literal["jpeg", "png"] = "jpeg",
    jpeg_quality: int = 85,
    overlay_grid: bool = False,
) -> EncodedFrame:
    valid_quality = type(jpeg_quality) is int and 1 <= jpeg_quality <= 100
    if image_format not in ("jpeg", "png") or not valid_quality:
        raise ValueError("invalid image format or JPEG quality")
    image, pixels = _region(frame, crop, max_long_edge)
    if overlay_grid and min(image.size) >= 64:
        image = _draw_grid(image)
    buf = BytesIO()
    options = {"quality": jpeg_quality} if image_format == "jpeg" else {}
    image.save(buf, format=image_format, **options)
    data = buf.getvalue()
    transform = FrameTransform(
        frame.frame_number, frame.capture_ns, frame.transform_version,
        frame.width, frame.height, pixels, *image.size,
    )  # fmt: skip
    encoded = base64.b64encode(data).decode("ascii")
    return EncodedFrame(transform, f"image/{image_format}", data, encoded)


@dataclass(frozen=True, slots=True)
class FrameDiff:
    changed_ratio: float
    mean_abs_diff: float
    sample_width: int
    sample_height: int


def frame_diff(
    before: RingFrame,
    after: RingFrame,
    *,
    roi: NormRect | None = None,
    sample_long_edge: int = 160,
    channel_threshold: int = 12,
) -> FrameDiff:
    """Count pixels whose largest absolute channel difference exceeds the threshold."""
    if type(channel_threshold) is not int or not 0 <= channel_threshold <= 255:
        raise ValueError("channel threshold must be an integer in [0, 255]")
    if (before.width, before.height) != (after.width, after.height):
        return FrameDiff(1.0, 255.0, 0, 0)
    first, last = (_region(f, roi, sample_long_edge)[0] for f in (before, after))
    diff = ImageChops.difference(first, last)
    r, g, b = diff.split()
    histogram = ImageChops.lighter(ImageChops.lighter(r, g), b).histogram()
    ratio = sum(histogram[channel_threshold + 1 :]) / (diff.width * diff.height)
    return FrameDiff(ratio, sum(ImageStat.Stat(diff).mean) / 3, *diff.size)


def match_template_patch(
    frame: RingFrame,
    template_bytes: bytes,
    *,
    roi: NormRect | None = None,
    sample_size: tuple[int, int] = (32, 32),
) -> float:
    """Compare the entire ROI with a template at a common grayscale sample size."""
    if len(sample_size) != 2 or not all(_positive(v) for v in sample_size):
        raise ValueError("invalid patch sample dimensions")
    region, _ = _region(frame, roi)
    with Image.open(BytesIO(template_bytes)) as template:
        gray = (im.convert("L") for im in (region, template))
        # Pillow's size annotation also supports optional NumPy arrays.
        a, b = (im.resize(sample_size, Image.Resampling.BOX) for im in gray)  # pyright: ignore[reportUnknownMemberType]
    return 1.0 - ImageStat.Stat(ImageChops.difference(a, b)).mean[0] / 255
