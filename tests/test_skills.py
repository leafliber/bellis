import asyncio
from collections.abc import Callable
from dataclasses import fields, replace
from pathlib import Path
from time import perf_counter_ns
from unittest.mock import Mock

import pytest
from bellis_game.io import FrameRingTornError, RingFrame
from bellis_game.io import protocol as rpc
from bellis_game.perception import encode_frame, load_game_profile
from bellis_game.skills import (
    DECISION_ALLOWED_KEYS,
    DECISION_REQUIRED_KEYS,
    ActionExecutor,
    ActionPolicyError,
    ActionProposal,
    AgentDecision,
    AskDecisionProposal,
    ClickProposal,
    DoneProposal,
    ExecutionConfig,
    ExecutionStatus,
    KeyProposal,
    ProposalError,
    ResolvedClick,
    ResolvedKeyPress,
    StopProposal,
    WaitProposal,
    parse_agent_decision,
    resolve_input_action,
)

PROFILE = load_game_profile(Path(__file__).resolve().parents[1] / "games" / "hsr.toml")
PRODUCER = rpc.Producer("game", 5)
BEFORE = RingFrame(8, 1000, 2, 4, 2, 16, bytes(32))
AFTER = replace(BEFORE, frame_number=9, capture_ns=2000, pixels=bytes([255]) * 32)
TRANSFORM = encode_frame(BEFORE).transform
CLICK = ClickProposal(0.5, 0.5, "confirm")
KEY = KeyProposal("EsC")
FAST = ExecutionConfig(
    receipt_timeout_s=0.04,
    post_action_delay_s=0.001,
    verify_timeout_s=0.04,
    poll_interval_s=0.001,
    settle_window_s=0.001,
    settle_timeout_s=0.15,
)
RELEASE_REASONS = [
    rpc.ReleaseReason.TAKEOVER,
    rpc.ReleaseReason.FOCUS_LOST,
    rpc.ReleaseReason.EMERGENCY_STOP,
]


@pytest.mark.parametrize(
    ("payload", "expected"),
    [
        (
            dict(action="click", nx=0, ny=1, target="ok", expected_effect="open"),
            ClickProposal(0, 1, "ok", "open"),
        ),
        (dict(action="key_press", key="EsC"), KEY),
        (
            dict(action="key_press", key="enter", reason="ready", expected_effect="next"),
            KeyProposal("enter", "ready", "next"),
        ),
        (dict(action="wait", duration_ms=100), WaitProposal(100)),
        (dict(action="wait", duration_ms=5000, reason="loading"), WaitProposal(5000, "loading")),
        (
            dict(
                action="ask_decision", question="Where?", options=[" left ", "right"], reason="fork"
            ),
            AskDecisionProposal("Where?", ("left", "right"), "fork"),
        ),
        (dict(action="done", evidence="menu visible"), DoneProposal("menu visible")),
        (
            dict(action="stop", reason="unknown", detail="new menu"),
            StopProposal("unknown", "new menu"),
        ),
    ],
)
def test_decision(payload: dict[str, object], expected: ActionProposal) -> None:
    assert parse_agent_decision(dict(observation="screen", **payload)) == AgentDecision(
        "screen", expected
    )


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"action": None},
        {"action": []},
        {"action": "scroll"},
        {"action": "ask_decision", "question": " ", "options": ["a", "b"]},
        {"action": "ask_decision", "question": "?", "options": ["a", "b"], "reason": 1},
        *(
            {"action": "ask_decision", "question": "?", "options": opts}
            for opts in (
                [],
                ["a"],
                ["a", "b", "c", "d", "e"],
                ["a", 2],
                ["a", ""],
                [" a", "A "],
                ("a", "b"),
                "ab",
            )
        ),
        {"action": "done", "evidence": "proof", "highlight": False},
        {"action": "stop", "reason": "exit", "observation": " "},
        {"action": "done", "evidence": "proof", "observation": 1},
        {"action": "key_press"},
        {"action": "key_press", "key": " "},
        {"action": "click", "nx": 0, "ny": 0, "target": ""},
        {"action": "click", "nx": 0, "target": "ok"},
        {"action": "click", "nx": 0, "ny": 0, "target": "ok", "expected_effect": False},
        {"action": "done"},
        {"action": "done", "evidence": " "},
        {"action": "stop", "reason": ""},
        {"action": "stop", "reason": "exit", "detail": 2},
        {"action": "wait"},
        {"action": "wait", "duration_ms": 100, "reason": []},
        *({"action": "wait", "duration_ms": d} for d in (99, 5001, "100", True, 100.0)),
        *(
            {"action": "click", "target": "ok", "nx": 0, "ny": 1, name: v}
            for name in ("nx", "ny")
            for v in (True, "0", -0.01, 1.01, float("inf"), float("nan"))
        ),
    ],
)
def test_invalid_decision(payload: dict[str, object]) -> None:
    with pytest.raises(ProposalError):
        parse_agent_decision({"observation": "screen", **payload})


@pytest.mark.parametrize(
    "fields",
    [
        dict(action="click", nx=0, ny=1, target="ok"),
        dict(action="key_press", key="esc"),
        dict(action="wait", duration_ms=100),
        dict(action="done", evidence="proof"),
        dict(action="stop", reason="unknown"),
        dict(action="ask_decision", question="?", options=["a", "b"]),
    ],
)
def test_null_decision_fields(fields: dict[str, object]) -> None:
    required = {"observation": "screen", **fields}
    padded = {**dict.fromkeys(DECISION_ALLOWED_KEYS), **required}
    assert parse_agent_decision(padded) == parse_agent_decision(required)
    assert parse_agent_decision(dict(required, highlight="  rare  ")).highlight == "rare"
    assert parse_agent_decision(dict(required, highlight=None)).highlight == ""
    for field in (*required, "unknown"):
        with pytest.raises(ProposalError):
            parse_agent_decision({**padded, field: None})


def test_action_specific_fields() -> None:
    assert {"action", "observation"} == DECISION_REQUIRED_KEYS
    payloads = [
        dict(action="click", nx=0, ny=0, target="ok", expected_effect="open"),
        dict(action="key_press", key="esc", reason="", expected_effect="exit"),
        dict(action="wait", duration_ms=100, reason=""),
        dict(action="done", evidence="proof"),
        dict(action="stop", reason="unknown", detail=""),
        dict(action="ask_decision", question="?", options=["a", "b"], reason=""),
    ]
    assert DECISION_REQUIRED_KEYS.union({"highlight"}, *payloads) == DECISION_ALLOWED_KEYS
    for payload in payloads:
        for field in (
            (DECISION_ALLOWED_KEYS | {"scan_code", "producer"})
            - payload.keys()
            - {"observation", "highlight"}
        ):
            with pytest.raises(ProposalError):
                parse_agent_decision({"observation": "screen", **payload, field: "extra"})
        with pytest.raises(ProposalError):
            parse_agent_decision(payload)


def test_decision_proposal_constructor() -> None:
    proposal = AskDecisionProposal("Which route?", ("A", "B"))
    for invalid in (
        {"question": " "},
        {"reason": False},
        {"options": ["A", "B"]},
        {"options": ("A", " a")},
        {"options": ("A", 3)},
    ):
        with pytest.raises(ProposalError):
            replace(proposal, **invalid)
    with pytest.raises(ProposalError):
        replace(AgentDecision("screen", proposal), highlight=123)


def test_resolution() -> None:
    transform = replace(TRANSFORM, source_width=1000, source_height=1000)
    crop = replace(
        transform, crop=replace(transform.crop, left=250, top=300, right=750, bottom=800)
    )
    assert resolve_input_action(CLICK, profile=PROFILE, transform=crop) == ResolvedClick(
        500, 550, rpc.MouseButton.LEFT, 0.5, 0.5, "confirm"
    )
    assert resolve_input_action(KEY, profile=PROFILE, transform=crop) == ResolvedKeyPress("EsC", 1)
    full = replace(transform, crop=replace(transform.crop, right=1000, bottom=1000))
    policy = PROFILE.input_policy
    cases = [
        (KEY, replace(policy, press_keys=()), "key_not_allowed"),
        (KeyProposal("unknown"), policy, "unknown_key"),
        (CLICK, replace(policy, click_buttons=(rpc.MouseButton.RIGHT,)), "button_not_allowed"),
        (replace(CLICK, nx=0), policy, "point_not_allowed"),
        (replace(CLICK, nx=0.975, ny=0.02), policy, "point_not_allowed"),
        (replace(CLICK, ny=True), policy, "invalid_coordinates"),
    ]
    for proposal, input_policy, reason in cases:
        with pytest.raises(ActionPolicyError) as err:
            resolve_input_action(
                proposal, profile=replace(PROFILE, input_policy=input_policy), transform=full
            )
        assert err.value.reason == reason


def test_config_and_wait_bounds() -> None:
    for field in fields(FAST):
        for value in [0, -1, True, float("nan"), float("inf")]:
            with pytest.raises(ValueError):
                replace(FAST, **{field.name: value})
    for duration in (True, 99, 5001):
        with pytest.raises(ProposalError):
            WaitProposal(duration)


class Frames:
    def __init__(self, *frames: RingFrame | None) -> None:
        self.frames = list(frames)
        self.reads = 0
        self.read = asyncio.Event()

    def read_latest(self) -> RingFrame | None:
        self.read.set()
        self.reads += 1
        return self.frames[min(self.reads, len(self.frames)) - 1]


class Core:
    def __init__(self) -> None:
        self.blocks: list[rpc.ActionBlock] = []
        self.submitted = asyncio.Event()
        self.respond: Callable[[rpc.ActionBlock], None] | None = None
        self.result: rpc.ActionSubmitResult = rpc.Accepted()
        self.gate: asyncio.Event | None = None

    async def submit_action_block(self, block: rpc.ActionBlock) -> rpc.ActionSubmitResult:
        self.blocks.append(block)
        self.submitted.set()
        if self.respond is not None:
            self.respond(block)
        if self.gate is not None:
            await self.gate.wait()
        return self.result


def executed(block: rpc.ActionBlock) -> rpc.ActionReceiptParams:
    action = block.steps[0].actions[0]
    return rpc.ActionReceiptParams(
        block.producer, block.seq, (rpc.Executed(action.id, AFTER.capture_ns),)
    )


def setup_executor(
    *frames: RingFrame | None, config: ExecutionConfig = FAST
) -> tuple[ActionExecutor, Core, Frames]:
    core, reader = Core(), Frames(*frames)
    executor = ActionExecutor(core, reader, PROFILE, PRODUCER, config=config)
    core.respond = lambda block: executor.on_receipt(executed(block))
    return executor, core, reader


def release(reason: rpc.ReleaseReason) -> rpc.InputReleasedParams:
    return rpc.InputReleasedParams(
        4, None, reason, None, 2222, rpc.ReleaseVerification.VERIFIED, ()
    )


async def test_atomic_inputs() -> None:
    executor, core, frames = setup_executor(BEFORE, AFTER)
    executor.on_released(release(rpc.ReleaseReason.CORE_START))
    assert not executor.control_released and executor.last_release is None
    for proposal in (CLICK, KEY):
        outcome = await executor.execute_input(proposal, before_frame=BEFORE, transform=TRANSFORM)
        assert outcome.status == ExecutionStatus.VERIFIED_CHANGED
        block = core.blocks[-1]
        assert (
            outcome.block_seq == block.seq
            and outcome.base_frame == block.base_frame == BEFORE.frame_number
        )
        assert outcome.receipt == executed(block) and outcome.after_frame == AFTER
        assert outcome.diff and outcome.diff.changed_ratio == 1
        assert block.deadline_ns - block.start_ns == int(FAST.action_deadline_s * 1e9)
        assert block.producer == PRODUCER
        (step,) = block.steps
        (action,) = step.actions
        assert not step.held and step.offset_ns == 0 and action.id == outcome.action_id
        expected = (
            rpc.Click(action.id, 2, 1, rpc.MouseButton.LEFT)
            if proposal == CLICK
            else rpc.KeyPress(action.id, 1)
        )
        assert action == expected
    first, second = core.blocks
    assert first.seq < second.seq and first.steps[0].actions[0].id < second.steps[0].actions[0].id
    assert frames.reads == 3


@pytest.mark.parametrize(
    "frame",
    [
        None,
        replace(AFTER, capture_ns=1999),
        replace(AFTER, frame_number=8),
        replace(AFTER, frame_number=7),
    ],
)
async def test_no_fresh_frame(frame: RingFrame | None) -> None:
    executor, _, _ = setup_executor(frame)
    result = await executor.execute_input(KEY, before_frame=BEFORE, transform=TRANSFORM)
    assert (
        result.status == ExecutionStatus.NO_NEW_FRAME and result.after_frame is result.diff is None
    )


async def test_roi_verification() -> None:
    frame = replace(AFTER, pixels=(bytes(8) + bytes([255]) * 8) * 2)
    executor, _, _ = setup_executor(frame)
    result = await executor.execute_input(
        CLICK,
        before_frame=BEFORE,
        transform=TRANSFORM,
        verify_roi=rpc.NormRect(0, 0, 0.5, 1),
    )
    assert result.status == ExecutionStatus.NO_VISUAL_CHANGE
    assert result.diff and result.diff.changed_ratio == 0


async def test_mean_diff_verification() -> None:
    executor, _, _ = setup_executor(replace(AFTER, pixels=bytes([2]) * 32))
    result = await executor.execute_input(KEY, before_frame=BEFORE, transform=TRANSFORM)
    assert (
        result.status == ExecutionStatus.VERIFIED_CHANGED
        and result.diff
        and result.diff.changed_ratio == 0
    )


async def test_policy_and_rejection() -> None:
    executor, core, frames = setup_executor(AFTER)
    for proposal, transform, reason in [
        (KeyProposal("other"), TRANSFORM, "unknown_key"),
        (CLICK, replace(TRANSFORM, frame_number=7), "invalid_coordinates"),
    ]:
        result = await executor.execute_input(proposal, before_frame=BEFORE, transform=transform)
        assert (result.status, result.detail, result.block_seq) == (
            ExecutionStatus.POLICY_BLOCKED,
            reason,
            None,
        )
    assert not core.blocks
    core.result = rpc.Rejected(rpc.RejectReason.EXPIRED, "late")
    result = await executor.execute_input(KEY, before_frame=BEFORE, transform=TRANSFORM)
    assert result.status == ExecutionStatus.REJECTED and result.detail == "expired"
    assert len(core.blocks) == 1 and frames.reads == 0


@pytest.mark.parametrize(
    ("event", "status"),
    [
        (rpc.Dropped(1, rpc.DropReason.RATE_LIMITED), ExecutionStatus.DROPPED),
        (rpc.Uncertain(1, 2000), ExecutionStatus.UNCERTAIN),
    ],
)
async def test_nonexecuted_receipt(event: rpc.ActionOutcome, status: ExecutionStatus) -> None:
    executor, core, frames = setup_executor(AFTER)
    rec = rpc.ActionReceiptParams(PRODUCER, 1, (event,))
    core.respond = lambda _: executor.on_receipt(rec)
    result = await executor.execute_input(KEY, before_frame=BEFORE, transform=TRANSFORM)
    assert result.status == status and result.receipt == rec and frames.reads == 0


async def test_receipt_correlation_and_late_duplicate() -> None:
    executor, core, frames = setup_executor(AFTER)

    def unrelated(block: rpc.ActionBlock) -> None:
        rec = executed(block)
        executor.on_receipt(replace(rec, producer=replace(PRODUCER, generation=6)))
        executor.on_receipt(replace(rec, block_seq=block.seq + 1))
        executor.on_receipt(replace(rec, outcomes=(rpc.Executed(block.seq + 1, 2000),)))
        executor.on_receipt(replace(rec, outcomes=()))

    core.respond = unrelated
    for _ in range(2):
        result = await executor.execute_input(KEY, before_frame=BEFORE, transform=TRANSFORM)
        assert result.status == ExecutionStatus.RECEIPT_TIMEOUT and frames.reads == 0
        executor.on_receipt(executed(core.blocks[-1]))


@pytest.mark.parametrize("reason", RELEASE_REASONS)
async def test_latched_release(reason: rpc.ReleaseReason) -> None:
    executor, core, frames = setup_executor(AFTER)
    rel = release(reason)
    executor.on_released(rel)
    executor.on_released(release(rpc.ReleaseReason.CORE_START))
    result = await executor.execute_input(CLICK, before_frame=BEFORE, transform=TRANSFORM)
    assert (
        result.status == ExecutionStatus.CONTROL_RELEASED
        and result.release == executor.last_release == rel
    )
    assert executor.control_released and not core.blocks and frames.reads == 0


@pytest.mark.parametrize("reason", RELEASE_REASONS)
@pytest.mark.parametrize("phase", ["submission", "receipt", "delay", "verification"])
async def test_release_during_input(
    reason: rpc.ReleaseReason, phase: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    cfg = replace(
        FAST,
        receipt_timeout_s=10,
        verify_timeout_s=10,
        post_action_delay_s=10 if phase == "delay" else FAST.post_action_delay_s,
    )
    executor, core, frames = setup_executor(BEFORE, config=cfg)
    if phase == "submission":
        core.gate = asyncio.Event()
        core.result = rpc.Rejected(rpc.RejectReason.STOPPING, "")
    elif phase == "receipt":
        core.respond = None
    loop = asyncio.get_running_loop()
    timers = Mock(wraps=loop.call_later)
    monkeypatch.setattr(loop, "call_later", timers)
    async with asyncio.timeout(1):
        task = asyncio.create_task(
            executor.execute_input(KEY, before_frame=BEFORE, transform=TRANSFORM)
        )
        await core.submitted.wait()
        if phase == "verification":
            await frames.read.wait()
        elif phase == "delay":
            while not any(
                call.args[0] == cfg.post_action_delay_s for call in timers.call_args_list
            ):
                await asyncio.sleep(0)
        rel = release(reason)
        executor.on_released(rel)
        outcome = await task
    assert outcome.status == ExecutionStatus.CONTROL_RELEASED and outcome.release == rel
    if phase == "delay":
        assert outcome.receipt == executed(core.blocks[0]) and not frames.reads


async def test_out_of_order_receipts_and_torn_frame(monkeypatch: pytest.MonkeyPatch) -> None:
    executor, core, frames = setup_executor(AFTER, config=replace(FAST, receipt_timeout_s=5))
    core.respond = None
    reader = Mock(side_effect=[FrameRingTornError(), AFTER])
    monkeypatch.setattr(frames, "read_latest", reader)
    async with asyncio.timeout(1):
        first = asyncio.create_task(
            executor.execute_input(KEY, before_frame=BEFORE, transform=TRANSFORM)
        )
        await core.submitted.wait()
        core.submitted.clear()
        second = asyncio.create_task(
            executor.execute_input(CLICK, before_frame=BEFORE, transform=TRANSFORM)
        )
        await core.submitted.wait()
        a, b = core.blocks
        dropped = replace(executed(b), outcomes=(rpc.Dropped(b.seq, rpc.DropReason.SUPERSEDED),))
        executor.on_receipt(dropped)
        assert (await second).status == ExecutionStatus.DROPPED and not first.done()
        executor.on_receipt(executed(a))
        assert (await first).status == ExecutionStatus.VERIFIED_CHANGED
    assert reader.call_count == 2


async def test_release_beats_rejection() -> None:
    executor, core, _ = setup_executor(AFTER)
    rel = release(rpc.ReleaseReason.FOCUS_LOST)
    core.respond = lambda _: executor.on_released(rel)
    core.result = rpc.Rejected(rpc.RejectReason.STOPPING, "")
    result = await executor.execute_input(CLICK, before_frame=BEFORE, transform=TRANSFORM)
    assert result.release == rel and result.status == ExecutionStatus.CONTROL_RELEASED


async def test_deadline_release_preserves_wait_and_settle() -> None:
    quiet = replace(BEFORE, frame_number=9, capture_ns=2_000_000)
    executor, _, frames = setup_executor(BEFORE, quiet)
    rel = release(rpc.ReleaseReason.DEADLINE_EXPIRED)
    async with asyncio.timeout(1):
        waited = asyncio.create_task(executor.execute_wait(WaitProposal(100), before_frame=BEFORE))
        settled = asyncio.create_task(executor.wait_for_settle())
        await frames.read.wait()
        executor.on_released(replace(rel, verification=rpc.ReleaseVerification.UNVERIFIED))
        assert not executor.control_released
        executor.on_released(rel)
        assert executor.last_release is None
        assert await settled == quiet
        assert (await waited).status == ExecutionStatus.WAITED


@pytest.mark.parametrize(
    ("verification", "id_offset"),
    [(rpc.ReleaseVerification.VERIFIED, 0), (rpc.ReleaseVerification.SUPERSEDED, 1)],
)
async def test_input_waits_for_deadline_verification(
    verification: rpc.ReleaseVerification, id_offset: int
) -> None:
    executor, core, _ = setup_executor(AFTER, config=replace(FAST, receipt_timeout_s=1))
    rel = release(rpc.ReleaseReason.DEADLINE_EXPIRED)
    executor.on_released(replace(rel, verification=rpc.ReleaseVerification.UNVERIFIED))
    executor.on_released(replace(rel, release_id=rel.release_id - 1))
    task = asyncio.create_task(
        executor.execute_input(KEY, before_frame=BEFORE, transform=TRANSFORM)
    )
    await asyncio.sleep(0)
    verified_at = perf_counter_ns()
    executor.on_released(
        replace(rel, verification=verification, release_id=rel.release_id + id_offset)
    )
    assert (await asyncio.wait_for(task, 0.25)).status == ExecutionStatus.VERIFIED_CHANGED
    (block,) = core.blocks
    assert block.start_ns >= verified_at


async def test_takeover_interrupts_pending_deadline_verification() -> None:
    executor, core, _ = setup_executor(AFTER, config=replace(FAST, receipt_timeout_s=1))
    rel = release(rpc.ReleaseReason.DEADLINE_EXPIRED)
    executor.on_released(replace(rel, verification=rpc.ReleaseVerification.UNVERIFIED))
    task = asyncio.create_task(
        executor.execute_input(KEY, before_frame=BEFORE, transform=TRANSFORM)
    )
    await asyncio.sleep(0)
    takeover = release(rpc.ReleaseReason.TAKEOVER)
    executor.on_released(takeover)
    result = await asyncio.wait_for(task, 0.25)
    assert result.status == ExecutionStatus.CONTROL_RELEASED and result.release == takeover
    assert not core.blocks


@pytest.mark.parametrize(
    "verification",
    [
        rpc.ReleaseVerification.UP_FAILED,
        rpc.ReleaseVerification.RESIDUAL,
        rpc.ReleaseVerification.UNAVAILABLE,
    ],
)
async def test_deadline_verification_fault_latches_release(
    verification: rpc.ReleaseVerification,
) -> None:
    executor, core, _ = setup_executor(AFTER)
    rel = replace(release(rpc.ReleaseReason.DEADLINE_EXPIRED), verification=verification)
    executor.on_released(replace(rel, verification=rpc.ReleaseVerification.UNVERIFIED))
    executor.on_released(rel)
    assert executor.control_released and executor.last_release == rel
    result = await executor.execute_input(KEY, before_frame=BEFORE, transform=TRANSFORM)
    assert result.status == ExecutionStatus.CONTROL_RELEASED and result.release == rel
    assert not core.blocks


@pytest.mark.parametrize("reason", RELEASE_REASONS)
async def test_release_wakes_wait_and_settle(reason: rpc.ReleaseReason) -> None:
    executor, core, frames = setup_executor(
        BEFORE, config=replace(FAST, settle_timeout_s=10, poll_interval_s=10)
    )
    async with asyncio.timeout(1):
        waited = asyncio.create_task(executor.execute_wait(WaitProposal(5000), before_frame=BEFORE))
        settled = asyncio.create_task(executor.wait_for_settle())
        await frames.read.wait()
        rel = release(reason)
        executor.on_released(rel)
        result = await waited
        assert await settled is None
    assert result.status == ExecutionStatus.CONTROL_RELEASED and result.release == rel
    assert not core.blocks and frames.reads == 1


@pytest.mark.parametrize("frame", [AFTER, None])
async def test_wait(frame: RingFrame | None) -> None:
    executor, core, _ = setup_executor(frame)
    result = await executor.execute_wait(WaitProposal(100), before_frame=BEFORE)
    assert (
        result.status == ExecutionStatus.WAITED and result.after_frame == frame and not core.blocks
    )
    assert (result.diff.changed_ratio if result.diff else None) == (1 if frame else None)


async def test_settle_requires_distinct_separated_frames_and_honors_roi() -> None:
    moving = replace(AFTER, capture_ns=2_000_000)
    early = replace(moving, frame_number=10, capture_ns=2_000_001)
    quiet = replace(
        early, frame_number=11, capture_ns=4_000_000, pixels=(bytes([255]) * 8 + bytes(8)) * 2
    )
    executor, _, frames = setup_executor(None, BEFORE, moving, moving, early, quiet, BEFORE)
    assert await executor.wait_for_settle(roi=rpc.NormRect(0, 0, 0.5, 1)) == quiet
    assert frames.reads == 6


@pytest.mark.parametrize("last", [None, AFTER])
async def test_settle_timeout(last: RingFrame | None) -> None:
    executor, _, frames = setup_executor(last, None, config=replace(FAST, settle_timeout_s=0.02))
    assert await executor.wait_for_settle() == last
    assert frames.reads >= 2
