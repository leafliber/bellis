"""Shared-memory audio ring layout and x86-64 seqlock reader aligned with ``ring_layout.json``."""

from __future__ import annotations

import ctypes
import platform
from dataclasses import dataclass
from types import TracebackType
from typing import ClassVar, Final, Self

from .protocol import AudioRingAttachParams
from .shm import SharedMemory, create_shared_memory, shared_memory_name

MAGIC: Final = int.from_bytes(b"BGRAUDIO", "little")
LAYOUT_VERSION: Final = 1
BLOCKS_OFFSET: Final = 64
BLOCK_SAMPLES_OFFSET: Final = 64
BLOCK_ALIGN: Final = 64
SAMPLE_FORMAT_F32: Final = 1
BYTES_PER_VALUE: Final = 4
MAX_CHANNELS: Final = 2
MIN_SAMPLE_RATE: Final = 8_000
MAX_SAMPLE_RATE: Final = 192_000
FLAG_DISCONTINUITY: Final = 1
KNOWN_FLAGS: Final = FLAG_DISCONTINUITY
DEFAULT_READ_ATTEMPTS: Final = 8
MAX_U32: Final = 0xFFFFFFFF
_SUPPORTED_MACHINES = frozenset({"amd64", "x86_64"})


class AudioRingHeader(ctypes.Structure):
    _fields_ = (
        ("magic", ctypes.c_uint64),
        ("layout_version", ctypes.c_uint32),
        ("block_count", ctypes.c_uint32),
        ("block_stride", ctypes.c_uint64),
        ("block_capacity", ctypes.c_uint32),
        ("sample_rate", ctypes.c_uint32),
        ("channels", ctypes.c_uint32),
        ("sample_format", ctypes.c_uint32),
        ("write_seq", ctypes.c_uint64),
    )
    magic: int
    layout_version: int
    block_count: int
    block_stride: int
    block_capacity: int
    sample_rate: int
    channels: int
    sample_format: int
    write_seq: int


class AudioBlockHeader(ctypes.Structure):
    _fields_ = (
        ("seq", ctypes.c_uint64),
        ("block_number", ctypes.c_uint64),
        ("capture_ns", ctypes.c_uint64),
        ("sample_count", ctypes.c_uint32),
        ("flags", ctypes.c_uint32),
    )
    seq: int
    block_number: int
    capture_ns: int
    sample_count: int
    flags: int


class AudioRingError(Exception):
    pass


class AudioRingTornError(AudioRingError):
    pass


class AudioRingCorruptError(AudioRingError):
    pass


@dataclass(frozen=True, slots=True)
class AudioBlock:
    block_number: int
    capture_ns: int
    sample_count: int
    discontinuity: bool
    samples: bytes


@dataclass(frozen=True, slots=True)
class AudioRead:
    sample_rate: int
    channels: int
    blocks: tuple[AudioBlock, ...]

    def duration_ns(self, sample_count: int) -> int:
        return sample_count * 1_000_000_000 // self.sample_rate


def block_stride_for(block_capacity: int, channels: int) -> int:
    needed = BLOCK_SAMPLES_OFFSET + block_capacity * channels * BYTES_PER_VALUE
    return -(-needed // BLOCK_ALIGN) * BLOCK_ALIGN


@dataclass
class _Views:
    header: AudioRingHeader
    blocks: list[AudioBlockHeader]


class AudioRing:
    NAME_KIND: ClassVar[str] = "audio"

    def __init__(
        self,
        memory: SharedMemory,
        *,
        sample_rate: int,
        channels: int,
        block_capacity: int,
        block_count: int,
        block_stride: int,
    ) -> None:
        self._memory = memory
        self.sample_rate = sample_rate
        self.channels = channels
        self.block_capacity = block_capacity
        self.block_count = block_count
        self.block_stride = block_stride
        buf = memory.buffer
        hdr = AudioRingHeader.from_buffer(buf, 0)
        hdr.layout_version = LAYOUT_VERSION
        hdr.block_count = block_count
        hdr.block_stride = block_stride
        hdr.block_capacity = block_capacity
        hdr.sample_rate = sample_rate
        hdr.channels = channels
        hdr.sample_format = SAMPLE_FORMAT_F32
        hdr.write_seq = 0
        hdr.magic = MAGIC
        blocks = [
            AudioBlockHeader.from_buffer(buf, BLOCKS_OFFSET + i * block_stride)
            for i in range(block_count)
        ]
        self._views: _Views | None = _Views(hdr, blocks)

    @classmethod
    def create(
        cls, sample_rate: int, channels: int, *, block_capacity: int, block_count: int
    ) -> Self:
        if platform.machine().lower() not in _SUPPORTED_MACHINES:
            raise AudioRingError(f"AudioRing requires x86-64, got {platform.machine()}")
        if not MIN_SAMPLE_RATE <= sample_rate <= MAX_SAMPLE_RATE:
            raise ValueError(f"sample_rate out of range: {sample_rate}")
        if not 1 <= channels <= MAX_CHANNELS:
            raise ValueError(f"channels out of range: {channels}")
        if not (1 <= block_capacity <= MAX_U32 and 2 <= block_count <= MAX_U32):
            raise ValueError("block_capacity/block_count out of range")
        stride = block_stride_for(block_capacity, channels)
        mem = create_shared_memory(
            shared_memory_name(cls.NAME_KIND), BLOCKS_OFFSET + block_count * stride
        )
        try:
            return cls(
                mem,
                sample_rate=sample_rate,
                channels=channels,
                block_capacity=block_capacity,
                block_count=block_count,
                block_stride=stride,
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

    def attach_params(self) -> AudioRingAttachParams:
        return AudioRingAttachParams(
            name=self.name,
            size_bytes=self.size_bytes,
            layout_version=LAYOUT_VERSION,
            block_count=self.block_count,
            block_stride=self.block_stride,
            block_capacity=self.block_capacity,
            sample_rate=self.sample_rate,
            channels=self.channels,
            sample_format=SAMPLE_FORMAT_F32,
        )

    def latest_block_number(self) -> int:
        return self._open_views().header.write_seq

    def read_recent(
        self, duration_ns: int, *, after: int = 0, max_attempts: int = DEFAULT_READ_ATTEMPTS
    ) -> AudioRead:
        if duration_ns < 0 or after < 0 or max_attempts < 1:
            raise ValueError("invalid duration_ns, after, or max_attempts")
        views = self._open_views()
        for _ in range(max_attempts):
            latest = views.header.write_seq
            if latest <= after:
                return AudioRead(self.sample_rate, self.channels, ())
            oldest = max(after + 1, latest - self.block_count + 1)
            blocks: list[AudioBlock] = []
            total = 0
            for number in range(latest, oldest - 1, -1):
                blk = self._read_block(views, number)
                if blk is None:
                    break
                blocks.append(blk)
                total += blk.sample_count * 1_000_000_000 // self.sample_rate
                if total >= duration_ns:
                    break
            if blocks and blocks[0].block_number == latest:
                blocks.reverse()
                return AudioRead(self.sample_rate, self.channels, tuple(blocks))
        raise AudioRingTornError(f"audio ring torn for {max_attempts} attempts")

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
            raise AudioRingError(f"audio ring closed: {self.name}")
        return self._views

    def _read_block(self, views: _Views, number: int) -> AudioBlock | None:
        slot = (number - 1) % self.block_count
        live = views.blocks[slot]
        before = live.seq
        if before & 1:
            return None
        start = BLOCKS_OFFSET + slot * self.block_stride
        hdr = AudioBlockHeader.from_buffer_copy(self._memory.buffer, start)
        if hdr.block_number != number:
            return None
        if not 1 <= hdr.sample_count <= self.block_capacity or (hdr.flags & ~KNOWN_FLAGS):
            if live.seq != before:
                return None
            raise AudioRingCorruptError(f"slot {slot} block {number}: corrupt metadata")
        s_start = start + BLOCK_SAMPLES_OFFSET
        n_bytes = hdr.sample_count * self.channels * BYTES_PER_VALUE
        samples = self._memory.buffer[s_start : s_start + n_bytes]
        if live.seq != before:
            return None
        return AudioBlock(
            number, hdr.capture_ns, hdr.sample_count, bool(hdr.flags & FLAG_DISCONTINUITY), samples
        )
