"""Bellis V2 realtime-core & permit-control RPC protocol types aligned with JSON fixtures."""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import ClassVar, Final, cast

from bellis_common.permit import (
    CaptureState,
    Empty,
    HealthParams,
    HeldAxis,
    HeldInput,
    HeldKey,
    HeldMouseButton,
    InputReleasedParams,
    InputStopParams,
    InputStopResult,
    LatestAudio,
    LatestFrame,
    LeaseRenewParams,
    LeaseRevokeParams,
    LeaseStatus,
    MouseButton,
    PermitMethods,
    Producer,
    ReleaseReason,
    ReleaseVerification,
)
from bellis_common.wire_codec import (
    F64,
    I32,
    U16,
    U32,
    U64,
    ProtocolError,
    TaggedModel,
    WireModel,
    decode_tagged,
)

PROTOCOL_VERSION: Final = 1


class CoreMethods:
    CORE_HELLO: Final = "core.hello"
    FRAME_RING_ATTACH: Final = "frame_ring.attach"
    CAPTURE_SET_TARGET: Final = "capture.set_target"
    AUDIO_RING_ATTACH: Final = "audio_ring.attach"
    AUDIO_SET_TARGET: Final = "audio.set_target"
    INPUT_CONFIGURE: Final = "input.configure"
    PRODUCER_HEARTBEAT: Final = "producer.heartbeat"
    PRODUCER_REVOKE: Final = "producer.revoke"
    ACTION_SUBMIT: Final = "action.submit"
    ACTION_RECEIPT: Final = "action.receipt"
    INPUT_RELEASED: Final = "input.released"
    HEALTH: Final = "health"
    SHUTDOWN: Final = "shutdown"


class CoreErrorCode:
    PROTOCOL_VERSION_MISMATCH: Final = -32001
    FRAME_RING_MISMATCH: Final = -32002
    CAPTURE_UNSUPPORTED: Final = -32003
    LEASE_REFUSED: Final = -32004
    AUDIO_RING_MISMATCH: Final = -32005
    INPUT_POLICY_CONFLICT: Final = -32006


class RejectReason(StrEnum):
    STALE_GENERATION = "stale_generation"
    PRODUCER_MISMATCH = "producer_mismatch"
    STALE_SEQ = "stale_seq"
    EXPIRED = "expired"
    INVALID = "invalid"
    NOT_ALLOWED = "not_allowed"
    STOPPING = "stopping"


class DropReason(StrEnum):
    SUPERSEDED = "superseded"
    DUPLICATE = "duplicate"
    RELEASED = "released"
    GEOMETRY_CHANGED = "geometry_changed"
    NOT_ALLOWED = "not_allowed"
    RATE_LIMITED = "rate_limited"


@dataclass(frozen=True, slots=True)
class CoreHelloParams(WireModel):
    protocol_version: U32
    core_version: str


@dataclass(frozen=True, slots=True)
class CoreHelloResult(WireModel):
    protocol_version: U32


@dataclass(frozen=True, slots=True)
class FrameRingAttachParams(WireModel):
    name: str
    size_bytes: U64
    layout_version: U32
    slot_count: U32
    slot_stride: U64
    max_width: U32
    max_height: U32


@dataclass(frozen=True, slots=True)
class AudioRingAttachParams(WireModel):
    name: str
    size_bytes: U64
    layout_version: U32
    block_count: U32
    block_stride: U64
    block_capacity: U32
    sample_rate: U32
    channels: U32
    sample_format: U32


@dataclass(frozen=True, slots=True)
class WindowTargetParams(WireModel):
    process_name: str
    window_class: str | None = None
    title: str | None = None


@dataclass(frozen=True, slots=True)
class ProducerHeartbeatParams(WireModel):
    producer: Producer
    seq: U64


@dataclass(frozen=True, slots=True)
class ProducerRevokeParams(WireModel):
    generation: U64


@dataclass(frozen=True, slots=True)
class ProducerRevokeResult(WireModel):
    release_id: U64 | None


@dataclass(frozen=True, slots=True)
class NormRect(WireModel):
    left: F64
    top: F64
    right: F64
    bottom: F64


@dataclass(frozen=True, slots=True)
class InputPolicy(WireModel):
    click_buttons: tuple[MouseButton, ...]
    press_keys: tuple[U16, ...]
    scroll: bool
    click_regions: tuple[NormRect, ...]
    forbidden_zones: tuple[NormRect, ...]
    press_duration_ms: U32
    max_rate: F64
    hold_keys: tuple[U16, ...]
    hold_buttons: tuple[MouseButton, ...]
    max_hold_ms: U32 | None


@dataclass(frozen=True, slots=True)
class Click(TaggedModel):
    TAG: ClassVar[str] = "click"
    id: U64
    x: U32
    y: U32
    button: MouseButton


@dataclass(frozen=True, slots=True)
class KeyPress(TaggedModel):
    TAG: ClassVar[str] = "key_press"
    id: U64
    scan_code: U16


@dataclass(frozen=True, slots=True)
class Scroll(TaggedModel):
    TAG: ClassVar[str] = "scroll"
    id: U64
    x: U32
    y: U32
    notches: I32


@dataclass(frozen=True, slots=True)
class MouseMove(TaggedModel):
    TAG: ClassVar[str] = "mouse_move"
    id: U64
    dx: I32
    dy: I32


type Action = Click | KeyPress | Scroll | MouseMove


@dataclass(frozen=True, slots=True)
class ControlStep(WireModel):
    offset_ns: U64
    held: tuple[HeldInput, ...] = ()
    actions: tuple[Action, ...] = ()


@dataclass(frozen=True, slots=True)
class ActionBlock(WireModel):
    producer: Producer
    seq: U64
    base_frame: U64
    start_ns: U64
    deadline_ns: U64
    steps: tuple[ControlStep, ...]

    def __post_init__(self) -> None:
        WireModel.__post_init__(self)
        if self.deadline_ns < self.start_ns:
            raise ProtocolError("ActionBlock.deadline_ns must be >= start_ns")
        prev = 0
        for step in self.steps:
            if step.offset_ns < prev:
                raise ProtocolError("ActionBlock step offset_ns must be monotonic")
            prev = step.offset_ns


@dataclass(frozen=True, slots=True)
class Accepted(TaggedModel):
    TAG: ClassVar[str] = "accepted"


@dataclass(frozen=True, slots=True)
class Rejected(TaggedModel):
    TAG: ClassVar[str] = "rejected"
    reason: RejectReason
    message: str


type ActionSubmitResult = Accepted | Rejected


def parse_action_submit_result(raw: object) -> ActionSubmitResult:
    return cast(
        "ActionSubmitResult", decode_tagged(raw, (Accepted, Rejected), "ActionSubmitResult")
    )


@dataclass(frozen=True, slots=True)
class Executed(TaggedModel):
    TAG: ClassVar[str] = "executed"
    id: U64
    at_ns: U64


@dataclass(frozen=True, slots=True)
class Dropped(TaggedModel):
    TAG: ClassVar[str] = "dropped"
    id: U64
    reason: DropReason


@dataclass(frozen=True, slots=True)
class Uncertain(TaggedModel):
    TAG: ClassVar[str] = "uncertain"
    id: U64
    at_ns: U64


type ActionOutcome = Executed | Dropped | Uncertain


@dataclass(frozen=True, slots=True)
class ActionReceiptParams(WireModel):
    producer: Producer
    block_seq: U64
    outcomes: tuple[ActionOutcome, ...]


__all__ = [
    "PROTOCOL_VERSION",
    "Accepted",
    "Action",
    "ActionBlock",
    "ActionOutcome",
    "ActionReceiptParams",
    "ActionSubmitResult",
    "AudioRingAttachParams",
    "CaptureState",
    "Click",
    "ControlStep",
    "CoreErrorCode",
    "CoreHelloParams",
    "CoreHelloResult",
    "CoreMethods",
    "DropReason",
    "Dropped",
    "Empty",
    "Executed",
    "FrameRingAttachParams",
    "HealthParams",
    "HeldAxis",
    "HeldInput",
    "HeldKey",
    "HeldMouseButton",
    "InputPolicy",
    "InputReleasedParams",
    "InputStopParams",
    "InputStopResult",
    "KeyPress",
    "LatestAudio",
    "LatestFrame",
    "LeaseRenewParams",
    "LeaseRevokeParams",
    "LeaseStatus",
    "MouseButton",
    "MouseMove",
    "NormRect",
    "PermitMethods",
    "Producer",
    "ProducerHeartbeatParams",
    "ProducerRevokeParams",
    "ProducerRevokeResult",
    "ProtocolError",
    "RejectReason",
    "Rejected",
    "ReleaseReason",
    "ReleaseVerification",
    "Scroll",
    "Uncertain",
    "WindowTargetParams",
    "parse_action_submit_result",
]
