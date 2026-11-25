"""Shared-memory frame ring layout and x86-64 seqlock reader aligned with ``ring_layout.json``."""

from __future__ import annotations

import ctypes
import platform
import time
from dataclasses import dataclass
from types import TracebackType
from typing import ClassVar, Final, Self

from .protocol import FrameRingAttachParams
from .shm import SharedMemory, create_shared_memory, shared_memory_name

MAGIC: Final = int.from_bytes(b"BGRTRING", "little")
LAYOUT_VERSION: Final = 1
SLOTS_OFFSET: Final = 64
SLOT_PIXELS_OFFSET: Final = 64
SLOT_ALIGN: Final = 64
PIXEL_FORMAT_BGRA8: Final = 1
DEFAULT_SLOT_COUNT: Final = 3
DEFAULT_READ_ATTEMPTS: Final = 8
BYTES_PER_PIXEL: Final = 4
MAX_DIMENSION: Final = 0xFFFFFFFF
_SUPPORTED_MACHINES = frozenset({"amd64", "x86_64"})


class FrameRingHeader(ctypes.Structure):
    _fields_ = (
        ("magic", ctypes.c_uint64),
        ("layout_version", ctypes.c_uint32),
        ("slot_count", ctypes.c_uint32),
        ("slot_stride", ctypes.c_uint64),
        ("max_width", ctypes.c_uint32),
        ("max_height", ctypes.c_uint32),
        ("write_seq", ctypes.c_uint64),
    )
    magic: int
    layout_version: int
    slot_count: int
    slot_stride: int
    max_width: int
    max_height: int
    write_seq: int


class FrameSlotHeader(ctypes.Structure):
    _fields_ = (
        ("seq", ctypes.c_uint64),
        ("frame_number", ctypes.c_uint64),
        ("capture_ns", ctypes.c_uint64),
        ("transform_version", ctypes.c_uint64),
        ("width", ctypes.c_uint32),
        ("height", ctypes.c_uint32),
        ("row_stride", ctypes.c_uint32),
        ("pixel_format", ctypes.c_uint32),
    )
    seq: int
    frame_number: int
    capture_ns: int
    transform_version: int
    width: int
    height: int
    row_stride: int
    pixel_format: int


class FrameRingError(Exception):
    pass


class FrameRingTornError(FrameRingError):
    pass


class FrameRingCorruptError(FrameRingError):
    pass


@dataclass(frozen=True, slots=True)
class RingFrame:
    frame_number: int
    capture_ns: int
    transform_version: int
    width: int
    height: int
    row_stride: int
    pixels: bytes


def frame_age_ns(capture_ns: int, now_ns: int | None = None) -> int:
    now = time.perf_counter_ns() if now_ns is None else now_ns
    return max(0, now - capture_ns)


def slot_stride_for(max_width: int, max_height: int) -> int:
    needed = SLOT_PIXELS_OFFSET + max_width * max_height * BYTES_PER_PIXEL
    return -(-needed // SLOT_ALIGN) * SLOT_ALIGN


@dataclass
class _Views:
    header: FrameRingHeader
    slots: list[FrameSlotHeader]


class FrameRing:
    NAME_KIND: ClassVar[str] = "frames"

    def __init__(
        self,
        memory: SharedMemory,
        *,
        slot_count: int,
        slot_stride: int,
        max_width: int,
        max_height: int,
    ) -> None:
        self._memory = memory
        self.slot_count = slot_count
        self.slot_stride = slot_stride
        self.max_width = max_width
        self.max_height = max_height
        buf = memory.buffer
        hdr = FrameRingHeader.from_buffer(buf, 0)
        hdr.layout_version = LAYOUT_VERSION
        hdr.slot_count = slot_count
        hdr.slot_stride = slot_stride
        hdr.max_width = max_width
        hdr.max_height = max_height
        hdr.write_seq = 0
        hdr.magic = MAGIC
        slots = [
            FrameSlotHeader.from_buffer(buf, SLOTS_OFFSET + i * slot_stride)
            for i in range(slot_count)
        ]
        self._views: _Views | None = _Views(hdr, slots)

    @classmethod
    def create(
        cls, max_width: int, max_height: int, *, slot_count: int = DEFAULT_SLOT_COUNT
    ) -> Self:
        if platform.machine().lower() not in _SUPPORTED_MACHINES:
            raise FrameRingError(f"FrameRing requires x86-64, got {platform.machine()}")
        if not (1 <= max_width <= MAX_DIMENSION and 1 <= max_height <= MAX_DIMENSION):
            raise ValueError(f"invalid dimensions: {max_width}x{max_height}")
        if not 2 <= slot_count <= MAX_DIMENSION:
            raise ValueError(f"slot_count out of range: {slot_count}")
        stride = slot_stride_for(max_width, max_height)
        mem = create_shared_memory(
            shared_memory_name(cls.NAME_KIND), SLOTS_OFFSET + slot_count * stride
        )
        try:
            return cls(
                mem,
                slot_count=slot_count,
                slot_stride=stride,
                max_width=max_width,
                max_height=max_height,
            )
        except BaseException:
            mem.close()
            raise

    @property
    def name(self) -> str:
        return self._memory.name

    @property
    def size_bytes(self) -> int:
        return self._memory.size

    @property
    def closed(self) -> bool:
        return self._views is None

    def attach_params(self) -> FrameRingAttachParams:
        return FrameRingAttachParams(
            name=self.name,
            size_bytes=self.size_bytes,
            layout_version=LAYOUT_VERSION,
            slot_count=self.slot_count,
            slot_stride=self.slot_stride,
            max_width=self.max_width,
            max_height=self.max_height,
        )

    def latest_frame_number(self) -> int:
        return self._open_views().header.write_seq

    def read_latest(self, *, max_attempts: int = DEFAULT_READ_ATTEMPTS) -> RingFrame | None:
        if max_attempts < 1:
            raise ValueError(f"max_attempts must be >= 1, got {max_attempts}")
        views = self._open_views()
        cap = self.slot_stride - SLOT_PIXELS_OFFSET
        for _ in range(max_attempts):
            num = views.header.write_seq
            if num == 0:
                return None
            slot = (num - 1) % self.slot_count
            live = views.slots[slot]
            before = live.seq
            if before & 1:
                continue
            start = SLOTS_OFFSET + slot * self.slot_stride
            hdr = FrameSlotHeader.from_buffer_copy(self._memory.buffer, start)
            if hdr.frame_number != num:
                continue
            err = self._check_slot(hdr, cap)
            if err is not None:
                if live.seq != before:
                    continue
                raise FrameRingCorruptError(f"slot {slot} frame {num}: {err}")
            p_start = start + SLOT_PIXELS_OFFSET
            pixels = self._memory.buffer[p_start : p_start + hdr.row_stride * hdr.height]
            if live.seq != before:
                continue
            return RingFrame(
                num,
                hdr.capture_ns,
                hdr.transform_version,
                hdr.width,
                hdr.height,
                hdr.row_stride,
                pixels,
            )
        raise FrameRingTornError(f"frame ring torn for {max_attempts} attempts")

    def close(self) -> None:
        if self._views is None:
            return
        self._views = None
        self._memory.close()

    def __enter__(self) -> Self:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        self.close()

    def _open_views(self) -> _Views:
        if self._views is None:
            raise FrameRingError(f"frame ring closed: {self.name}")
        return self._views

    def _check_slot(self, hdr: FrameSlotHeader, cap: int) -> str | None:
        if hdr.pixel_format != PIXEL_FORMAT_BGRA8:
            return f"pixel_format {hdr.pixel_format} != BGRA8"
        if hdr.width > self.max_width or hdr.height > self.max_height:
            return f"{hdr.width}x{hdr.height} exceeds {self.max_width}x{self.max_height}"
        if hdr.row_stride < hdr.width * BYTES_PER_PIXEL or hdr.row_stride * hdr.height > cap:
            return f"invalid row_stride {hdr.row_stride} for height {hdr.height}"
        return None
