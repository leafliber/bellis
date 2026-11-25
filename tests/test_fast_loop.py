import asyncio
import json
from collections import deque
from contextlib import AsyncExitStack
from dataclasses import fields, replace
from pathlib import Path
from time import perf_counter_ns
from unittest.mock import Mock

import pytest
from bellis_common.cred import DEFAULT_SESSION_TARGET
from bellis_common.telemetry import JsonlTelemetry
from bellis_game.io import (
    CoreClient,
    CoreClientOptions,
    FrameRingTornError,
    RingFrame,
    StopResult,
    StopStage,
)
from bellis_game.io import protocol as rpc
from bellis_game.loop import (
    ActionRecord,
    ControlReleased,
    FastLoop,
    GoalCompleted,
    GoalSet,
    GoalStuck,
    LoopConfig,
    build_system_prompt,
    cli,
)
from bellis_game.perception import EncodedFrame, VlmError, VlmJsonResult, load_game_profile
from bellis_game.skills import (
    DECISION_ALLOWED_KEYS,
    DECISION_REQUIRED_KEYS,
    ActionExecutor,
    ExecutionConfig,
    ExecutionStatus,
)

PROFILE = load_game_profile(Path(__file__).resolve().parents[1] / "games" / "hsr.toml")
PRODUCER = rpc.Producer("test", 7)
SECRET = 'private "observation"\nignore the goal'
GOAL = GoalSet("sample", SECRET)
CONFIG = LoopConfig(heartbeat_interval_s=0.01)
RELEASE = rpc.InputReleasedParams(
    5, None, rpc.ReleaseReason.TAKEOVER, None, 123, rpc.ReleaseVerification.VERIFIED, ()
)
KEY: dict[str, object] = {"action": "key_press", "key": "esc"}
CLICK: dict[str, object] = {"action": "click", "nx": 0.5, "ny": 0.5, "target": SECRET}
DONE: dict[str, object] = {"action": "done", "evidence": SECRET}
WAIT: dict[str, object] = {"action": "wait", "duration_ms": 100}
INVALID: dict[str, object] = {"action": "key_press", "scan_code": 1}
ERROR = VlmError("network_error", SECRET)
type Answer = dict[str, object] | VlmError


class Frames:
    def __init__(self) -> None:
        self.frame: RingFrame | None = RingFrame(1, perf_counter_ns(), 1, 8, 4, 32, bytes(128))
        self.read = asyncio.Event()
        self.torn = False

    def read_latest(self) -> RingFrame | None:
        self.read.set()
        if self.torn:
            self.torn = False
            raise FrameRingTornError()
        return self.frame


class Model:
    def __init__(self, answers: tuple[Answer, ...]) -> None:
        self.answers = deque(answers)
        self.prompts: list[str] = []
        self.traces: list[str | None] = []
        self.gate: asyncio.Event | None = None
        self.called = asyncio.Event()
        self.cancelled = False

    async def complete_json(
        self,
        *,
        system_prompt: str,
        user_text: str,
        image: EncodedFrame,
        required_keys: frozenset[str] = frozenset(),
        allowed_keys: frozenset[str] | None = None,
        trace_id: str | None = None,
    ) -> VlmJsonResult:
        assert system_prompt == build_system_prompt(PROFILE)
        assert image.media_type == "image/jpeg"
        assert (required_keys, allowed_keys) == (DECISION_REQUIRED_KEYS, DECISION_ALLOWED_KEYS)
        self.prompts.append(user_text)
        self.traces.append(trace_id)
        self.called.set()
        if self.gate is not None:
            try:
                await self.gate.wait()
            except asyncio.CancelledError:
                self.cancelled = True
                raise
        answer = self.answers.popleft()
        if isinstance(answer, VlmError):
            raise answer
        return VlmJsonResult({"observation": SECRET, **answer}, SECRET, "model", "stop", 1, None)


class Session:
    """Drive the production executor with controlled core receipts and post-action captures."""

    def __init__(
        self, *answers: Answer, config: LoopConfig = CONFIG, telemetry: JsonlTelemetry | None = None
    ) -> None:
        self.frames, self.model = Frames(), Model(answers)
        self.beats: list[int] = []
        self.revoked: list[int] = []
        self.ticking, self.submitted = asyncio.Event(), asyncio.Event()
        self.blocks: list[rpc.ActionBlock] = []
        self.changes: deque[bool] = deque()
        self.records: list[ActionRecord] = []
        self.submit_status = ExecutionStatus.VERIFIED_CHANGED
        self.executor = ActionExecutor(
            self,
            self.frames,
            PROFILE,
            PRODUCER,
            config=ExecutionConfig(
                post_action_delay_s=0.001, receipt_timeout_s=0.05, verify_timeout_s=0.05
            ),
        )
        self.loop = FastLoop(
            self,
            self.frames,
            self.model,
            self.executor,
            PROFILE,
            PRODUCER,
            config=config,
            telemetry=telemetry,
            on_step=self.records.append,
        )

    def send_heartbeat(self, producer: rpc.Producer, seq: int) -> None:
        assert producer == PRODUCER
        self.beats.append(seq)
        if len(self.beats) >= 2:
            self.ticking.set()

    async def revoke_producer(self, generation: int) -> rpc.ProducerRevokeResult:
        self.revoked.append(generation)
        return rpc.ProducerRevokeResult(None)

    async def submit_action_block(self, block: rpc.ActionBlock) -> rpc.ActionSubmitResult:
        self.blocks.append(block)
        self.submitted.set()
        status = self.submit_status
        if status == ExecutionStatus.REJECTED:
            return rpc.Rejected(rpc.RejectReason.NOT_ALLOWED, SECRET)
        if status == ExecutionStatus.RECEIPT_TIMEOUT:
            return rpc.Accepted()
        frame = self.frames.frame
        assert frame is not None
        now = perf_counter_ns()
        event: rpc.ActionOutcome = rpc.Executed(block.seq, now)
        if status == ExecutionStatus.DROPPED:
            event = rpc.Dropped(block.seq, rpc.DropReason.RATE_LIMITED)
        elif status == ExecutionStatus.UNCERTAIN:
            event = rpc.Uncertain(block.seq, now)
        elif status != ExecutionStatus.NO_NEW_FRAME:
            changed = self.changes.popleft() if self.changes else True
            pixels = bytes(p ^ 255 for p in frame.pixels) if changed else frame.pixels
            self.frames.frame = replace(
                frame, frame_number=frame.frame_number + 1, capture_ns=now, pixels=pixels
            )
        self.executor.on_receipt(rpc.ActionReceiptParams(block.producer, block.seq, (event,)))
        return rpc.Accepted()


async def test_completion_history_heartbeat_and_redaction(tmp_path: Path) -> None:
    path = tmp_path / "trace.jsonl"
    with JsonlTelemetry(path) as telemetry:
        s = Session(KEY, CLICK, DONE, telemetry=telemetry)
        s.frames.torn = True
        s.model.gate = s.ticking
        result = await asyncio.wait_for(s.loop.run_goal(GOAL), 2)
        await s.loop.close()
    assert result == GoalCompleted(GOAL.goal_id, SECRET, 3, 3)
    assert s.beats == list(range(1, len(s.beats) + 1)) and s.ticking.is_set()
    assert s.revoked == [PRODUCER.generation]
    assert [block.base_frame for block in s.blocks] == [1, 2]
    assert [r.action for r in s.records] == ["key_press", "click", "done"]
    assert SECRET not in build_system_prompt(PROFILE)
    for i, prompt in enumerate(s.model.prompts):
        assert json.loads(prompt) == {
            "goal": SECRET,
            "step": i + 1,
            "max_steps": GOAL.max_steps,
            "frame": {"width": 8, "height": 4},
            "history": [r.to_prompt_dict() for r in s.records[:i]],
        }
    raw = path.read_text("utf-8")
    assert "private" not in raw and "base64" not in raw
    rows = [json.loads(line) for line in raw.splitlines()]
    assert [row["span"] for row in rows] == ["loop.step"] * 3 + ["loop.goal"]
    assert all(row["ok"] and row["trace_id"] == s.model.traces[0] for row in rows)
    assert all(t == s.model.traces[0] for t in s.model.traces)
    for row, record in zip(rows[:3], s.records, strict=True):
        assert row["attrs"] == dict(
            step=record.step,
            frame_number=record.frame_number,
            action=record.action,
            status=record.status,
            diff_ratio=record.diff_ratio,
        )
    assert rows[-1]["attrs"] == {"outcome": "GoalCompleted", "reason": "done", "steps": 3}


async def test_action_deadline_during_next_model_call_preserves_goal() -> None:
    s = Session(KEY, CLICK, DONE)
    deadline = replace(RELEASE, reason=rpc.ReleaseReason.DEADLINE_EXPIRED)
    async with asyncio.timeout(2):
        goal = asyncio.create_task(s.loop.run_goal(GOAL))
        await s.submitted.wait()
        s.model.called.clear()
        s.model.gate = asyncio.Event()
        await s.model.called.wait()
        assert [(r.action, r.status) for r in s.records] == [
            ("key_press", ExecutionStatus.VERIFIED_CHANGED)
        ]
        s.executor.on_released(replace(deadline, verification=rpc.ReleaseVerification.UNVERIFIED))
        await asyncio.sleep(0)
        s.executor.on_released(deadline)
        s.model.gate.set()
        assert await goal == GoalCompleted(GOAL.goal_id, SECRET, 3, 3)
    assert not s.model.cancelled
    assert [r.action for r in s.records] == ["key_press", "click", "done"]
    key, click = s.blocks
    assert isinstance(key.steps[0].actions[0], rpc.KeyPress)
    assert isinstance(click.steps[0].actions[0], rpc.Click)


async def test_model_stop_redacts_reason(tmp_path: Path) -> None:
    path = tmp_path / "stop.jsonl"
    with JsonlTelemetry(path) as telemetry:
        s = Session({"action": "stop", "reason": SECRET, "detail": "unknown"}, telemetry=telemetry)
        result = await s.loop.run_goal(GOAL)
    assert result == GoalStuck(GOAL.goal_id, SECRET, "unknown", 1, 1)
    assert not s.blocks and s.records[0].action == "stop"
    assert "private" not in path.read_text("utf-8")


@pytest.mark.parametrize("status", [ExecutionStatus.NO_VISUAL_CHANGE, ExecutionStatus.NO_NEW_FRAME])
async def test_no_change_limit(status: ExecutionStatus) -> None:
    s = Session(KEY, KEY, DONE)
    s.submit_status = status
    s.changes.extend((False, False))
    result = await s.loop.run_goal(GOAL)
    assert isinstance(result, GoalStuck) and result.reason == status and result.steps_taken == 2
    assert [r.status for r in s.records] == [status, status]


async def test_verified_change_resets_streak_and_history_is_bounded() -> None:
    s = Session(KEY, KEY, KEY, WAIT, DONE, config=replace(CONFIG, history_limit=2))
    s.changes.extend((False, True, False))
    assert isinstance(await s.loop.run_goal(GOAL), GoalCompleted)
    assert [r.status for r in s.records] == [
        "no_visual_change",
        "verified_changed",
        "no_visual_change",
        "waited",
        "done",
    ]
    assert [r["step"] for r in json.loads(s.model.prompts[-1])["history"]] == [3, 4]


@pytest.mark.parametrize("bad", [ERROR, INVALID])
async def test_transient_decision_errors_recover(bad: Answer) -> None:
    s = Session(bad, KEY, bad, DONE)
    assert isinstance(await s.loop.run_goal(GOAL), GoalCompleted)
    assert len(s.blocks) == 1 and [r.step for r in s.records] == [2, 4]


@pytest.mark.parametrize(
    ("bad", "reason", "detail"),
    [
        (ERROR, "vlm_error", "vlm:network_error"),
        (
            VlmError("http_error", SECRET, status_code=429),
            "vlm_error",
            "vlm:http_error (status=429)",
        ),
        (INVALID, "proposal_error", "consecutive invalid decisions"),
    ],
)
async def test_consecutive_decision_errors(
    bad: Answer, reason: str, detail: str, tmp_path: Path
) -> None:
    path = tmp_path / "errors.jsonl"
    with JsonlTelemetry(path) as telemetry:
        s = Session(bad, bad, DONE, telemetry=telemetry)
        result = await s.loop.run_goal(GOAL)
    assert isinstance(result, GoalStuck) and (result.reason, result.steps_taken) == (reason, 2)
    assert result.detail == detail
    raw = path.read_text("utf-8")
    assert "private" not in raw
    rows = [json.loads(line) for line in raw.splitlines()]
    assert len(rows) == 3 and all(not row["ok"] for row in rows)
    assert s.revoked == [PRODUCER.generation] and not s.blocks


@pytest.mark.parametrize(
    "status",
    [
        ExecutionStatus.POLICY_BLOCKED,
        ExecutionStatus.DROPPED,
        ExecutionStatus.REJECTED,
        ExecutionStatus.UNCERTAIN,
        ExecutionStatus.RECEIPT_TIMEOUT,
    ],
)
async def test_input_failure_is_terminal(status: ExecutionStatus) -> None:
    blocked = status == ExecutionStatus.POLICY_BLOCKED
    s = Session({"action": "key_press", "key": "forbidden"} if blocked else KEY, DONE)
    s.submit_status = status
    result = await s.loop.run_goal(GOAL)
    assert isinstance(result, GoalStuck) and result.reason == status and result.steps_taken == 1
    assert len(s.blocks) == int(not blocked) and s.revoked == [PRODUCER.generation]


@pytest.mark.parametrize("when", ["before", "frame", "model", "input", "wait"])
async def test_release_preempts_active_work(when: str) -> None:
    s = Session(WAIT if when == "wait" else KEY, config=replace(CONFIG, frame_poll_interval_s=20))
    if when == "before":
        s.executor.on_released(RELEASE)
    elif when == "frame":
        s.frames.frame = None
    elif when == "model":
        s.model.gate = asyncio.Event()
    elif when == "input":
        s.submit_status = ExecutionStatus.RECEIPT_TIMEOUT
    async with asyncio.timeout(1):
        work = asyncio.create_task(s.loop.run_goal(GOAL))
        if when != "before":
            event = {
                "frame": s.frames.read,
                "model": s.model.called,
                "input": s.submitted,
                "wait": s.model.called,
            }[when]
            await event.wait()
            s.executor.on_released(RELEASE)
        result = await work
    assert result == ControlReleased(
        GOAL.goal_id, RELEASE.reason, RELEASE.verification, int(when not in {"before", "frame"})
    )
    assert len(s.blocks) == int(when == "input") and s.revoked == [PRODUCER.generation]
    assert s.model.cancelled == (when == "model")


@pytest.mark.parametrize("stale", [True, False])
async def test_frame_timeout(stale: bool) -> None:
    s = Session(config=replace(CONFIG, frame_wait_timeout_s=0.03))
    assert s.frames.frame
    s.frames.frame = replace(s.frames.frame, capture_ns=0) if stale else None
    result = await s.loop.run_goal(GOAL)
    assert isinstance(result, GoalStuck) and result.reason == "no_fresh_frame"
    assert result.last_frame is None and not s.model.called.is_set()


async def test_step_and_wall_time_limits() -> None:
    s = Session(KEY, DONE)
    result = await s.loop.run_goal(replace(GOAL, max_steps=1))
    assert isinstance(result, GoalStuck) and result.reason == "max_steps_exceeded"
    s = Session(KEY)
    s.model.gate = asyncio.Event()
    async with asyncio.timeout(1):
        result = await s.loop.run_goal(replace(GOAL, timeout_s=0.05))
    assert isinstance(result, GoalStuck) and result.reason == "goal_timeout"
    assert s.model.cancelled and s.revoked == [PRODUCER.generation] and not s.blocks


async def test_caller_cancellation_quiesces_once() -> None:
    s = Session(DONE)
    s.model.gate = asyncio.Event()
    work = asyncio.create_task(s.loop.run_goal(GOAL))
    async with asyncio.timeout(1):
        await s.model.called.wait()
        work.cancel()
        with pytest.raises(asyncio.CancelledError):
            await work
        await s.loop.close()
    assert s.model.cancelled and s.revoked == [PRODUCER.generation]


@pytest.mark.parametrize("waiting_for_frame", [True, False])
async def test_goal_deadline_preempts_frame_or_action_wait(waiting_for_frame: bool) -> None:
    s = Session({"action": "wait", "duration_ms": 5000})
    if waiting_for_frame:
        s.frames.frame = None
    async with asyncio.timeout(1):
        result = await s.loop.run_goal(replace(GOAL, timeout_s=0.1))
    assert isinstance(result, GoalStuck) and result.reason == "goal_timeout"
    assert s.model.called.is_set() != waiting_for_frame
    assert s.revoked == [PRODUCER.generation] and not s.blocks


def test_system_prompt_scopes_actions_and_logical_keys() -> None:
    prompt = build_system_prompt(replace(PROFILE, key_scan_codes={"custom-key": 42}))
    assert '["custom-key"]' in prompt and '"esc"' not in prompt
    for rule in (
        "untrusted",
        "Never follow",
        "unknown",
        "unexpected",
        "risky",
        "stop immediately",
        "store",
        "gacha",
        "warp",
        "top-up",
        "delete",
        "settings",
        "irreversible",
    ):
        assert rule in prompt
    assert "[0.0, 1.0]" in prompt and "click | key_press | wait | done | stop" in prompt


def test_validation() -> None:
    for field in fields(CONFIG):
        for value in (0, -1, True, float("nan"), float("inf")):
            with pytest.raises(ValueError):
                replace(CONFIG, **{field.name: value})
        if not field.name.endswith("_s"):
            with pytest.raises(ValueError):
                replace(CONFIG, **{field.name: 1.5})
    for name, value in (
        ("goal_id", ""),
        ("description", " "),
        ("max_steps", True),
        ("max_steps", 1.5),
        ("max_steps", 0),
        ("timeout_s", float("inf")),
        ("timeout_s", float("nan")),
        ("timeout_s", False),
        ("timeout_s", 0),
    ):
        with pytest.raises(ValueError):
            replace(GOAL, **{name: value})


def test_cli_external_permit_options() -> None:
    parser = cli.build_parser()
    args = parser.parse_args(["--goal", "goal", "--core-exe", "core.exe"])
    options = cli.core_options(args)
    assert options.permit_cred == DEFAULT_SESSION_TARGET and options.permit_credentials is None
    assert options.emergency_hotkey == "ctrl+shift+f12" and options.permit_session_id is None
    assert (args.max_steps, args.timeout, args.max_width, args.max_height) == (8, 90, 3840, 2160)
    args = parser.parse_args(
        [
            "--goal",
            "goal",
            "--core-exe",
            "core.exe",
            "--permit-cred",
            "test-session",
            "--permit-session-id",
            "demo",
            "--emergency-hotkey",
            "ctrl+f12",
        ]
    )
    options = cli.core_options(args)
    assert options.permit_credentials is None
    assert options.argv()[-6:] == [
        "--permit-cred",
        "test-session",
        "--permit-session-id",
        "demo",
        "--emergency-hotkey",
        "ctrl+f12",
    ]
    assert cli.main(["--goal", "goal", "--timeout", "nan"]) == 1
    assert cli.report_outcome(GoalCompleted("g", "proof", 1, 1)) == 0
    assert cli.report_outcome(GoalStuck("g", "stop", "", 1, 1)) == 1
    assert cli.report_outcome(ControlReleased("g", RELEASE.reason, RELEASE.verification, 0)) == 2


async def test_cli_setup_failure_stops_started_core(monkeypatch: pytest.MonkeyPatch) -> None:
    core = Mock(spec=CoreClient)
    core.stop.return_value = StopResult(StopStage.SHUTDOWN, 0)
    core.configure_input.side_effect = ValueError("invalid policy")
    constructor = Mock(return_value=core)
    monkeypatch.setattr(cli, "CoreClient", constructor)
    options = CoreClientOptions(Path("core.exe"), permit_cred=DEFAULT_SESSION_TARGET)
    ring = Mock()
    with pytest.raises(ValueError, match="invalid policy"):
        async with AsyncExitStack() as stack:
            await cli.open_loop(stack, options, ring, PROFILE, Mock(), None)
    assert constructor.call_args.args == (options,)
    core.attach_frame_ring.assert_awaited_once_with(ring)
    core.set_capture_target.assert_awaited_once_with(PROFILE.window)
    core.configure_input.assert_awaited_once_with(PROFILE.input_policy)
    core.stop.assert_awaited_once()
