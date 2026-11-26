"""Wire messages shared by the permit and controller channels."""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import ClassVar, Final

from .wire_codec import F64, U16, U32, U64, TaggedModel, WireModel


class PermitMethods:
    LEASE_RENEW: Final = "lease.renew"
    LEASE_REVOKE: Final = "lease.revoke"
    INPUT_STOP: Final = "input.stop"
    INPUT_RELEASED: Final = "input.released"
    HEALTH: Final = "health"


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


@dataclass(frozen=True, slots=True)
class Empty(WireModel):
    pass


@dataclass(frozen=True, slots=True)
class Producer(WireModel):
    id: str
    generation: U64


@dataclass(frozen=True, slots=True)
class LeaseRenewParams(WireModel):
    token: U64
    expires_ns: U64


@dataclass(frozen=True, slots=True)
class LeaseRevokeParams(WireModel):
    token: U64


@dataclass(frozen=True, slots=True)
class InputStopParams(WireModel):
    through_token: U64 | None = None


@dataclass(frozen=True, slots=True)
class InputStopResult(WireModel):
    release_id: U64 | None


@dataclass(frozen=True, slots=True)
class HeldKey(TaggedModel):
    TAG: ClassVar[str] = "key"
    scan_code: U16


@dataclass(frozen=True, slots=True)
class HeldMouseButton(TaggedModel):
    TAG: ClassVar[str] = "mouse_button"
    button: MouseButton


@dataclass(frozen=True, slots=True)
class HeldAxis(TaggedModel):
    TAG: ClassVar[str] = "axis"
    axis: str
    value: F64


type HeldInput = HeldKey | HeldMouseButton | HeldAxis


@dataclass(frozen=True, slots=True)
class InputReleasedParams(WireModel):
    release_id: U64
    token: U64 | None
    reason: ReleaseReason
    producer: Producer | None
    released_at_ns: U64
    verification: ReleaseVerification
    residual_items: tuple[HeldInput, ...]


@dataclass(frozen=True, slots=True)
class LatestFrame(WireModel):
    frame_number: U64
    capture_ns: U64


@dataclass(frozen=True, slots=True)
class LatestAudio(WireModel):
    block_number: U64
    capture_ns: U64


@dataclass(frozen=True, slots=True)
class HealthParams(WireModel):
    now_ns: U64
    capture: CaptureState
    audio: CaptureState
    inputs_held: bool
    producer: Producer | None
    latest_frame: LatestFrame | None
    latest_audio: LatestAudio | None
    lease: LeaseStatus
    queue_depth: U32
