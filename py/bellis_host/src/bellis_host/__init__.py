"""Deterministic safety/media host and slow-loop agent for Bellis."""

from .obs import (
    EmergencyOutcome,
    ObsClient,
    ObsConfig,
    ObsError,
    ObsRequestResult,
    obs_auth_string,
    resolve_obs_password,
)
from .safety import (
    EmergencySummary,
    GateDecision,
    HostMode,
    IntentRequest,
    Lease,
    LeaseUpdate,
    RateLimit,
    SafetyConfig,
    SafetyCore,
    SafetyError,
    SafetySnapshot,
)
from .store import (
    EventRecord,
    HostStore,
    IntentRecord,
    IntentSource,
    IntentState,
    StoreError,
    payload_hash,
)
from .watchdog import WATCHDOG_ROLE, WatchdogLink, find_watchdog_executable

__version__ = "0.1.0"

__all__ = [
    "WATCHDOG_ROLE",
    "EmergencyOutcome",
    "EmergencySummary",
    "EventRecord",
    "GateDecision",
    "HostMode",
    "HostStore",
    "IntentRecord",
    "IntentRequest",
    "IntentSource",
    "IntentState",
    "Lease",
    "LeaseUpdate",
    "ObsClient",
    "ObsConfig",
    "ObsError",
    "ObsRequestResult",
    "RateLimit",
    "SafetyConfig",
    "SafetyCore",
    "SafetyError",
    "SafetySnapshot",
    "StoreError",
    "WatchdogLink",
    "find_watchdog_executable",
    "obs_auth_string",
    "payload_hash",
    "resolve_obs_password",
]
