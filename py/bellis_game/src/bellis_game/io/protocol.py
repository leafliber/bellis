"""Bellis V2 realtime-core & permit-control RPC protocol types aligned with JSON fixtures."""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import ClassVar, Final, cast

from ._codec import F64, I32, U16, U32, U64, ProtocolError, TaggedModel, WireModel, decode_tagged

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


class PermitMethods:
    LEASE_RENEW: Final = "lease.renew"
    LEASE_REVOKE: Final = "lease.revoke"
    INPUT_STOP: Final = "input.stop"
    INPUT_RELEASED: Final = "input.released"
    HEALTH: Final = "health"


class CoreErrorCode:
    PROTOCOL_VERSION_MISMATCH: Final = -32001
    FRAME_RING_MISMATCH: Final = -32002
    CAPTURE_UNSUPPORTED: Final = -32003
    LEASE_REFUSED: Final = -32004
    AUDIO_RING_MISMATCH: Final = -32005
    INPUT_POLICY_CONFLICT: Final = -32006


class MouseButton(StrEnum):
    LEFT = "left"
    RIGHT = "right"
    MIDDLE = "middle"


class ReleaseVerification(StrEnum):
    UNVERIFIED = "unverified"
    UP_FAILED = "up_failed"
    VERIFIED = "verified"
    RESIDUAL = "residual"
    UNAVAILABLE = "unavailable"
    SUPERSEDED = "superseded"


class ReleaseReason(StrEnum):
    CORE_START = "core_start"
    GENERATION_REVOKED = "generation_revoked"
    PRODUCER_CHANGED = "producer_changed"
    HEARTBEAT_TIMEOUT = "heartbeat_timeout"
    DEADLINE_EXPIRED = "deadline_expired"
    FRAME_STALE = "frame_stale"
    LEASE_EXPIRED = "lease_expired"
    LEASE_REVOKED = "lease_revoked"
    INPUT_STOP = "input_stop"
    LEASE_SOURCE_LOST = "lease_source_lost"
    NO_LEASE = "no_lease"
    FOCUS_LOST = "focus_lost"
    TAKEOVER = "takeover"
    EMERGENCY_STOP = "emergency_stop"
    INJECTION_BLOCKED = "injection_blocked"
    HOOK_LOST = "hook_lost"
    MAX_HOLD = "max_hold"
    SHUTDOWN = "shutdown"
    CORE_CONNECTION_LOST = "core_connection_lost"
    STDIN_CLOSED = "stdin_closed"


class LeaseStatus(StrEnum):
    NOT_GRANTED = "not_granted"
    VALID = "valid"
    EXPIRED = "expired"
    REVOKED = "revoked"
    SOURCE_LOST = "source_lost"


class CaptureState(StrEnum):
    IDLE = "idle"
    SEARCHING = "searching"
    CAPTURING = "capturing"


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


class _Msg(WireModel):
    pass


class _Tagged(TaggedModel):
    pass


@dataclass(frozen=True, slots=True)
class Empty(_Msg):
    pass


@dataclass(frozen=True, slots=True)
class CoreHelloParams(_Msg):
    protocol_version: U32
    core_version: str


@dataclass(frozen=True, slots=True)
class CoreHelloResult(_Msg):
    protocol_version: U32


@dataclass(frozen=True, slots=True)
class FrameRingAttachParams(_Msg):
    name: str
    size_bytes: U64
    layout_version: U32
    slot_count: U32
    slot_stride: U64
    max_width: U32
    max_height: U32


@dataclass(frozen=True, slots=True)
class AudioRingAttachParams(_Msg):
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
class WindowTargetParams(_Msg):
    process_name: str
    window_class: str | None = None
    title: str | None = None


@dataclass(frozen=True, slots=True)
class Producer(_Msg):
    id: str
    generation: U64


@dataclass(frozen=True, slots=True)
class ProducerHeartbeatParams(_Msg):
    producer: Producer
    seq: U64


@dataclass(frozen=True, slots=True)
class ProducerRevokeParams(_Msg):
    generation: U64


@dataclass(frozen=True, slots=True)
class ProducerRevokeResult(_Msg):
    release_id: U64 | None


@dataclass(frozen=True, slots=True)
class LeaseRenewParams(_Msg):
    token: U64
    expires_ns: U64


@dataclass(frozen=True, slots=True)
class LeaseRevokeParams(_Msg):
    token: U64


@dataclass(frozen=True, slots=True)
class InputStopParams(_Msg):
    through_token: U64 | None = None


@dataclass(frozen=True, slots=True)
class InputStopResult(_Msg):
    release_id: U64 | None


@dataclass(frozen=True, slots=True)
class NormRect(_Msg):
    left: F64
    top: F64
    right: F64
    bottom: F64


@dataclass(frozen=True, slots=True)
class InputPolicy(_Msg):
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
class HeldKey(_Tagged):
    TAG: ClassVar[str] = "key"
    scan_code: U16


@dataclass(frozen=True, slots=True)
class HeldMouseButton(_Tagged):
    TAG: ClassVar[str] = "mouse_button"
    button: MouseButton


@dataclass(frozen=True, slots=True)
class HeldAxis(_Tagged):
    TAG: ClassVar[str] = "axis"
    axis: str
    value: F64


type HeldInput = HeldKey | HeldMouseButton | HeldAxis


@dataclass(frozen=True, slots=True)
class Click(_Tagged):
    TAG: ClassVar[str] = "click"
    id: U64
    x: U32
    y: U32
    button: MouseButton


@dataclass(frozen=True, slots=True)
class KeyPress(_Tagged):
    TAG: ClassVar[str] = "key_press"
    id: U64
    scan_code: U16


@dataclass(frozen=True, slots=True)
class Scroll(_Tagged):
    TAG: ClassVar[str] = "scroll"
    id: U64
    x: U32
    y: U32
    notches: I32


@dataclass(frozen=True, slots=True)
class MouseMove(_Tagged):
    TAG: ClassVar[str] = "mouse_move"
    id: U64
    dx: I32
    dy: I32


type Action = Click | KeyPress | Scroll | MouseMove


@dataclass(frozen=True, slots=True)
class ControlStep(_Msg):
    offset_ns: U64
    held: tuple[HeldInput, ...] = ()
    actions: tuple[Action, ...] = ()


@dataclass(frozen=True, slots=True)
class ActionBlock(_Msg):
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
class Accepted(_Tagged):
    TAG: ClassVar[str] = "accepted"


@dataclass(frozen=True, slots=True)
class Rejected(_Tagged):
    TAG: ClassVar[str] = "rejected"
    reason: RejectReason
    message: str


type ActionSubmitResult = Accepted | Rejected


def parse_action_submit_result(raw: object) -> ActionSubmitResult:
    return cast(
        "ActionSubmitResult", decode_tagged(raw, (Accepted, Rejected), "ActionSubmitResult")
    )


@dataclass(frozen=True, slots=True)
class Executed(_Tagged):
    TAG: ClassVar[str] = "executed"
    id: U64
    at_ns: U64


@dataclass(frozen=True, slots=True)
class Dropped(_Tagged):
    TAG: ClassVar[str] = "dropped"
    id: U64
    reason: DropReason


@dataclass(frozen=True, slots=True)
class Uncertain(_Tagged):
    TAG: ClassVar[str] = "uncertain"
    id: U64
    at_ns: U64


type ActionOutcome = Executed | Dropped | Uncertain


@dataclass(frozen=True, slots=True)
class ActionReceiptParams(_Msg):
    producer: Producer
    block_seq: U64
    outcomes: tuple[ActionOutcome, ...]


@dataclass(frozen=True, slots=True)
class InputReleasedParams(_Msg):
    release_id: U64
    token: U64 | None
    reason: ReleaseReason
    producer: Producer | None
    released_at_ns: U64
    verification: ReleaseVerification
    residual_items: tuple[HeldInput, ...]


@dataclass(frozen=True, slots=True)
class LatestFrame(_Msg):
    frame_number: U64
    capture_ns: U64


@dataclass(frozen=True, slots=True)
class LatestAudio(_Msg):
    block_number: U64
    capture_ns: U64


@dataclass(frozen=True, slots=True)
class HealthParams(_Msg):
    now_ns: U64
    capture: CaptureState
    audio: CaptureState
    inputs_held: bool
    producer: Producer | None
    latest_frame: LatestFrame | None
    latest_audio: LatestAudio | None
    lease: LeaseStatus
    queue_depth: U32


_Msg._NS = globals()  # pyright: ignore[reportPrivateUsage]
_Tagged._NS = globals()  # pyright: ignore[reportPrivateUsage]

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
