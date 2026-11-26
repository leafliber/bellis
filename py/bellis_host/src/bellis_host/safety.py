"""Synchronous host safety controls with direct stop notifications."""

import logging
import math
import sqlite3
import time
from collections import deque
from collections.abc import Callable, Collection, Iterable, Mapping, Set
from contextlib import suppress
from dataclasses import dataclass, field, replace
from enum import StrEnum
from threading import RLock

from bellis_common.telemetry import JsonlTelemetry

from .store import HostStore, IntentRecord, IntentSource, IntentState, StoreError


class HostMode(StrEnum):
    SAFE_STOP = "safe_stop"
    LIVE = "live"
    EMERGENCY_STOP = "emergency_stop"


class SafetyError(RuntimeError):
    """A control or lease operation failed closed."""


@dataclass(frozen=True)
class RateLimit:
    max_calls: int
    window_s: float

    def __post_init__(self) -> None:
        count = self.max_calls
        if type(count) is not int or count < 1 or not 0 < self.window_s < math.inf:
            raise ValueError("rate limit requires a positive count and finite positive window")


_TTLS = {"stage.audio": 2.0, "obs.control": 2.0, "obs.stage-url": 2.0, "game.input": 2.0}
_CAPS = {r: r for r in _TTLS} | {"stage.audio": "speech.output"}
_LIMITS = {"speech.output": RateLimit(30, 60.0)}


@dataclass(frozen=True)
class SafetyConfig:
    lease_ttl_s: Mapping[str, float] = field(default_factory=_TTLS.copy)
    lease_capabilities: Mapping[str, str] = field(default_factory=_CAPS.copy)
    rate_limits: Mapping[str, RateLimit] = field(default_factory=_LIMITS.copy)
    safe_stop_exempt_capabilities: frozenset[str] = frozenset({"obs.stage-url"})


@dataclass(frozen=True)
class Lease:
    resource: str
    holder: str
    token: int
    ttl_s: float
    expires_at: float


@dataclass(frozen=True)
class LeaseUpdate:
    resource: str
    lease: Lease | None
    reason: str


@dataclass(frozen=True)
class IntentRequest:
    holder: str
    key: str
    intent_type: str
    target: str
    payload: object
    source: IntentSource
    capabilities: Collection[str]
    time_sensitive: bool = True


@dataclass(frozen=True)
class GateDecision:
    allowed: bool
    reason: str
    intent: IntentRecord | None = None
    duplicate: bool = False


@dataclass(frozen=True)
class EmergencySummary:
    reason: str
    revoked_resources: tuple[str, ...]
    mode: HostMode


@dataclass(frozen=True)
class SafetySnapshot:
    mode: HostMode
    emergency_reason: str | None
    active_leases: tuple[Lease, ...]
    watchdog_acted: bool


def _notify[T](listeners: list[Callable[[T], None]], update: T) -> None:
    for callback in tuple(listeners):
        try:
            callback(update)
        except Exception:
            logging.exception("Host safety listener failed")


class SafetyCore:
    def __init__(
        self,
        store: HostStore,
        *,
        config: SafetyConfig | None = None,
        clock: Callable[[], float] | None = None,
        telemetry: JsonlTelemetry | None = None,
    ) -> None:
        self._store = store
        self._clock = clock or time.monotonic
        self._telemetry = telemetry
        config = config or SafetyConfig()
        self._ttl, self._caps = dict(config.lease_ttl_s), dict(config.lease_capabilities)
        self._exempt = frozenset(config.safe_stop_exempt_capabilities)
        self._mode = HostMode.SAFE_STOP
        self._reason: str | None = None
        self._watchdog = self._closed = False
        self._leases: dict[str, Lease] = {}
        self._updates: list[Callable[[LeaseUpdate], None]] = []
        self._emergencies: list[Callable[[EmergencySummary], None]] = []
        self._windows = {
            cap: (deque[float](maxlen=rate.max_calls), rate.window_s)
            for cap, rate in config.rate_limits.items()
        }
        self._state = RLock()
        self._admission = RLock()
        self._generation = 0

    def on_lease_update(self, cb: Callable[[LeaseUpdate], None]) -> Callable[[], None]:
        self._updates.append(cb)
        return lambda: self._updates.remove(cb)

    def on_emergency(self, cb: Callable[[EmergencySummary], None]) -> Callable[[], None]:
        self._emergencies.append(cb)
        return lambda: self._emergencies.remove(cb)

    def _audit(self, event: str, source: str, reason: str, revoked: dict[str, int]) -> None:
        with suppress(StoreError, sqlite3.Error):
            self._store.record_control(event, source, revoked, reason)
        if self._telemetry:
            with suppress(OSError, ValueError):
                self._telemetry.record(event, attrs={"source": source, "reason": reason})

    def _transition(self, expected: HostMode, mode: HostMode, actor: str, event: str) -> None:
        with self._state:
            if self._closed or self._mode != expected:
                raise SafetyError(f"transition to {mode} requires {expected}")
            self._mode, self._reason, self._watchdog = mode, None, False
        self._audit(event, actor, "", {})

    def start_live(self, *, actor: str = "operator") -> None:
        self._transition(HostMode.SAFE_STOP, HostMode.LIVE, actor, "safety.live")

    def _remove(self, resources: Iterable[str], reason: str) -> dict[str, int]:
        self._generation += 1
        removed = (self._leases.pop(r) for r in tuple(resources))
        now = self._clock()
        revoked = {lease.resource: lease.token for lease in removed if now < lease.expires_at}
        for resource in revoked:
            _notify(self._updates, LeaseUpdate(resource, None, reason))
        return revoked

    def pause_live(self, *, reason: str = "operator_pause") -> int:
        with self._state:
            if self._mode != HostMode.LIVE:
                return 0
            self._mode = HostMode.SAFE_STOP
            restricted = (r for r in self._leases if self._caps[r] not in self._exempt)
            revoked = self._remove(restricted, reason)
        self._audit("safety.paused", "operator", reason, revoked)
        return len(revoked)

    def trigger_emergency(self, reason: str, *, source: str = "operator") -> EmergencySummary:
        with self._state:
            self._mode, self._reason = HostMode.EMERGENCY_STOP, reason
            self._watchdog |= source == "watchdog"
            revoked = self._remove(self._leases, reason)
            summary = EmergencySummary(reason, tuple(revoked), HostMode.EMERGENCY_STOP)
            _notify(self._emergencies, summary)
        self._audit("safety.emergency", source, reason, revoked)
        return summary

    def clear_emergency(self, *, actor: str = "operator") -> None:
        self._transition(HostMode.EMERGENCY_STOP, HostMode.SAFE_STOP, actor, "safety.cleared")

    def record_watchdog_acted(self, reason: str) -> EmergencySummary:
        return self.trigger_emergency(f"watchdog:{reason}", source="watchdog")

    def reconcile_obs_external(self, event: str) -> EmergencySummary | None:
        if self._mode == HostMode.LIVE:
            return self.trigger_emergency(f"obs_external:{event}", source="obs")
        self._audit("obs.external", "obs", event, {})
        return None

    def _blocked(self, caps: Set[str]) -> str | None:
        if self._mode == HostMode.SAFE_STOP and caps <= self._exempt and not self._closed:
            return None
        return None if self._mode == HostMode.LIVE else self._mode.value

    def grant_lease(self, resource: str, holder: str) -> Lease:
        generation = self._generation
        cap, ttl = self._caps.get(resource), self._ttl.get(resource, 0)
        if not holder or not cap or not 0 < ttl < math.inf or self._blocked({cap}):
            raise SafetyError("lease grant denied")
        with self._admission:
            now = self._clock()
            old = self._leases.get(resource)
            if old and old.expires_at > now and old.holder != holder:
                raise SafetyError("resource already held")
            token = self._store.next_lease_token(resource)
            with self._state:
                if generation != self._generation:
                    raise SafetyError("lease grant interrupted")
                lease = Lease(resource, holder, token, ttl, self._clock() + ttl)
                self._leases[resource] = lease
                _notify(self._updates, LeaseUpdate(resource, lease, "granted"))
                return lease

    def renew_lease(self, resource: str, holder: str, token: int) -> Lease:
        with self._state:
            lease = self._leases.get(resource)
            now = self._clock()
            identity = (holder, token)
            if not lease or (lease.holder, lease.token) != identity or now >= lease.expires_at:
                raise SafetyError("lease renewal denied")
            lease = replace(lease, expires_at=now + lease.ttl_s)
            self._leases[resource] = lease
            _notify(self._updates, LeaseUpdate(resource, lease, "renewed"))
            return lease

    def revoke_lease(self, resource: str, reason: str) -> bool:
        with self._state:
            revoked = self._remove(self._leases.keys() & {resource}, reason)
        if revoked:
            self._audit("lease.revoked", "host", reason, revoked)
        return bool(revoked)

    def is_lease_valid(self, resource: str, token: int) -> bool:
        with self._state:
            lease = self._leases.get(resource)
            return bool(lease and lease.token == token and self._clock() < lease.expires_at)

    def authorize_intent(self, request: IntentRequest) -> GateDecision:
        r = request
        caps = frozenset(r.capabilities)
        if not caps or not all(s.strip() for s in (r.holder, r.key, r.intent_type, r.target)):
            return GateDecision(False, "invalid_request")
        if r.source == IntentSource.UNTRUSTED:
            return GateDecision(False, "untrusted_source_denied")
        generation = self._generation
        if reason := self._blocked(caps):
            return GateDecision(False, reason)
        with self._admission:
            now = self._clock()
            windows = [self._windows[cap] for cap in caps & self._windows.keys()]
            if any(len(hits) == hits.maxlen and hits[0] > now - span for hits, span in windows):
                return GateDecision(False, "rate_limited")
            try:
                args = (r.key, r.intent_type, r.target, r.payload, r.source, caps)
                intent, dup = self._store.create_intent(*args, time_sensitive=r.time_sensitive)
            except StoreError:
                return GateDecision(False, "store_unavailable")
            with self._state:
                if self._generation != generation:
                    return GateDecision(False, self._blocked(caps) or "interrupted")
                if dup and r.time_sensitive and intent.state != IntentState.PENDING:
                    return GateDecision(False, "duplicate_intent", intent, True)
                for hits, _ in windows:
                    hits.append(self._clock())
                return GateDecision(True, "ok", intent, dup)

    def snapshot(self) -> SafetySnapshot:
        with self._state:
            now = self._clock()
            active = tuple(lease for lease in self._leases.values() if lease.expires_at > now)
            return SafetySnapshot(self._mode, self._reason, active, self._watchdog)

    def close(self) -> None:
        with self._state:
            if self._closed:
                return
            self._closed = True
            self._mode = HostMode.SAFE_STOP if self._reason is None else HostMode.EMERGENCY_STOP
            revoked = self._remove(self._leases, "closed")
            self._updates.clear()
            self._emergencies.clear()
        self._audit("safety.closed", "host", "closed", revoked)
