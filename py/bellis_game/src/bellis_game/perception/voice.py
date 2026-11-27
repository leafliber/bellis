"""Game voice activity detection via Silero VAD v6.2 ONNX on the shared AudioRing."""

# pyright: reportMissingTypeStubs=false, reportUnknownMemberType=false
# pyright: reportUnknownVariableType=false, reportUnknownArgumentType=false

from __future__ import annotations

import asyncio
import hashlib
import math
import os
import sys
import tempfile
import urllib.request
from collections.abc import Callable, Sequence
from contextlib import suppress
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from time import perf_counter_ns
from typing import Final, Protocol

import numpy as np
import onnxruntime as ort
from numpy.typing import NDArray

from bellis_game.io import AudioBlock, AudioRead, AudioRingError, AudioRingTornError

SILERO_VAD_VERSION: Final = "v6.2"
SILERO_VAD_FILE: Final = "silero_vad.onnx"
SILERO_VAD_SHA256: Final = "1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3"
SILERO_VAD_SIZE: Final = 2_327_524
SILERO_VAD_URL: Final = (
    "https://raw.githubusercontent.com/snakers4/silero-vad/v6.2/src/silero_vad/data/silero_vad.onnx"
)
SAMPLE_RATE: Final = 16_000
FRAME_SIZE: Final = 512
CONTEXT_SIZE: Final = 64
STATE_SHAPE: Final = (2, 1, 128)
_INPUTS: Final = frozenset({"input", "state", "sr"})
_OUTPUTS: Final = ("output", "stateN")
_ZERO_CROSSINGS: Final = 16
_ROLLOFF: Final = 0.9
_KAISER_BETA: Final = 8.0

type Float32Array = NDArray[np.float32]
type Float64Array = NDArray[np.float64]


class VoiceState(StrEnum):
    BUSY = "busy"
    IDLE = "idle"
    UNKNOWN = "unknown"


@dataclass(frozen=True, slots=True)
class VoiceParams:
    onset: float = 0.5
    offset: float = 0.35
    min_speech: float = 0.1
    min_silence: float = 0.5
    stall_timeout_s: float = 1.5
    poll_interval_s: float = 0.05

    def __post_init__(self) -> None:
        if not 0.0 < self.offset <= self.onset <= 1.0:
            raise ValueError("expected 0 < offset <= onset <= 1")
        times = (self.min_speech, self.min_silence, self.stall_timeout_s, self.poll_interval_s)
        if not all(math.isfinite(v) and v > 0.0 for v in times):
            raise ValueError("voice timing parameters must be finite and positive")

    def frames_for(self, seconds: float, frame_size: int, sample_rate: int) -> int:
        return max(1, -(-round(seconds * sample_rate) // frame_size))


@dataclass(frozen=True, slots=True)
class VoiceSnapshot:
    state: VoiceState
    reason: str = ""
    since_ns: int | None = None
    processed_ns: int | None = None


class SpeechModel(Protocol):
    @property
    def sample_rate(self) -> int: ...
    @property
    def frame_size(self) -> int: ...
    def reset(self) -> None: ...
    def probability(self, frame: Float32Array) -> float: ...


class AudioReader(Protocol):
    def read_recent(self, duration_ns: int, *, after: int = 0) -> AudioRead: ...


def default_vad_model_path() -> Path:
    base = Path(os.getenv("LOCALAPPDATA") or tempfile.gettempdir())
    return base / "Bellis" / "models" / SILERO_VAD_FILE


def verify_vad_model(
    path: Path,
    *,
    expected_sha256: str = SILERO_VAD_SHA256,
    expected_size: int = SILERO_VAD_SIZE,
) -> Path:
    if not path.is_file():
        raise FileNotFoundError(f"VAD model not found: {path}")
    size = path.stat().st_size
    if size != expected_size:
        raise ValueError(f"VAD model size mismatch: expected {expected_size}, got {size}")
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(65536), b""):
            digest.update(chunk)
    actual = digest.hexdigest()
    if actual != expected_sha256:
        raise ValueError(f"VAD model sha256 mismatch: expected {expected_sha256}, got {actual}")
    return path


def fetch_silero_vad(dest: Path | None = None, *, timeout_s: float = 60.0) -> Path:
    target = default_vad_model_path() if dest is None else dest
    if target.is_file():
        with suppress(ValueError):
            return verify_vad_model(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    part = target.with_suffix(target.suffix + ".part")
    try:
        with (
            urllib.request.urlopen(SILERO_VAD_URL, timeout=timeout_s) as resp,
            part.open("wb") as out,
        ):
            while chunk := resp.read(65536):
                out.write(chunk)
        verify_vad_model(part)
        os.replace(part, target)
    except BaseException:
        with suppress(OSError):
            part.unlink()
        raise
    return target


class SileroVad:
    """Single-threaded CPU Silero VAD v6.2 ONNX inference."""

    def __init__(self, path: Path) -> None:
        if not path.is_file():
            raise FileNotFoundError(f"VAD model not found: {path}")
        options = ort.SessionOptions()
        options.log_severity_level = 3
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        options.intra_op_num_threads = 1
        options.inter_op_num_threads = 1
        session = ort.InferenceSession(
            str(path), sess_options=options, providers=["CPUExecutionProvider"]
        )
        inputs = frozenset(str(item.name) for item in session.get_inputs())
        outputs = frozenset(str(item.name) for item in session.get_outputs())
        if inputs != _INPUTS or not outputs >= frozenset(_OUTPUTS):
            raise ValueError(f"unexpected Silero VAD ONNX interface: {sorted(inputs)}")
        self.path, self._session = path, session
        self._rate = np.array(SAMPLE_RATE, dtype=np.int64)
        self._state: Float32Array = np.zeros(STATE_SHAPE, dtype=np.float32)
        self._context: Float32Array = np.zeros((1, CONTEXT_SIZE), dtype=np.float32)

    @property
    def sample_rate(self) -> int:
        return SAMPLE_RATE

    @property
    def frame_size(self) -> int:
        return FRAME_SIZE

    def reset(self) -> None:
        self._state = np.zeros(STATE_SHAPE, dtype=np.float32)
        self._context = np.zeros((1, CONTEXT_SIZE), dtype=np.float32)

    def probability(self, frame: Float32Array) -> float:
        if frame.shape != (FRAME_SIZE,):
            raise ValueError(f"expected {FRAME_SIZE} samples, got {frame.shape}")
        x = np.concatenate((self._context, frame.astype(np.float32)[None, :]), axis=1)
        output, state = self._session.run(
            list(_OUTPUTS), {"input": x, "state": self._state, "sr": self._rate}
        )
        self._state = np.asarray(state, dtype=np.float32)
        self._context = x[:, -CONTEXT_SIZE:]
        return float(np.asarray(output, dtype=np.float32)[0, 0])


def _kaiser(x: Float64Array) -> Float64Array:
    window = np.i0(_KAISER_BETA * np.sqrt(np.clip(1.0 - x * x, 0.0, None))) / np.i0(_KAISER_BETA)
    return np.where(np.abs(x) <= 1.0, window, 0.0)


class Resampler:
    """Streaming rational-ratio Kaiser-windowed sinc polyphase resampler."""

    def __init__(self, rate_in: int, rate_out: int) -> None:
        if rate_in < 1 or rate_out < 1:
            raise ValueError("sample rates must be positive")
        divisor = math.gcd(rate_in, rate_out)
        self.up, self.down = rate_out // divisor, rate_in // divisor
        cutoff = _ROLLOFF * min(rate_in, rate_out) / 2 / rate_in
        self.half = math.ceil(_ZERO_CROSSINGS / (2 * cutoff))
        self._offsets = np.arange(-self.half + 1, self.half + 1, dtype=np.int64)
        phases = np.arange(self.up, dtype=np.float64)[:, None] / self.up
        tau = self._offsets[None, :].astype(np.float64) - phases
        kernel = 2 * cutoff * np.sinc(2 * cutoff * tau) * _kaiser(tau / self.half)
        self._table: Float64Array = kernel / kernel.sum(axis=1, keepdims=True)
        self._buffer: Float64Array = np.zeros(self.half, dtype=np.float64)
        self._start, self._next = -self.half, 0

    def push(self, samples: Float64Array) -> Float64Array:
        buffer = np.concatenate((self._buffer, samples))
        last = ((self._start + len(buffer) - self.half) * self.up - 1) // self.down
        if last < self._next:
            self._buffer = buffer
            return np.zeros(0, dtype=np.float64)
        positions = np.arange(self._next, last + 1, dtype=np.int64) * self.down
        index = (positions // self.up - self._start)[:, None] + self._offsets[None, :]
        out: Float64Array = np.einsum("ij,ij->i", buffer[index], self._table[positions % self.up])
        self._next = last + 1
        keep = (self._next * self.down) // self.up - self.half + 1
        self._buffer, self._start = buffer[keep - self._start :], keep
        return out


@dataclass(frozen=True, slots=True)
class AudioFrame:
    samples: Float32Array
    start_ns: int
    end_ns: int


class AudioFrontend:
    """Downmix F32 audio blocks to mono, resample to target rate, and chunk into frames."""

    def __init__(self, sample_rate: int, channels: int, *, rate: int, frame_size: int) -> None:
        if channels < 1 or frame_size < 1:
            raise ValueError("channels and frame_size must be positive")
        self.sample_rate, self.channels = sample_rate, channels
        self._rate, self._frame_size = rate, frame_size
        self._resampler = None if sample_rate == rate else Resampler(sample_rate, rate)
        self._pending: Float32Array = np.zeros(0, dtype=np.float32)
        self._frames = self._received = 0
        self._anchors: list[tuple[int, int]] = []

    def push(self, block: AudioBlock) -> list[AudioFrame]:
        values = np.frombuffer(block.samples, dtype=np.float32)
        if block.sample_count < 1 or len(values) != block.sample_count * self.channels:
            raise ValueError(f"block {block.block_number} sample count mismatch")
        mono = np.nan_to_num(
            values.reshape(-1, self.channels).mean(axis=1, dtype=np.float64),
            nan=0.0,
            posinf=0.0,
            neginf=0.0,
        )
        self._anchors.append((self._received, block.capture_ns))
        self._received += block.sample_count
        out = mono if self._resampler is None else self._resampler.push(mono)
        pending = np.concatenate((self._pending, out.astype(np.float32)))
        size = self._frame_size
        count = len(pending) // size
        frames = [
            AudioFrame(
                np.ascontiguousarray(pending[i * size : (i + 1) * size]),
                self._time((self._frames + i) * size),
                self._time((self._frames + i + 1) * size),
            )
            for i in range(count)
        ]
        self._frames += count
        self._pending = pending[count * size :]
        scaled = self._frames * self._frame_size * self.sample_rate
        while len(self._anchors) >= 2 and self._anchors[1][0] * self._rate <= scaled:
            del self._anchors[0]
        return frames

    def _time(self, k: int) -> int:
        scaled = k * self.sample_rate
        start, ns = self._anchors[0]
        for anchor in reversed(self._anchors):
            if anchor[0] * self._rate <= scaled:
                start, ns = anchor
                break
        return ns + (scaled - start * self._rate) * 1_000_000_000 // (self._rate * self.sample_rate)


class VoiceHysteresis:
    """Frame-level onset/offset hysteresis turning speech probabilities into busy/idle/unknown."""

    def __init__(self, params: VoiceParams, *, frame_size: int, sample_rate: int) -> None:
        self._onset, self._offset = params.onset, params.offset
        self._speech_frames = params.frames_for(params.min_speech, frame_size, sample_rate)
        self._silence_frames = params.frames_for(params.min_silence, frame_size, sample_rate)
        self._state, self._reason = VoiceState.UNKNOWN, "starting"
        self._since: int | None = None
        self._speech_run = self._speech_start = self._silence_run = self._silence_start = 0

    @property
    def state(self) -> VoiceState:
        return self._state

    @property
    def reason(self) -> str:
        return self._reason

    def push(self, probability: float, start_ns: int, end_ns: int) -> VoiceSnapshot | None:
        if probability >= self._onset:
            if self._speech_run == 0:
                self._speech_start = start_ns
            self._speech_run, self._silence_run = self._speech_run + 1, 0
        elif probability < self._offset:
            if self._silence_run == 0:
                self._silence_start = start_ns
            self._silence_run, self._speech_run = self._silence_run + 1, 0
        else:
            self._speech_run = self._silence_run = 0
        if self._state is not VoiceState.BUSY and self._speech_run >= self._speech_frames:
            return self._set(VoiceState.BUSY, "", self._speech_start, end_ns)
        if self._state is not VoiceState.IDLE and self._silence_run >= self._silence_frames:
            return self._set(VoiceState.IDLE, "", self._silence_start, end_ns)
        return None

    def reset(self, reason: str, at_ns: int, processed_ns: int | None) -> VoiceSnapshot | None:
        self._speech_run = self._silence_run = 0
        if self._state is VoiceState.UNKNOWN and self._reason == reason:
            return None
        return self._set(VoiceState.UNKNOWN, reason, at_ns, processed_ns)

    def _set(
        self, state: VoiceState, reason: str, since_ns: int, processed_ns: int | None
    ) -> VoiceSnapshot:
        self._state, self._reason, self._since = state, reason, since_ns
        return VoiceSnapshot(state, reason, since_ns, processed_ns)


class VoiceActivityMonitor:
    """Poll an AudioRing with a SpeechModel and notify listeners on busy/idle/unknown changes."""

    def __init__(
        self,
        ring: AudioReader | None,
        model: SpeechModel | None,
        *,
        params: VoiceParams = VoiceParams(),
        on_change: Callable[[VoiceSnapshot], None] | None = None,
    ) -> None:
        self._ring, self._model, self._params, self._on_change = ring, model, params, on_change
        initial = "no_audio" if ring is None else ("no_model" if model is None else "starting")
        self._snapshot = VoiceSnapshot(VoiceState.UNKNOWN, initial)
        self._hysteresis = (
            VoiceHysteresis(params, frame_size=model.frame_size, sample_rate=model.sample_rate)
            if model is not None
            else None
        )
        self._frontend: AudioFrontend | None = None
        self._last_block, self._failed = 0, False
        self._last_block_end_ns: int | None = None
        self._processed_ns: int | None = None
        self._not_busy = asyncio.Event()
        self._not_busy.set()

    @property
    def snapshot(self) -> VoiceSnapshot:
        return self._snapshot

    @property
    def state(self) -> VoiceState:
        return self._snapshot.state

    @property
    def busy(self) -> bool:
        return self._snapshot.state is VoiceState.BUSY

    def _apply(self, change: VoiceSnapshot | None, changes: list[VoiceSnapshot]) -> None:
        if change is None:
            return
        self._snapshot = change
        (self._not_busy.clear if change.state is VoiceState.BUSY else self._not_busy.set)()
        changes.append(change)
        if self._on_change is not None:
            with suppress(Exception):
                self._on_change(change)

    def _reset_stream(self, reason: str, at_ns: int, changes: list[VoiceSnapshot]) -> None:
        assert self._model is not None and self._hysteresis is not None
        self._frontend = None
        self._model.reset()
        self._apply(self._hysteresis.reset(reason, at_ns, self._processed_ns), changes)

    def poll_once(self, *, now_ns: int | None = None) -> list[VoiceSnapshot]:
        changes: list[VoiceSnapshot] = []
        if self._ring is None or self._model is None or self._hysteresis is None or self._failed:
            return changes
        now = perf_counter_ns() if now_ns is None else now_ns
        window_ns = max(1_000_000_000, int(self._params.stall_timeout_s * 1e9))
        try:
            read = self._ring.read_recent(window_ns, after=self._last_block)
        except AudioRingTornError:
            return changes
        except (AudioRingError, OSError, ValueError):
            self._failed = True
            self._reset_stream("error", now, changes)
            return changes
        if not read.blocks:
            stall_ns = int(self._params.stall_timeout_s * 1e9)
            if self._last_block_end_ns is not None and now - self._last_block_end_ns > stall_ns:
                self._reset_stream("stalled", now, changes)
            return changes
        for block in read.blocks:
            if self._last_block > 0 and block.block_number != self._last_block + 1:
                self._reset_stream("gap", block.capture_ns, changes)
            elif block.discontinuity or (
                self._frontend is not None
                and (self._frontend.sample_rate, self._frontend.channels)
                != (read.sample_rate, read.channels)
            ):
                self._reset_stream("discontinuity", block.capture_ns, changes)
            if self._frontend is None:
                self._frontend = AudioFrontend(
                    read.sample_rate,
                    read.channels,
                    rate=self._model.sample_rate,
                    frame_size=self._model.frame_size,
                )
            self._last_block = block.block_number
            self._last_block_end_ns = block.capture_ns + read.duration_ns(block.sample_count)
            try:
                for frame in self._frontend.push(block):
                    prob = self._model.probability(frame.samples)
                    self._processed_ns = frame.end_ns
                    self._apply(self._hysteresis.push(prob, frame.start_ns, frame.end_ns), changes)
            except Exception:
                self._failed = True
                self._reset_stream("error", block.capture_ns, changes)
                return changes
        return changes

    async def wait_not_busy(self, timeout_s: float) -> bool:
        if not self.busy:
            return True
        with suppress(TimeoutError):
            async with asyncio.timeout(timeout_s):
                await self._not_busy.wait()
                return True
        return not self.busy

    async def run(self) -> None:
        if self._ring is None or self._model is None:
            return
        while not self._failed:
            self.poll_once()
            await asyncio.sleep(self._params.poll_interval_s)


def load_default_vad_model(path: Path | None = None) -> SileroVad | None:
    target = default_vad_model_path() if path is None else path
    if not target.is_file():
        return None
    if path is None:
        verify_vad_model(target)
    return SileroVad(target)


def main(argv: Sequence[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    cmd = args[0] if args else "check"
    target = Path(args[1]) if len(args) > 1 else default_vad_model_path()
    try:
        if cmd == "fetch":
            print(f"Silero VAD {SILERO_VAD_VERSION} verified at {fetch_silero_vad(target)}")
            return 0
        if cmd == "check":
            print(f"Silero VAD {SILERO_VAD_VERSION} OK: {verify_vad_model(target)}")
            return 0
    except Exception as exc:
        print(f"voice model {cmd} failed: {exc}", file=sys.stderr)
        return 1
    print("usage: python -m bellis_game.perception.voice [fetch|check] [path]", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
