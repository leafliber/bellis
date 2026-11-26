"""Shared goal, pacing and outcome messages for the authenticated agent link."""

from dataclasses import dataclass
from math import isfinite
from typing import Final, cast

from .permit_messages import ReleaseReason, ReleaseVerification
from .wire_codec import ProtocolError, TaggedModel, WireModel, decode_tagged

GAME_AGENT_ROLE: Final = "game-agent"
DEFAULT_GAME_LINK_TARGET: Final = "game-link.bellis"


class AgentLinkMethods:
    AGENT_HELLO: Final = "agent.hello"
    HOST_COMMAND: Final = "host.command"
    GAME_EVENT: Final = "game.event"


def positive_count(value: object) -> bool:
    return type(value) is int and value >= 1


def positive_time(value: object) -> bool:
    return (type(value) is int or type(value) is float) and isfinite(value) and value > 0


def _text(value: object) -> None:
    if type(value) is not str or not value.strip():
        raise ProtocolError("expected non-empty text")


def _count(value: object) -> None:
    if type(value) is not int or value < 0:
        raise ProtocolError("expected a non-negative integer")


@dataclass(frozen=True, slots=True)
class AgentHelloParams(WireModel):
    game_id: str
    display_name: str

    def __post_init__(self) -> None:
        _text(self.game_id)
        _text(self.display_name)


@dataclass(frozen=True, slots=True)
class CommandAck(WireModel):
    accepted: bool
    reason: str = ""

    def __post_init__(self) -> None:
        if type(self.accepted) is not bool or not isinstance(self.reason, str):  # pyright: ignore[reportUnnecessaryIsInstance]
            raise ProtocolError("invalid command acknowledgement")


@dataclass(frozen=True, slots=True)
class GoalSet(TaggedModel):
    TAG = "goal_set"
    goal_id: str
    description: str
    max_steps: int = 8
    timeout_s: float = 90.0

    def __post_init__(self) -> None:
        _text(self.goal_id)
        _text(self.description)
        if not positive_count(self.max_steps):
            raise ProtocolError("max_steps must be a positive integer")
        if not positive_time(self.timeout_s):
            raise ProtocolError("timeout_s must be finite and positive")


@dataclass(frozen=True, slots=True)
class GoalCancel(TaggedModel):
    TAG = "goal_cancel"
    goal_id: str | None = None
    reason: str = "cancelled"

    def __post_init__(self) -> None:
        if self.goal_id is not None:
            _text(self.goal_id)


@dataclass(frozen=True, slots=True)
class PacingPause(TaggedModel):
    TAG = "pacing_pause"
    reason: str = "pacing"


@dataclass(frozen=True, slots=True)
class PacingResume(TaggedModel):
    TAG = "pacing_resume"
    reason: str = "resumed"


@dataclass(frozen=True, slots=True)
class GoalCompleted(TaggedModel):
    TAG = "goal_completed"
    goal_id: str
    evidence: str
    steps_taken: int
    last_frame: int

    def __post_init__(self) -> None:
        _text(self.goal_id)
        _count(self.steps_taken)
        _count(self.last_frame)


@dataclass(frozen=True, slots=True)
class GoalStuck(TaggedModel):
    TAG = "goal_stuck"
    goal_id: str
    reason: str
    detail: str
    steps_taken: int
    last_frame: int | None

    def __post_init__(self) -> None:
        _text(self.goal_id)
        _count(self.steps_taken)
        if self.last_frame is not None:
            _count(self.last_frame)


@dataclass(frozen=True, slots=True)
class ControlReleased(TaggedModel):
    TAG = "control_released"
    goal_id: str
    reason: ReleaseReason
    verification: ReleaseVerification
    steps_taken: int

    def __post_init__(self) -> None:
        _text(self.goal_id)
        _count(self.steps_taken)


def valid_decision_options(options: object) -> bool:
    if not isinstance(options, tuple):
        return False
    items = cast(tuple[object, ...], options)
    if not 2 <= len(items) <= 4:
        return False
    distinct = {item.strip().casefold() for item in items if isinstance(item, str) and item.strip()}
    return len(distinct) == len(items)


@dataclass(frozen=True, slots=True)
class DecisionNeeded(TaggedModel):
    TAG = "decision_needed"
    goal_id: str
    decision_id: str
    question: str
    options: tuple[str, ...]
    reason: str = ""

    def __post_init__(self) -> None:
        _text(self.goal_id)
        _text(self.decision_id)
        _text(self.question)
        if not valid_decision_options(self.options):
            raise ProtocolError("expected 2 to 4 distinct non-empty options")
        if not isinstance(self.reason, str):  # pyright: ignore[reportUnnecessaryIsInstance]
            raise ProtocolError("expected string reason")


@dataclass(frozen=True, slots=True)
class DecisionResolved(TaggedModel):
    TAG = "decision_resolved"
    goal_id: str
    decision_id: str
    chosen_index: int
    chosen_option: str
    reason: str = ""

    def __post_init__(self) -> None:
        _text(self.goal_id)
        _text(self.decision_id)
        _text(self.chosen_option)
        if type(self.chosen_index) is not int or not 0 <= self.chosen_index <= 3:
            raise ProtocolError("chosen_index out of range")
        if not isinstance(self.reason, str):  # pyright: ignore[reportUnnecessaryIsInstance]
            raise ProtocolError("expected string reason")


@dataclass(frozen=True, slots=True)
class HighlightObserved(TaggedModel):
    TAG = "highlight_observed"
    goal_id: str
    summary: str
    step: int
    frame_number: int

    def __post_init__(self) -> None:
        _text(self.goal_id)
        _text(self.summary)
        _count(self.step)
        _count(self.frame_number)


type SlowCommand = GoalSet | GoalCancel | PacingPause | PacingResume | DecisionResolved
type LoopOutcome = GoalCompleted | GoalStuck | ControlReleased
type FastEvent = LoopOutcome | DecisionNeeded | HighlightObserved


def parse_slow_command(raw: object) -> SlowCommand:
    return decode_tagged(
        raw, (GoalSet, GoalCancel, PacingPause, PacingResume, DecisionResolved), "host.command"
    )


def parse_fast_event(raw: object) -> FastEvent:
    return decode_tagged(
        raw,
        (GoalCompleted, GoalStuck, ControlReleased, DecisionNeeded, HighlightObserved),
        "game.event",
    )
