"""Deterministic safety/media host and slow-loop agent for Bellis."""

from typing import TYPE_CHECKING, Any

from .audience import (
    AudienceHub,
    DanmakuCandidate,
    VoteSnapshot,
    looks_like_injection,
    normalize_ballot,
    sanitize_name,
    sanitize_text,
)
from .console import ConsoleConfig, ConsoleServer
from .director import (
    DEFAULT_PERSONA,
    DirectorConfig,
    DirectorResult,
    IntentScanner,
    LlmStreamer,
    OpenAiLlmClient,
    SlowDirector,
    build_messages,
    resolve_llm_api_key,
)
from .game_link import (
    GameController,
    GameLinkConfig,
    GameLinkSnapshot,
    HostGameLink,
    parse_game_directive,
)
from .game_permit import GamePermitConfig, GamePermitSnapshot, HostGamePermit
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
from .speech import (
    Segmenter,
    SpeechArbiter,
    SpeechOutcome,
    SpeechPriority,
    SpeechRequest,
    TtsSynthesizer,
    heard_prefix,
    speakable,
    subtitle_starts,
)
from .stage import StageConfig, StageEvent, StageServer, encode_audio_frame
from .store import (
    EventRecord,
    HostStore,
    IntentRecord,
    IntentSource,
    IntentState,
    StoreError,
    payload_hash,
)
from .tts import (
    MinimaxConfig,
    MiniMaxTtsClient,
    TtsChunk,
    TtsError,
    WordStamp,
    resolve_minimax_api_key,
)
from .watchdog import WATCHDOG_ROLE, WatchdogLink, find_watchdog_executable

__version__ = "0.1.0"

if TYPE_CHECKING:
    from .app import HostApp, HostConfig, StartInfo


def __getattr__(name: str) -> Any:
    # Keep the CLI module unloaded until Python executes it with -m.
    if name in {"HostApp", "HostConfig", "StartInfo"}:
        from .app import HostApp, HostConfig, StartInfo

        return {"HostApp": HostApp, "HostConfig": HostConfig, "StartInfo": StartInfo}[name]
    raise AttributeError(name)


__all__ = [
    "AudienceHub",
    "ConsoleConfig",
    "ConsoleServer",
    "DEFAULT_PERSONA",
    "DanmakuCandidate",
    "DirectorConfig",
    "DirectorResult",
    "EmergencyOutcome",
    "EmergencySummary",
    "EventRecord",
    "GameController",
    "GameLinkConfig",
    "GameLinkSnapshot",
    "GamePermitConfig",
    "GamePermitSnapshot",
    "GateDecision",
    "HostApp",
    "HostConfig",
    "HostGameLink",
    "HostGamePermit",
    "HostMode",
    "HostStore",
    "IntentRecord",
    "IntentRequest",
    "IntentScanner",
    "IntentSource",
    "IntentState",
    "Lease",
    "LeaseUpdate",
    "LlmStreamer",
    "MiniMaxTtsClient",
    "MinimaxConfig",
    "ObsClient",
    "ObsConfig",
    "ObsError",
    "ObsRequestResult",
    "OpenAiLlmClient",
    "RateLimit",
    "SafetyConfig",
    "SafetyCore",
    "SafetyError",
    "SafetySnapshot",
    "Segmenter",
    "SlowDirector",
    "SpeechArbiter",
    "SpeechOutcome",
    "SpeechPriority",
    "SpeechRequest",
    "StageConfig",
    "StageEvent",
    "StageServer",
    "StartInfo",
    "StoreError",
    "TtsChunk",
    "TtsError",
    "TtsSynthesizer",
    "VoteSnapshot",
    "WATCHDOG_ROLE",
    "WatchdogLink",
    "WordStamp",
    "build_messages",
    "encode_audio_frame",
    "find_watchdog_executable",
    "heard_prefix",
    "looks_like_injection",
    "normalize_ballot",
    "obs_auth_string",
    "parse_game_directive",
    "payload_hash",
    "resolve_llm_api_key",
    "resolve_minimax_api_key",
    "resolve_obs_password",
    "sanitize_name",
    "sanitize_text",
    "speakable",
    "subtitle_starts",
]
