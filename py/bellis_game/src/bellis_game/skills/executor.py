"""Submit one authorized input and verify its effect on independently captured pixels."""

import asyncio
from dataclasses import astuple, dataclass, replace
from enum import StrEnum, auto
from math import isfinite
from typing import Protocol, Self

import bellis_game.perception as perception
from bellis_game.io import FrameRingTornError, RingFrame
from bellis_game.io import protocol as rpc

from . import actions

_FATAL_VERIFICATIONS = frozenset(
    (
        rpc.ReleaseVerification.UP_FAILED,
        rpc.ReleaseVerification.RESIDUAL,
        rpc.ReleaseVerification.UNAVAILABLE,
    )
)


class FrameReader(Protocol):
    def read_latest(self) -> RingFrame | None: ...


class ActionCore(Protocol):
    async def submit_action_block(self, block: rpc.ActionBlock) -> rpc.ActionSubmitResult: ...


class ExecutionStatus(StrEnum):
    VERIFIED_CHANGED = auto()
    NO_VISUAL_CHANGE = auto()
    WAITED = auto()
    POLICY_BLOCKED = auto()
    REJECTED = auto()
    DROPPED = auto()
    UNCERTAIN = auto()
    RECEIPT_TIMEOUT = auto()
    NO_NEW_FRAME = auto()
    CONTROL_RELEASED = auto()


@dataclass(frozen=True, slots=True)
class ExecutionConfig:
    action_deadline_s: float = 0.8
    receipt_timeout_s: float = 1.5
    post_action_delay_s: float = 0.6
    verify_timeout_s: float = 1.5
    poll_interval_s: float = 0.02
    min_changed_ratio: float = 0.005
    min_mean_abs_diff: float = 1.5
    settle_window_s: float = 0.25
    settle_max_changed_ratio: float = 0.03
    settle_timeout_s: float = 1.6

    def __post_init__(self) -> None:
        if not all(type(v) in (int, float) and isfinite(v) and v > 0 for v in astuple(self)):
            raise ValueError("execution thresholds and timeouts must be finite and positive")


@dataclass(frozen=True, slots=True)
class ExecutionOutcome:
    status: ExecutionStatus
    detail: str
    base_frame: int
    block_seq: int | None = None
    action_id: int | None = None
    after_frame: RingFrame | None = None
    diff: perception.FrameDiff | None = None
    release: rpc.InputReleasedParams | None = None
    receipt: rpc.ActionReceiptParams | None = None

    def with_release(self, rel: rpc.InputReleasedParams) -> Self:
        return replace(
            self, status=ExecutionStatus.CONTROL_RELEASED, detail=rel.reason, release=rel
        )


class ActionExecutor:
    def __init__(
        self,
        core: ActionCore,
        frames: FrameReader,
        profile: perception.GameProfile,
        producer: rpc.Producer,
        *,
        config: ExecutionConfig | None = None,
    ) -> None:
        self._core, self._frames, self._profile, self._producer = core, frames, profile, producer
        self._cfg = config or ExecutionConfig()
        self._seq = 0
        self._receipts: dict[int, asyncio.Future[rpc.ActionReceiptParams]] = {}
        self._last_release: rpc.InputReleasedParams | None = None
        self._signal: asyncio.Future[rpc.InputReleasedParams] | None = None
        self._pending_deadline_id: int | None = None
        self._deadline_clear = asyncio.Event()
        self._deadline_clear.set()

    def on_receipt(self, rec: rpc.ActionReceiptParams) -> None:
        if rec.producer != self._producer or len(rec.outcomes) != 1:
            return
        waiter = self._receipts.get(rec.block_seq)
        if waiter is not None and not waiter.done() and rec.outcomes[0].id == rec.block_seq:
            waiter.set_result(rec)

    def on_released(self, rel: rpc.InputReleasedParams) -> None:
        if rel.reason == rpc.ReleaseReason.CORE_START:
            return
        deadline_expired = rel.reason == rpc.ReleaseReason.DEADLINE_EXPIRED
        if deadline_expired and rel.verification not in _FATAL_VERIFICATIONS:
            pending = self._pending_deadline_id
            if rel.verification == rpc.ReleaseVerification.UNVERIFIED:
                self._pending_deadline_id = rel.release_id
                self._deadline_clear.clear()
            elif pending is not None and rel.release_id >= pending:
                self._pending_deadline_id = None
                self._deadline_clear.set()
            return
        self._last_release = rel
        if self._signal is not None and not self._signal.done():
            self._signal.set_result(rel)
        self._signal = None
        self._deadline_clear.set()

    @property
    def control_released(self) -> bool:
        return self._last_release is not None

    @property
    def last_release(self) -> rpc.InputReleasedParams | None:
        return self._last_release

    def reset_release(self) -> None:
        if self.control_released:
            self._last_release = self._signal = None
        self._pending_deadline_id = None
        self._deadline_clear.set()

    def release_signal(self) -> asyncio.Future[rpc.InputReleasedParams]:
        if self._signal is None:
            self._signal = asyncio.get_running_loop().create_future()
            if self._last_release is not None:
                self._signal.set_result(self._last_release)
        return self._signal

    def _read_frame(self) -> RingFrame | None:
        try:
            return self._frames.read_latest()
        except FrameRingTornError:
            return None

    async def execute_input(
        self,
        proposal: actions.ClickProposal | actions.KeyProposal,
        *,
        before_frame: RingFrame,
        transform: perception.FrameTransform,
        verify_roi: rpc.NormRect | None = None,
    ) -> ExecutionOutcome:
        cfg = self._cfg
        signal = self.release_signal()
        base = before_frame.frame_number
        if self._pending_deadline_id is not None and not signal.done():
            cleared = asyncio.create_task(self._deadline_clear.wait())
            try:
                await asyncio.wait(
                    (cleared, signal),
                    timeout=min(cfg.receipt_timeout_s, 0.5),
                    return_when=asyncio.FIRST_COMPLETED,
                )
            finally:
                cleared.cancel()
                await asyncio.gather(cleared, return_exceptions=True)
        if signal.done():
            rel = signal.result()
            return ExecutionOutcome(ExecutionStatus.CONTROL_RELEASED, rel.reason, base, release=rel)
        seq = self._seq + 1
        try:
            block = actions.build_action_block(
                proposal,
                self._profile,
                self._producer,
                seq,
                before_frame,
                transform,
                cfg.action_deadline_s,
            )
        except actions.ActionPolicyError as exc:
            return ExecutionOutcome(ExecutionStatus.POLICY_BLOCKED, exc.reason, base)
        self._seq = seq
        loop = asyncio.get_running_loop()
        receipt: asyncio.Future[rpc.ActionReceiptParams] = loop.create_future()
        self._receipts[seq] = receipt
        outcome = ExecutionOutcome(
            ExecutionStatus.RECEIPT_TIMEOUT, "receipt timeout", base, seq, seq
        )

        async def submit_and_wait() -> rpc.Rejected | rpc.ActionReceiptParams | None:
            if signal.done():
                return None
            result = await self._core.submit_action_block(block)
            if isinstance(result, rpc.Rejected):
                return result
            try:
                return await asyncio.wait_for(receipt, cfg.receipt_timeout_s)
            except TimeoutError:
                return None

        submission = asyncio.create_task(submit_and_wait())
        try:
            await asyncio.wait((submission, signal), return_when=asyncio.FIRST_COMPLETED)
        finally:
            del self._receipts[seq]
            submission.cancel()
            await asyncio.gather(submission, return_exceptions=True)
        if signal.done():
            return outcome.with_release(signal.result())
        rec = submission.result()
        if isinstance(rec, rpc.Rejected):
            return replace(outcome, status=ExecutionStatus.REJECTED, detail=rec.reason)
        if rec is None:
            return outcome
        outcome = replace(outcome, receipt=rec)
        event = rec.outcomes[0]
        if isinstance(event, rpc.Dropped):
            return replace(outcome, status=ExecutionStatus.DROPPED, detail=event.reason)
        if isinstance(event, rpc.Uncertain):
            return replace(outcome, status=ExecutionStatus.UNCERTAIN, detail="execution uncertain")
        await asyncio.wait((signal,), timeout=cfg.post_action_delay_s)
        deadline = loop.time() + cfg.verify_timeout_s
        while not signal.done():
            remaining = deadline - loop.time()
            if remaining <= 0:
                return replace(outcome, status=ExecutionStatus.NO_NEW_FRAME, detail="no new frame")
            frame = self._read_frame()
            if frame and frame.frame_number > base and frame.capture_ns >= event.at_ns:
                diff = perception.frame_diff(before_frame, frame, roi=verify_roi)
                changed = (
                    diff.changed_ratio >= cfg.min_changed_ratio
                    or diff.mean_abs_diff >= cfg.min_mean_abs_diff
                )
                status = ExecutionStatus.NO_VISUAL_CHANGE
                if changed:
                    status = ExecutionStatus.VERIFIED_CHANGED
                return replace(
                    outcome, status=status, detail=status.value, after_frame=frame, diff=diff
                )
            await asyncio.wait((signal,), timeout=min(cfg.poll_interval_s, remaining))
        return outcome.with_release(signal.result())

    async def execute_wait(
        self, proposal: actions.WaitProposal, *, before_frame: RingFrame
    ) -> ExecutionOutcome:
        signal = self.release_signal()
        outcome = ExecutionOutcome(
            ExecutionStatus.WAITED, proposal.reason, before_frame.frame_number
        )
        if not signal.done():
            await asyncio.wait((signal,), timeout=proposal.duration_ms / 1000)
        if signal.done():
            return outcome.with_release(signal.result())
        after = self._read_frame()
        diff = perception.frame_diff(before_frame, after) if after is not None else None
        return replace(outcome, after_frame=after, diff=diff)

    async def wait_for_settle(self, *, roi: rpc.NormRect | None = None) -> RingFrame | None:
        signal = self.release_signal()
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self._cfg.settle_timeout_s
        anchor = latest = None
        while not signal.done():
            frame = self._read_frame()
            if frame is not None:
                latest = frame
                if anchor is None:
                    anchor = frame
                elif (
                    frame.frame_number > anchor.frame_number
                    and frame.capture_ns - anchor.capture_ns >= self._cfg.settle_window_s * 1e9
                ):
                    if (
                        perception.frame_diff(anchor, frame, roi=roi).changed_ratio
                        <= self._cfg.settle_max_changed_ratio
                    ):
                        return frame
                    anchor = frame
            remaining = deadline - loop.time()
            if remaining <= 0:
                return latest
            await asyncio.wait((signal,), timeout=min(remaining, self._cfg.poll_interval_s))
        return None
