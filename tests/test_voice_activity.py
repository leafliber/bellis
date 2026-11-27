"""Unit and integration tests for Step 6a game voice activity detection and avoidance."""

from __future__ import annotations

import asyncio
import json
from collections import deque
from collections.abc import AsyncIterator, Sequence
from dataclasses import replace
from pathlib import Path
from unittest.mock import AsyncMock, Mock

import numpy as np
import pytest
from bellis_common import agent_events as ev
from bellis_common.wire_codec import ProtocolError
from bellis_game.io import AudioBlock, AudioRead, AudioRingTornError
from bellis_game.loop import ControlReleased, FastLoop, GoalCompleted
from bellis_game.perception import (
    AudioFrame,
    AudioFrontend,
    VoiceActivityMonitor,
    VoiceHysteresis,
    VoiceParams,
    VoiceSnapshot,
    VoiceState,
    default_vad_model_path,
    load_default_vad_model,
    verify_vad_model,
)
from bellis_host import DirectorConfig, HostApp, HostConfig
from bellis_host.speech import TtsSynthesizer
from numpy.typing import NDArray
from test_fast_loop import CONFIG, DONE, GOAL, KEY, PRODUCER, PROFILE, RELEASE, WAIT, Session


class _SequenceModel:
    def __init__(
        self, probs: Sequence[float], *, sample_rate: int = 16_000, frame_size: int = 512
    ) -> None:
        self._probs = deque(probs)
        self._sample_rate = sample_rate
        self._frame_size = frame_size
        self.resets = 0
        self.calls = 0

    @property
    def sample_rate(self) -> int:
        return self._sample_rate

    @property
    def frame_size(self) -> int:
        return self._frame_size

    def reset(self) -> None:
        self.resets += 1

    def probability(self, frame: NDArray[np.float32]) -> float:
        assert frame.shape == (self._frame_size,)
        self.calls += 1
        return self._probs.popleft() if self._probs else 0.0


class _QueueAudio:
    def __init__(self, sample_rate: int = 48_000, channels: int = 2) -> None:
        self.sample_rate = sample_rate
        self.channels = channels
        self.blocks: list[AudioBlock] = []
        self.torn = False

    def append_silence(
        self,
        block_number: int,
        capture_ns: int,
        sample_count: int = 4800,
        *,
        discontinuity: bool = False,
        value: float = 0.0,
    ) -> None:
        pcm = np.full(sample_count * self.channels, value, dtype=np.float32).tobytes()
        self.blocks.append(AudioBlock(block_number, capture_ns, sample_count, discontinuity, pcm))

    def read_recent(self, duration_ns: int, *, after: int = 0) -> AudioRead:
        if self.torn:
            self.torn = False
            raise AudioRingTornError("torn")
        newer = tuple(b for b in self.blocks if b.block_number > after)
        return AudioRead(self.sample_rate, self.channels, newer)


class _ManualVoice:
    def __init__(self, busy: bool = False) -> None:
        self._busy = busy
        self._idle = asyncio.Event()
        if not busy:
            self._idle.set()
        self.wait_calls = 0

    @property
    def busy(self) -> bool:
        return self._busy

    def set_busy(self, busy: bool) -> None:
        self._busy = busy
        if busy:
            self._idle.clear()
        else:
            self._idle.set()

    async def wait_not_busy(self, timeout_s: float) -> bool:
        self.wait_calls += 1
        if not self._busy:
            return True
        try:
            async with asyncio.timeout(timeout_s):
                await self._idle.wait()
                return True
        except TimeoutError:
            return False


def test_frontend_resamples_stereo_48k_to_16k_and_preserves_timestamps() -> None:
    fe = AudioFrontend(48_000, 2, rate=16_000, frame_size=512)
    frames: list[AudioFrame] = []
    for i in range(1, 11):
        stereo = np.zeros((4800, 2), dtype=np.float32)
        stereo[:, 0] = 0.5
        stereo[:, 1] = -0.5
        if i == 1:
            stereo[0, 0] = float("nan")
        blk = AudioBlock(i, i * 100_000_000, 4800, False, stereo.tobytes())
        frames.extend(fe.push(blk))
    assert len(frames) >= 28
    assert all(f.samples.shape == (512,) for f in frames)
    assert all(np.isfinite(f.samples).all() for f in frames)
    assert all(f.end_ns - f.start_ns == 32_000_000 for f in frames)


def test_hysteresis_onset_offset_middle_band_and_reset() -> None:
    params = VoiceParams(onset=0.5, offset=0.35, min_speech=0.064, min_silence=0.096)
    h = VoiceHysteresis(params, frame_size=512, sample_rate=16_000)
    assert h.state is VoiceState.UNKNOWN
    assert h.push(0.8, 0, 32) is None
    assert h.push(0.4, 32, 64) is None
    assert h.push(0.8, 64, 96) is None
    change = h.push(0.9, 96, 128)
    assert change is not None and change.state is VoiceState.BUSY and change.since_ns == 64
    assert h.push(0.1, 128, 160) is None
    assert h.push(float("nan"), 160, 192) is None
    assert h.push(0.1, 192, 224) is None
    assert h.push(0.2, 224, 256) is None
    idle = h.push(0.3, 256, 288)
    assert idle is not None and idle.state is VoiceState.IDLE and idle.since_ns == 192
    reset = h.reset("gap", 300, 288)
    assert reset is not None and reset.state is VoiceState.UNKNOWN and reset.reason == "gap"
    assert h.reset("gap", 350, 288) is None


def test_voice_monitor_transitions_gap_discontinuity_and_stall() -> None:
    ring = _QueueAudio(sample_rate=48_000, channels=2)
    model = _SequenceModel([0.9] * 8 + [0.1] * 25)
    params = VoiceParams(
        onset=0.5, offset=0.35, min_speech=0.064, min_silence=0.096, stall_timeout_s=0.5
    )
    seen: list[VoiceSnapshot] = []
    mon = VoiceActivityMonitor(ring, model, params=params, on_change=seen.append)
    assert not mon.busy and mon.state is VoiceState.UNKNOWN

    ring.torn = True
    assert mon.poll_once(now_ns=1_000_000_000) == []

    ring.append_silence(1, 1_000_000_000, sample_count=9600)
    mon.poll_once(now_ns=1_200_000_000)
    assert mon.busy and mon.state is VoiceState.BUSY

    ring.append_silence(2, 1_200_000_000, sample_count=9600)
    ring.append_silence(3, 1_400_000_000, sample_count=9600)
    mon.poll_once(now_ns=1_600_000_000)
    assert not mon.busy and mon.state is VoiceState.IDLE

    resets_before = model.resets
    ring.append_silence(6, 1_800_000_000, sample_count=4800)
    mon.poll_once(now_ns=1_900_000_000)
    assert model.resets == resets_before + 1
    assert any(s.state is VoiceState.UNKNOWN and s.reason == "gap" for s in seen)

    ring.append_silence(7, 2_000_000_000, sample_count=4800, discontinuity=True)
    mon.poll_once(now_ns=2_100_000_000)
    assert any(s.state is VoiceState.UNKNOWN and s.reason == "discontinuity" for s in seen)

    mon.poll_once(now_ns=3_000_000_000)
    assert mon.state is VoiceState.UNKNOWN and mon.snapshot.reason == "stalled"


def test_missing_or_corrupt_vad_model_degrades_gracefully(tmp_path: Path) -> None:
    missing = tmp_path / "missing.onnx"
    assert load_default_vad_model(missing) is None
    bad = tmp_path / "bad.onnx"
    bad.write_bytes(b"not-a-model")
    with pytest.raises(ValueError, match="size mismatch"):
        verify_vad_model(bad)
    assert default_vad_model_path().name == "silero_vad.onnx"
    mon = VoiceActivityMonitor(None, None)
    assert mon.state is VoiceState.UNKNOWN and mon.snapshot.reason == "no_audio"
    assert mon.poll_once() == []


def test_game_voice_changed_wire_roundtrip() -> None:
    msg = ev.GameVoiceChanged("busy")
    assert ev.parse_fast_event(msg.to_dict()) == msg
    idle = ev.GameVoiceChanged("unknown", "stalled")
    assert ev.parse_fast_event(idle.to_dict()) == idle
    with pytest.raises(ProtocolError):
        ev.GameVoiceChanged("loud")


async def test_fast_loop_waits_for_voice_idle_before_input_and_reobserves() -> None:
    voice = _ManualVoice(busy=True)
    s = Session(KEY, KEY, DONE, config=replace(CONFIG, max_voice_wait_s=1.0))
    loop = FastLoop(
        s,
        s.frames,
        s.model,
        s.executor,
        PROFILE,
        PRODUCER,
        config=replace(CONFIG, max_voice_wait_s=1.0),
        voice=voice,
        on_step=s.records.append,
    )

    async def release_voice() -> None:
        await asyncio.sleep(0.05)
        assert not s.blocks
        voice.set_busy(False)

    async with asyncio.timeout(2):
        releaser = asyncio.create_task(release_voice())
        outcome = await loop.run_goal(GOAL)
        await releaser
    assert isinstance(outcome, GoalCompleted)
    assert voice.wait_calls == 1
    assert len(s.blocks) == 1
    assert len(s.model.prompts) == 3


async def test_fast_loop_does_not_block_done_or_wait_when_voice_busy() -> None:
    voice = _ManualVoice(busy=True)
    s = Session(WAIT, DONE, config=replace(CONFIG, max_voice_wait_s=5.0))
    loop = FastLoop(
        s,
        s.frames,
        s.model,
        s.executor,
        PROFILE,
        PRODUCER,
        config=replace(CONFIG, max_voice_wait_s=5.0),
        voice=voice,
    )
    async with asyncio.timeout(1):
        outcome = await loop.run_goal(GOAL)
    assert isinstance(outcome, GoalCompleted)
    assert voice.wait_calls == 0


async def test_fast_loop_voice_wait_preempted_by_takeover_and_bounded() -> None:
    voice = _ManualVoice(busy=True)
    s = Session(KEY, DONE, config=replace(CONFIG, max_voice_wait_s=10.0))
    loop = FastLoop(
        s,
        s.frames,
        s.model,
        s.executor,
        PROFILE,
        PRODUCER,
        config=replace(CONFIG, max_voice_wait_s=10.0),
        voice=voice,
    )
    async with asyncio.timeout(1):
        work = asyncio.create_task(loop.run_goal(GOAL))
        await s.model.called.wait()
        await asyncio.sleep(0.02)
        s.executor.on_released(RELEASE)
        outcome = await work
    assert isinstance(outcome, ControlReleased) and outcome.reason == RELEASE.reason
    assert not s.blocks

    voice2 = _ManualVoice(busy=True)
    s2 = Session(KEY, KEY, DONE, config=replace(CONFIG, max_voice_wait_s=0.05))
    loop2 = FastLoop(
        s2,
        s2.frames,
        s2.model,
        s2.executor,
        PROFILE,
        PRODUCER,
        config=replace(CONFIG, max_voice_wait_s=0.05),
        voice=voice2,
    )
    async with asyncio.timeout(1):
        outcome2 = await loop2.run_goal(GOAL)
    assert isinstance(outcome2, GoalCompleted) and len(s2.blocks) == 1


class _SingleReplyLlm:
    def __init__(self) -> None:
        self.called = asyncio.Event()
        self.calls = 0

    async def stream_chat(
        self, messages: Sequence[dict[str, str]], *, cancel: asyncio.Event | None = None
    ) -> AsyncIterator[str]:
        self.calls += 1
        self.called.set()
        yield json.dumps({"action": "silence", "reason": "ok"})


async def test_director_defers_danmaku_during_voice_busy_but_not_urgent_decision(
    tmp_path: Path,
) -> None:
    cfg = HostConfig(
        db_path=tmp_path / "host.sqlite3",
        enable_obs=False,
        enable_watchdog=False,
        director=DirectorConfig(batch_window_s=0.02, max_voice_defer_s=2.0),
    )
    llm = _SingleReplyLlm()
    app = HostApp(cfg, tts=Mock(spec=TtsSynthesizer), llm=llm)
    await app.start()
    try:
        app.safety.start_live()
        app.game_link._hello = ev.AgentHelloParams("hsr", "HSR")  # pyright: ignore[reportPrivateUsage]
        app.game_link._peer = Mock(connection=Mock(is_open=True), close=AsyncMock())  # pyright: ignore[reportPrivateUsage]
        app.game_link._receive_event(ev.GameVoiceChanged("busy").to_dict())  # pyright: ignore[reportPrivateUsage]
        assert app.game_link.voice_busy and app.game_link.snapshot().voice_state == "busy"

        app.director.submit_danmaku("u1", "Alice", "hello!")
        await asyncio.sleep(0.15)
        assert llm.calls == 0

        # Voice goes idle -> deferred danmaku immediately triggers director turn
        app.game_link._receive_event(ev.GameVoiceChanged("idle").to_dict())  # pyright: ignore[reportPrivateUsage]
        assert not app.game_link.voice_busy
        await asyncio.wait_for(llm.called.wait(), timeout=1.0)
        assert llm.calls == 1

        # Urgent DecisionNeeded bypasses voice_busy deferral immediately
        llm.called.clear()
        app.game_link._receive_event(ev.GameVoiceChanged("busy").to_dict())  # pyright: ignore[reportPrivateUsage]
        app.director.submit_game_event(ev.DecisionNeeded("g1", "d1", "Pick?", ("A", "B")))
        await asyncio.wait_for(llm.called.wait(), timeout=0.5)
        assert llm.calls == 2
    finally:
        await app.close()
