"""Run a bounded goal across explicitly authorized producer generations."""

import asyncio
from collections import deque
from collections.abc import AsyncGenerator, Callable, Coroutine
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass
from time import perf_counter
from typing import Any, Protocol
from uuid import uuid4

from bellis_common.channel import ChannelError, RpcError
from bellis_common.telemetry import JsonlTelemetry, new_trace_id

import bellis_game.perception as vision
import bellis_game.skills as skills
from bellis_game.io import FrameRingTornError, RingFrame, frame_age_ns
from bellis_game.io.protocol import Producer, ProducerRevokeResult
from bellis_game.skills import ExecutionStatus as Status

from . import events
from .events import ActionRecord, ControlReleased, GoalCompleted, GoalSet, GoalStuck, LoopOutcome
from .events import build_system_prompt as build_system_prompt
from .events import build_user_prompt as build_user_prompt


class LoopCore(skills.ActionCore, Protocol):
    def send_heartbeat(self, producer: Producer, seq: int) -> None: ...
    async def revoke_producer(self, generation: int) -> ProducerRevokeResult: ...


class VisionModel(Protocol):
    async def complete_json(
        self, *, system_prompt: str, user_text: str, image: vision.EncodedFrame,
        required_keys: frozenset[str] = ..., allowed_keys: frozenset[str] | None = ...,
        trace_id: str | None = ...,
    ) -> vision.VlmJsonResult: ...  # fmt: skip


@dataclass(frozen=True, slots=True)
class LoopConfig:
    heartbeat_interval_s: float = 0.1
    max_frame_age_s: float = 0.5
    frame_wait_timeout_s: float = 3.0
    frame_poll_interval_s: float = 0.02
    max_no_change: int = 2
    max_vlm_errors: int = 2
    history_limit: int = 6
    overlay_grid: bool = True

    def __post_init__(self) -> None:
        if type(self.overlay_grid) is not bool:
            raise ValueError("overlay_grid must be a boolean")
        times = (self.heartbeat_interval_s, self.frame_poll_interval_s,
                 self.max_frame_age_s, self.frame_wait_timeout_s)  # fmt: skip
        if not all(map(events.positive_time, times)):
            raise ValueError("loop timeouts and intervals must be finite and positive")
        counts = (self.max_no_change, self.max_vlm_errors, self.history_limit)
        if not all(map(events.positive_count, counts)):
            raise ValueError("loop limits must be positive integers")


class LoopControl:
    def __init__(self) -> None:
        self.cancel_event = asyncio.Event()
        self.paused_event = asyncio.Event()
        self.resumed_event = asyncio.Event()
        self.resumed_event.set()
        self.pending_decision: events.DecisionNeeded | None = None
        self._decision_ready = asyncio.Event()
        self._resolved: events.DecisionResolved | None = None
        self.cancel_reason = "cancelled"
        self._pause_requested = False

    @property
    def cancelled(self) -> bool:
        return self.cancel_event.is_set()

    @property
    def paused(self) -> bool:
        return self.paused_event.is_set()

    def cancel(self, reason: str = "cancelled") -> None:
        self.pending_decision = None
        self.cancel_reason = reason
        self.cancel_event.set()

    def begin_decision(self, decision: events.DecisionNeeded) -> None:
        self.pending_decision = decision
        self._resolved = None
        self._decision_ready.clear()

    def resolve_decision(self, cmd: events.DecisionResolved) -> str | None:
        pending = self.pending_decision
        if pending is None:
            return "no_pending_decision"
        if cmd.goal_id != pending.goal_id:
            return "goal_mismatch"
        if cmd.decision_id != pending.decision_id:
            return "decision_mismatch"
        if not 0 <= cmd.chosen_index < len(pending.options) or (
            cmd.chosen_option != pending.options[cmd.chosen_index]
        ):
            return "invalid_option"
        self._resolved = cmd
        self.pending_decision = None
        self._decision_ready.set()
        return None

    async def wait_decision(self) -> events.DecisionResolved:
        try:
            await self._decision_ready.wait()
        finally:
            self.pending_decision = None
        assert self._resolved is not None
        return self._resolved

    def pause(self) -> None:
        self._pause_requested = True
        self.resumed_event.clear()
        self.paused_event.set()

    def resume(self) -> None:
        self.paused_event.clear()
        self.resumed_event.set()

    def take_pause(self) -> bool:
        # A resume during an already-submitted action still owes a generation revocation.
        requested = self._pause_requested or self.paused
        self._pause_requested = False
        return requested

    async def until_pause[T](self, inference: Coroutine[Any, Any, T]) -> T | None:
        work = asyncio.create_task(inference)
        paused = asyncio.create_task(self.paused_event.wait())
        try:
            await asyncio.wait((work, paused), return_when=asyncio.FIRST_COMPLETED)
        finally:
            work.cancel()
            paused.cancel()
            await asyncio.gather(work, paused, return_exceptions=True)
        return None if self._pause_requested or self.paused else work.result()


class FastLoop:
    def __init__(
        self, core: LoopCore, frames: skills.FrameReader, vlm: VisionModel,
        executor: skills.ActionExecutor, profile: vision.GameProfile, producer: Producer, *,
        config: LoopConfig | None = None, telemetry: JsonlTelemetry | None = None,
        on_step: Callable[[ActionRecord], None] | None = None,
        on_event: Callable[[events.DecisionNeeded | events.HighlightObserved], None] | None = None,
    ) -> None:  # fmt: skip
        self._core, self._frames, self._vlm = core, frames, vlm
        self._executor, self._profile, self._producer = executor, profile, producer
        self._config = config or LoopConfig()
        self._on_event = on_event
        self._telemetry, self._on_step = telemetry, on_step
        self._heartbeat: asyncio.Task[None] | None = None
        self._work: asyncio.Task[LoopOutcome | None] | None = None
        self._cleanup: asyncio.Task[None] | None = None
        self._model_stop: GoalStuck | None = None
        self._steps = 0
        self._last_frame: int | None = None
        self._trace = new_trace_id()

    async def _beat(self) -> None:
        seq = 0
        while True:
            seq += 1
            with suppress(ChannelError):
                self._core.send_heartbeat(self._producer, seq)
            await asyncio.sleep(self._config.heartbeat_interval_s)

    def _cancel_active(self) -> None:
        if self._work:
            self._work.cancel()
        if self._heartbeat:
            self._heartbeat.cancel()

    async def _revoke(self) -> None:
        if self._heartbeat:
            self._heartbeat.cancel()
        try:
            await self._core.revoke_producer(self._producer.generation)
        finally:
            if self._heartbeat:
                await asyncio.gather(self._heartbeat, return_exceptions=True)

    async def _shutdown(self) -> None:
        if self._work:
            self._work.cancel()
        try:
            with suppress(ChannelError, RpcError):
                await self._revoke()
        finally:
            if self._work:
                await asyncio.gather(self._work, return_exceptions=True)

    async def quiesce(self) -> None:
        if self._cleanup is None:
            self._cleanup = asyncio.create_task(self._shutdown())
        await asyncio.shield(self._cleanup)

    async def close(self) -> None:
        await self.quiesce()

    def _span(self, name: str, start: float, ok: bool, **attrs: object) -> None:
        if self._telemetry is not None:
            ms = (perf_counter() - start) * 1000
            self._telemetry.record(name, dur_ms=ms, ok=ok, trace_id=self._trace, attrs=attrs)

    def _stuck(self, goal: GoalSet, reason: str, detail: str) -> GoalStuck:
        return GoalStuck(goal.goal_id, reason, detail, self._steps, self._last_frame)

    async def run_goal(
        self,
        goal: GoalSet,
        *,
        control: LoopControl | None = None,
        next_producer: Callable[[], Producer] | None = None,
    ) -> LoopOutcome:
        if self._work is not None or self._cleanup is not None:
            raise RuntimeError("this producer generation has already been used")
        start = perf_counter()
        control = control or LoopControl()
        cancelled = asyncio.create_task(control.cancel_event.wait())
        signal = self._executor.release_signal()
        budget = asyncio.timeout(goal.timeout_s)
        try:
            if not (control.paused or control.cancelled or signal.done()):
                self._heartbeat = asyncio.create_task(self._beat())
            self._work = asyncio.create_task(self._drive(goal, control, next_producer, budget))
            with suppress(TimeoutError):
                async with budget:
                    await asyncio.wait(
                        (self._work, signal, cancelled), return_when=asyncio.FIRST_COMPLETED
                    )
            if signal.done():
                self._cancel_active()
                rel = await self._executor.wait_release_final(
                    self._executor.last_release or signal.result()
                )
                outcome = ControlReleased(goal.goal_id, rel.reason, rel.verification, self._steps)
            elif control.cancelled:
                outcome = self._stuck(goal, "cancelled", control.cancel_reason)
            else:
                result = self._work.result() if self._work.done() else None
                outcome = result or self._stuck(goal, "goal_timeout", "goal deadline elapsed")
        finally:
            cancelled.cancel()
            await self.quiesce()
            await asyncio.gather(cancelled, return_exceptions=True)
        reason = outcome.reason if isinstance(outcome, (GoalStuck, ControlReleased)) else "done"
        attrs = dict(
            outcome=type(outcome).__name__,
            steps=outcome.steps_taken,
            reason="model_stop" if outcome is self._model_stop else reason,
        )
        self._span("loop.goal", start, isinstance(outcome, GoalCompleted), **attrs)
        return outcome

    async def _fresh_frame(self) -> RingFrame | None:
        max_age = self._config.max_frame_age_s * 1e9
        with suppress(TimeoutError):
            async with asyncio.timeout(self._config.frame_wait_timeout_s):
                while True:
                    with suppress(FrameRingTornError):
                        frame = self._frames.read_latest()
                        if frame and frame_age_ns(frame.capture_ns) <= max_age:
                            return frame
                    await asyncio.sleep(self._config.frame_poll_interval_s)
        return None

    @asynccontextmanager
    async def _hold(
        self, control: LoopControl, advance: Callable[[], Producer] | None, budget: asyncio.Timeout
    ) -> AsyncGenerator[None]:
        clock = asyncio.get_running_loop().time
        deadline = budget.when()
        assert deadline is not None
        remaining = deadline - clock()
        budget.reschedule(None)
        self._executor.begin_pause()
        await self._revoke()
        yield
        while not (self._executor.control_released or control.cancelled) and control.take_pause():
            await control.resumed_event.wait()
        if self._executor.control_released or control.cancelled:
            return
        old = self._producer
        producer = advance() if advance else Producer(old.id, old.generation + 1)
        self._executor.switch_producer(producer)
        self._producer = producer
        budget.reschedule(clock() + remaining)
        self._heartbeat = asyncio.create_task(self._beat())

    async def _observe(
        self, goal: GoalSet, step: int, history: deque[ActionRecord], system: str
    ) -> tuple[RingFrame, vision.EncodedFrame, vision.VlmJsonResult] | GoalStuck:
        frame = await self._fresh_frame()
        if frame is None:
            return self._stuck(goal, "no_fresh_frame", "no fresh capture")
        self._steps, self._last_frame = step, frame.frame_number
        cfg = self._profile.vlm
        image = await asyncio.to_thread(
            vision.encode_frame, frame, max_long_edge=cfg.max_long_edge,
            image_format=cfg.image_format, jpeg_quality=cfg.jpeg_quality,
            overlay_grid=self._config.overlay_grid,
        )  # fmt: skip
        prompt = build_user_prompt(
            goal, frame_width=frame.width, frame_height=frame.height,
            step_index=step, history=list(history),
        )  # fmt: skip
        result = await self._vlm.complete_json(
            system_prompt=system, user_text=prompt, image=image, trace_id=self._trace,
            required_keys=skills.DECISION_REQUIRED_KEYS, allowed_keys=skills.DECISION_ALLOWED_KEYS,
        )  # fmt: skip
        return frame, image, result

    async def _drive(
        self,
        goal: GoalSet,
        control: LoopControl,
        next_producer: Callable[[], Producer] | None,
        budget: asyncio.Timeout,
    ) -> LoopOutcome | None:
        history: deque[ActionRecord] = deque(maxlen=self._config.history_limit)
        errors = no_change = 0
        last_highlight, highlight_step = "", -1
        system = build_system_prompt(self._profile)
        clock = asyncio.get_running_loop().time
        while self._steps < goal.max_steps:
            if control.take_pause():
                async with self._hold(control, next_producer, budget):
                    pass
            if self._executor.control_released or control.cancelled:
                return None
            deadline = budget.when()
            assert deadline is not None
            if clock() >= deadline:
                return None
            step, start = self._steps + 1, perf_counter()
            action, status = "none", "interrupted"
            ratio = number = None
            try:
                try:
                    observed = await control.until_pause(self._observe(goal, step, history, system))
                    if observed is None or control.paused:
                        self._steps = step - 1
                        status = "paused"
                        continue
                    if isinstance(observed, GoalStuck):
                        status = observed.reason
                        return observed
                    frame, image, result = observed
                    number = frame.frame_number
                    decision = skills.parse_agent_decision(result.data)
                except (vision.VlmError, skills.ProposalError) as exc:
                    number = self._last_frame
                    assert number is not None
                    errors += 1
                    status = "vlm_error" if isinstance(exc, vision.VlmError) else "proposal_error"
                    detail = "invalid decision"
                    if isinstance(exc, vision.VlmError):
                        detail = f"vlm:{exc.code}"
                        if exc.schema_issue is not None:
                            detail += f":{exc.schema_issue}"
                        if exc.status_code is not None:
                            detail += f" (status={exc.status_code})"
                    elif errors >= self._config.max_vlm_errors:
                        detail = "consecutive invalid decisions"
                    if self._on_step:
                        self._on_step(ActionRecord(step, number, "", "none", detail, status))
                    if errors >= self._config.max_vlm_errors:
                        return self._stuck(goal, status, detail)
                    continue
                errors = 0
                if self._executor.control_released or control.cancelled or clock() >= deadline:
                    return None
                highlight = decision.highlight[:160]
                new_highlight = highlight and highlight != last_highlight
                if self._on_event and new_highlight and step - highlight_step >= 2:
                    event = events.HighlightObserved(goal.goal_id, highlight, step, number)
                    with suppress(Exception):  # Commentary delivery cannot interrupt an action.
                        self._on_event(event)
                        last_highlight, highlight_step = highlight, step
                proposal = decision.proposal
                terminal: GoalCompleted | GoalStuck | None = None
                if isinstance(proposal, skills.AskDecisionProposal):
                    action = "decision"
                    if self._on_event is None:
                        status = "decision_unavailable"
                        return self._stuck(goal, status, proposal.question)
                    async with self._hold(control, next_producer, budget):
                        if self._executor.control_released or control.cancelled:
                            return None
                        needed = events.DecisionNeeded(
                            goal.goal_id,
                            uuid4().hex,
                            proposal.question,
                            proposal.options,
                            proposal.reason,
                        )
                        control.begin_decision(needed)
                        self._on_event(needed)
                        resolved = await control.wait_decision()
                    if self._executor.control_released or control.cancelled:
                        return None
                    no_change = 0
                    summary, status = f"{needed.question} -> {resolved.chosen_option}", "resolved"
                elif isinstance(proposal, skills.DoneProposal):
                    action = status = "done"
                    summary = proposal.evidence
                    terminal = GoalCompleted(goal.goal_id, summary, step, number)
                elif isinstance(proposal, skills.StopProposal):
                    action = status = "stop"
                    summary = proposal.reason
                    terminal = self._stuck(goal, summary, proposal.detail)
                    self._model_stop = terminal
                else:
                    if isinstance(proposal, skills.WaitProposal):
                        action, summary = "wait", f"{proposal.duration_ms} ms"
                        execution = await self._executor.execute_wait(proposal, before_frame=frame)
                    else:
                        if isinstance(proposal, skills.ClickProposal):
                            action = "click"
                            summary = f"{proposal.target} ({proposal.nx}, {proposal.ny})"
                        else:
                            action, summary = "key_press", proposal.key
                        execution = await self._executor.execute_input(
                            proposal, before_frame=frame, transform=image.transform
                        )
                        if execution.status == Status.VERIFIED_CHANGED:
                            await self._executor.wait_for_settle()
                            if (release := self._executor.last_release) is not None:
                                execution = execution.with_release(release)
                    status = execution.status
                    ratio = execution.diff.changed_ratio if execution.diff else None
                    if status == Status.CONTROL_RELEASED:
                        rel = execution.release or self._executor.last_release
                        assert rel is not None
                        return ControlReleased(goal.goal_id, rel.reason, rel.verification, step)
                    if status == Status.VERIFIED_CHANGED:
                        no_change = 0
                    elif status in (Status.NO_NEW_FRAME, Status.NO_VISUAL_CHANGE):
                        no_change += 1
                        if no_change >= self._config.max_no_change:
                            terminal = self._stuck(goal, status.value, execution.detail)
                    elif status != Status.WAITED:
                        terminal = self._stuck(goal, status.value, execution.detail)
                record = ActionRecord(
                    step, number, decision.observation, action, summary, status, ratio
                )
                history.append(record)
                if self._on_step:
                    self._on_step(record)
                if terminal is not None:
                    return terminal
            finally:
                if self._executor.control_released:
                    status = Status.CONTROL_RELEASED
                elif (deadline := budget.when()) is not None and clock() >= deadline:
                    status = "goal_timeout"
                attrs = dict(
                    step=step, frame_number=number, action=action, status=status, diff_ratio=ratio
                )
                ok = status in ("done", "resolved", Status.VERIFIED_CHANGED, Status.WAITED)
                self._span("loop.step", start, ok, **attrs)
        return self._stuck(goal, "max_steps_exceeded", "step budget exhausted")
