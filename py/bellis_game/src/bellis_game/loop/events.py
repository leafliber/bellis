"""Discrete goal events shared with callers of the game loop."""

import json
from collections.abc import Sequence
from dataclasses import asdict, dataclass
from math import isfinite

from bellis_game.io.protocol import ReleaseReason, ReleaseVerification


def positive_count(value: object) -> bool:
    return type(value) is int and value >= 1


def positive_time(value: object) -> bool:
    return (type(value) is int or type(value) is float) and isfinite(value) and value > 0


@dataclass(frozen=True, slots=True)
class GoalSet:
    goal_id: str
    description: str
    max_steps: int = 8
    timeout_s: float = 90.0

    def __post_init__(self) -> None:
        if not all(type(s) is str and s.strip() for s in (self.goal_id, self.description)):
            raise ValueError("goal_id and description must be non-empty strings")
        if not positive_count(self.max_steps):
            raise ValueError("max_steps must be a positive integer")
        if not positive_time(self.timeout_s):
            raise ValueError("timeout_s must be finite and positive")


@dataclass(frozen=True, slots=True)
class GoalCompleted:
    goal_id: str
    evidence: str
    steps_taken: int
    last_frame: int


@dataclass(frozen=True, slots=True)
class GoalStuck:
    goal_id: str
    reason: str
    detail: str
    steps_taken: int
    last_frame: int | None


@dataclass(frozen=True, slots=True)
class ControlReleased:
    goal_id: str
    reason: ReleaseReason
    verification: ReleaseVerification
    steps_taken: int


type LoopOutcome = GoalCompleted | GoalStuck | ControlReleased


@dataclass(frozen=True, slots=True)
class ActionRecord:
    step: int
    frame_number: int
    observation: str
    action: str
    summary: str
    status: str
    diff_ratio: float | None = None

    def to_prompt_dict(self) -> dict[str, object]:
        data = asdict(self)
        data.update(observation=self.observation[:256], summary=self.summary[:256])
        if self.diff_ratio is None:
            del data["diff_ratio"]
        return data


def build_user_prompt(
    goal: GoalSet,
    *,
    frame_width: int,
    frame_height: int,
    step_index: int,
    history: Sequence[ActionRecord],
) -> str:
    payload = {
        "goal": goal.description,
        "step": step_index,
        "max_steps": goal.max_steps,
        "frame": {"width": frame_width, "height": frame_height},
        "history": [record.to_prompt_dict() for record in history],
    }
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
