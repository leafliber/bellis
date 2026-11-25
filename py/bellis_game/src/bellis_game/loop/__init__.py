"""Public interface for running a bounded, independently authorized game goal."""

from .agent import (
    FastLoop,
    LoopConfig,
    LoopCore,
    VisionModel,
    build_system_prompt,
    build_user_prompt,
)
from .events import ActionRecord, ControlReleased, GoalCompleted, GoalSet, GoalStuck, LoopOutcome

__all__ = [
    "ActionRecord",
    "ControlReleased",
    "FastLoop",
    "GoalCompleted",
    "GoalSet",
    "GoalStuck",
    "LoopConfig",
    "LoopCore",
    "LoopOutcome",
    "VisionModel",
    "build_system_prompt",
    "build_user_prompt",
]
