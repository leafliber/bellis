"""Translate untrusted decisions into proposals and resolve input against the game policy."""

from collections.abc import Mapping
from dataclasses import dataclass
from time import perf_counter_ns
from typing import cast

from bellis_common.agent_events import valid_decision_options

from bellis_game.io import RingFrame
from bellis_game.io import protocol as rpc
from bellis_game.perception import FrameTransform, GameProfile


class ProposalError(ValueError):
    """The decision does not conform to the selected action's schema."""


class ActionPolicyError(ValueError):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def _text(value: object, name: str, *, optional: bool = False) -> str:
    if not isinstance(value, str) or (not optional and not value.strip()):
        raise ProposalError(f"invalid {name}")
    return value


def _coordinate(value: object) -> float:
    if (type(value) is int or type(value) is float) and 0 <= value <= 1:
        return float(value)
    raise ProposalError("expected normalized coordinates in [0, 1]")


@dataclass(frozen=True, slots=True)
class ClickProposal:
    nx: float
    ny: float
    target: str
    expected_effect: str = ""


@dataclass(frozen=True, slots=True)
class KeyProposal:
    key: str
    reason: str = ""
    expected_effect: str = ""


@dataclass(frozen=True, slots=True)
class ScrollProposal:
    nx: float
    ny: float
    notches: int
    target: str
    expected_effect: str = ""

    def __post_init__(self) -> None:
        if type(self.notches) is not int or not -10 <= self.notches <= 10 or self.notches == 0:
            raise ProposalError("notches must be a non-zero integer in [-10, 10]")


@dataclass(frozen=True, slots=True)
class HoldKeyProposal:
    key: str
    duration_ms: int
    reason: str = ""
    expected_effect: str = ""

    def __post_init__(self) -> None:
        if type(self.duration_ms) is not int or not 100 <= self.duration_ms <= 1500:
            raise ProposalError("hold duration_ms must be an integer in [100, 1500]")


@dataclass(frozen=True, slots=True)
class WaitProposal:
    duration_ms: int
    reason: str = ""

    def __post_init__(self) -> None:
        if type(self.duration_ms) is not int or not 100 <= self.duration_ms <= 5000:
            raise ProposalError("duration_ms must be an integer in [100, 5000]")


@dataclass(frozen=True, slots=True)
class DoneProposal:
    evidence: str

    def __post_init__(self) -> None:
        _text(self.evidence, "evidence")


@dataclass(frozen=True, slots=True)
class StopProposal:
    reason: str
    detail: str = ""

    def __post_init__(self) -> None:
        _text(self.reason, "reason")


@dataclass(frozen=True, slots=True)
class AskDecisionProposal:
    question: str
    options: tuple[str, ...]
    reason: str = ""

    def __post_init__(self) -> None:
        _text(self.question, "question")
        _text(self.reason, "reason", optional=True)
        if not valid_decision_options(self.options):
            raise ProposalError("expected 2 to 4 distinct non-empty options")


type InputProposal = ClickProposal | KeyProposal | ScrollProposal | HoldKeyProposal
type ActionProposal = (
    InputProposal | WaitProposal | DoneProposal | StopProposal | AskDecisionProposal
)


@dataclass(frozen=True, slots=True)
class AgentDecision:
    observation: str
    proposal: ActionProposal
    highlight: str = ""

    def __post_init__(self) -> None:
        _text(self.observation, "observation")
        object.__setattr__(
            self, "highlight", _text(self.highlight, "highlight", optional=True).strip()
        )


DECISION_REQUIRED_KEYS = frozenset({"observation", "action"})
_ACTION_FIELDS = {
    "click": {"nx", "ny", "target", "expected_effect"},
    "key_press": {"key", "reason", "expected_effect"},
    "scroll": {"nx", "ny", "notches", "target", "expected_effect"},
    "hold_key": {"key", "duration_ms", "reason", "expected_effect"},
    "wait": {"duration_ms", "reason"},
    "ask_decision": {"question", "options", "reason"},
    "done": {"evidence"},
    "stop": {"reason", "detail"},
}
_COMMON_KEYS = DECISION_REQUIRED_KEYS | {"highlight"}
DECISION_ALLOWED_KEYS = _COMMON_KEYS.union(*_ACTION_FIELDS.values())
_NULLABLE_KEYS = DECISION_ALLOWED_KEYS - DECISION_REQUIRED_KEYS


def parse_agent_decision(raw: Mapping[str, object]) -> AgentDecision:
    raw = {k: v for k, v in raw.items() if v is not None or k not in _NULLABLE_KEYS}
    match raw:
        case {"observation": str() as observation, "action": str() as action}:
            allowed = _ACTION_FIELDS.get(action)
            if allowed is None or raw.keys() - _COMMON_KEYS - allowed:
                raise ProposalError("unknown action or unexpected action fields")
        case _:
            raise ProposalError("expected an observation and a supported action")

    def optional(field: str) -> str:
        return _text(raw.get(field, ""), field, optional=True)

    proposal: ActionProposal
    match action:
        case "click":
            proposal = ClickProposal(
                _coordinate(raw.get("nx")),
                _coordinate(raw.get("ny")),
                _text(raw.get("target"), "target"),
                optional("expected_effect"),
            )
        case "key_press":
            proposal = KeyProposal(
                _text(raw.get("key"), "key"), optional("reason"), optional("expected_effect")
            )
        case "scroll":
            notches = raw.get("notches")
            if type(notches) is not int:
                raise ProposalError("notches must be an integer")
            proposal = ScrollProposal(
                _coordinate(raw.get("nx")),
                _coordinate(raw.get("ny")),
                notches,
                _text(raw.get("target"), "target"),
                optional("expected_effect"),
            )
        case "hold_key":
            duration = raw.get("duration_ms")
            if type(duration) is not int:
                raise ProposalError("duration_ms must be an integer")
            proposal = HoldKeyProposal(
                _text(raw.get("key"), "key"),
                duration,
                optional("reason"),
                optional("expected_effect"),
            )
        case "wait":
            duration = raw.get("duration_ms")
            if type(duration) is not int:
                raise ProposalError("duration_ms must be an integer")
            proposal = WaitProposal(duration, optional("reason"))
        case "ask_decision":
            options = raw.get("options")
            if not isinstance(options, list):
                raise ProposalError("expected options list")
            proposal = AskDecisionProposal(
                _text(raw.get("question"), "question"),
                tuple(_text(item, "option").strip() for item in cast(list[object], options)),
                optional("reason"),
            )
        case "done":
            proposal = DoneProposal(_text(raw.get("evidence"), "evidence"))
        case _:
            proposal = StopProposal(_text(raw.get("reason"), "reason"), optional("detail"))
    return AgentDecision(observation, proposal, optional("highlight"))


@dataclass(frozen=True, slots=True)
class ResolvedClick:
    x: int
    y: int
    button: rpc.MouseButton
    nx: float
    ny: float
    target: str


@dataclass(frozen=True, slots=True)
class ResolvedKeyPress:
    key: str
    scan_code: int


@dataclass(frozen=True, slots=True)
class ResolvedScroll:
    x: int
    y: int
    notches: int
    nx: float
    ny: float
    target: str


@dataclass(frozen=True, slots=True)
class ResolvedHoldKey:
    key: str
    scan_code: int
    duration_ms: int


type ResolvedAction = ResolvedClick | ResolvedKeyPress | ResolvedScroll | ResolvedHoldKey


def _resolve_point(
    nx: float, ny: float, *, profile: GameProfile, transform: FrameTransform
) -> tuple[int, int]:
    try:
        x, y = transform.norm_to_client(nx, ny)
    except ValueError as exc:
        raise ActionPolicyError("invalid_coordinates") from exc
    if not profile.point_allowed(x, y, transform.source_width, transform.source_height):
        raise ActionPolicyError("point_not_allowed")
    return x, y


def resolve_input_action(
    proposal: InputProposal, *, profile: GameProfile, transform: FrameTransform
) -> ResolvedAction:
    if isinstance(proposal, KeyProposal):
        code = profile.scan_code_for(proposal.key)
        if code is None:
            raise ActionPolicyError("unknown_key")
        if code not in profile.input_policy.press_keys:
            raise ActionPolicyError("key_not_allowed")
        return ResolvedKeyPress(proposal.key, code)
    if isinstance(proposal, HoldKeyProposal):
        code = profile.scan_code_for(proposal.key)
        if code is None:
            raise ActionPolicyError("unknown_key")
        max_hold = profile.input_policy.max_hold_ms
        if code not in profile.input_policy.hold_keys or max_hold is None:
            raise ActionPolicyError("hold_not_allowed")
        if proposal.duration_ms > max_hold - 100:
            raise ActionPolicyError("hold_too_long")
        return ResolvedHoldKey(proposal.key, code, proposal.duration_ms)
    if isinstance(proposal, ScrollProposal):
        if not profile.input_policy.scroll:
            raise ActionPolicyError("scroll_not_allowed")
        x, y = _resolve_point(proposal.nx, proposal.ny, profile=profile, transform=transform)
        return ResolvedScroll(x, y, proposal.notches, proposal.nx, proposal.ny, proposal.target)
    if rpc.MouseButton.LEFT not in profile.input_policy.click_buttons:
        raise ActionPolicyError("button_not_allowed")
    x, y = _resolve_point(proposal.nx, proposal.ny, profile=profile, transform=transform)
    return ResolvedClick(x, y, rpc.MouseButton.LEFT, proposal.nx, proposal.ny, proposal.target)


def build_action_block(
    proposal: InputProposal,
    profile: GameProfile,
    producer: rpc.Producer,
    seq: int,
    frame: RingFrame,
    transform: FrameTransform,
    deadline_s: float,
) -> rpc.ActionBlock:
    resolved = resolve_input_action(proposal, profile=profile, transform=transform)
    if isinstance(resolved, (ResolvedClick, ResolvedScroll)) and (
        transform.frame_number != frame.frame_number
        or transform.capture_ns != frame.capture_ns
        or transform.transform_version != frame.transform_version
        or (transform.source_width, transform.source_height) != (frame.width, frame.height)
    ):
        raise ActionPolicyError("invalid_coordinates")
    start = perf_counter_ns()
    if isinstance(resolved, ResolvedHoldKey):
        duration_ns = resolved.duration_ms * 1_000_000
        deadline = start + duration_ns + int(deadline_s * 1e9)
        steps = (
            rpc.ControlStep(0, held=(rpc.HeldKey(resolved.scan_code),)),
            rpc.ControlStep(duration_ns, held=()),
        )
        return rpc.ActionBlock(producer, seq, frame.frame_number, start, deadline, steps)
    action: rpc.Action
    if isinstance(resolved, ResolvedClick):
        action = rpc.Click(seq, resolved.x, resolved.y, resolved.button)
    elif isinstance(resolved, ResolvedScroll):
        action = rpc.Scroll(seq, resolved.x, resolved.y, resolved.notches)
    else:
        action = rpc.KeyPress(seq, resolved.scan_code)
    deadline = start + int(deadline_s * 1e9)
    step = rpc.ControlStep(0, actions=(action,))
    return rpc.ActionBlock(producer, seq, frame.frame_number, start, deadline, (step,))
