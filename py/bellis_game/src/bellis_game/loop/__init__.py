"""Public interface for running a bounded, independently authorized game goal."""

from .agent import (
    FastLoop,
    LoopConfig,
    LoopControl,
    LoopCore,
    VisionModel,
    build_system_prompt,
    build_user_prompt,
)
from .events import (
    ActionRecord,
    ControlReleased,
    DecisionNeeded,
    DecisionResolved,
    FastEvent,
    GoalCompleted,
    GoalSet,
    GoalStuck,
    HighlightObserved,
    LoopOutcome,
)
from .session import GameSession, GameSessionConfig

__all__ = [
    "ActionRecord",
    "ControlReleased",
    "DecisionNeeded",
    "DecisionResolved",
    "FastEvent",
    "HighlightObserved",
    "FastLoop",
    "GameSession",
    "GameSessionConfig",
    "GoalCompleted",
    "GoalSet",
    "GoalStuck",
    "LoopConfig",
    "LoopControl",
    "LoopCore",
    "LoopOutcome",
    "VisionModel",
    "build_system_prompt",
    "build_user_prompt",
]
