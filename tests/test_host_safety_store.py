import hashlib
import json
import sqlite3
import subprocess
import sys
from collections.abc import Generator
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from dataclasses import replace
from pathlib import Path
from threading import Event

import pytest
from bellis_common.telemetry import JsonlTelemetry
from bellis_host import (
    EmergencySummary,
    EventRecord,
    GateDecision,
    HostMode,
    HostStore,
    IntentRequest,
    IntentSource,
    IntentState,
    LeaseUpdate,
    RateLimit,
    SafetyConfig,
    SafetyCore,
    SafetyError,
    StoreError,
    payload_hash,
)

SPEAK = IntentRequest(
    "host",
    "hello",
    "say",
    "stage.audio",
    {"text": "你好"},
    IntentSource.AGENT,
    frozenset({"speech.output"}),
)
STAGE_URL = replace(
    SPEAK, key="stage", intent_type="url", target="obs", capabilities=frozenset({"obs.stage-url"})
)


@pytest.fixture
def store() -> Generator[HostStore]:
    with HostStore(":memory:") as journal:
        yield journal


def test_schema_journal_and_fences(tmp_path: Path) -> None:
    path = tmp_path / "nested" / "host.db"
    with HostStore(path, now_ms=lambda: 17) as journal, closing(sqlite3.connect(path)) as db:
        assert db.execute("PRAGMA journal_mode").fetchone() == ("wal",)
        db.execute("""CREATE TRIGGER verify_writer_settings BEFORE INSERT ON events
                      WHEN (SELECT synchronous FROM pragma_synchronous) != 2
                        OR (SELECT timeout FROM pragma_busy_timeout) != 5000
                      BEGIN SELECT RAISE(ABORT, 'unexpected writer settings'); END""")
        assert db.execute("SELECT * FROM meta").fetchall() == [("schema_version", "1")]
        assert journal.append_event("first", {}, occurred_at_ms=0) == EventRecord(
            1, "first", "host", 0, 17, {}
        )
        second = journal.append_event("second", ["α"], source="operator")
        assert journal.list_events(after_seq=1, limit=1) == [second]
        assert journal.list_events(limit=0) == []
        assert journal.current_lease_token("audio") == 0
        assert journal.next_lease_token("audio") == 1
        for sql, error in [
            ("UPDATE events SET data='null'", "events are append-only"),
            ("DELETE FROM events", "events are append-only"),
            ("INSERT OR REPLACE INTO events SELECT * FROM events", "events are append-only"),
            ("UPDATE lease_tokens SET token=1", "lease token must increase"),
            ("UPDATE lease_tokens SET token=0", "lease token must increase"),
            ("INSERT OR REPLACE INTO lease_tokens VALUES('audio',1)", "lease token must increase"),
            ("DELETE FROM lease_tokens", "lease tokens are never removed"),
        ]:
            with pytest.raises(sqlite3.IntegrityError, match=error), db:
                db.execute(sql)
        assert journal.next_lease_token("audio") == 2
    assert journal.closed
    journal.close()
    with pytest.raises(StoreError):
        journal.list_events()


def test_hash_and_idempotency(store: HostStore) -> None:
    data = {"z": [2], "a": "你好"}
    assert payload_hash(data) == hashlib.sha256('{"a":"你好","z":[2]}'.encode()).hexdigest()
    with pytest.raises(ValueError):
        payload_hash(float("nan"))
    args = ("key", "say", "audio", data, IntentSource.SYSTEM, ["speech.output"])
    intent, duplicate = store.create_intent(*args)
    assert not duplicate and intent.state == IntentState.PENDING
    assert store.create_intent(*args) == (intent, True)
    with pytest.raises(StoreError, match="payload"):
        store.create_intent("key", "say", "audio", {}, IntentSource.AGENT, [])
    assert store.get_intent("key") == intent
    assert store.get_intent("missing") is None
    assert store.mark_executing(intent.id).state == IntentState.EXECUTING
    with pytest.raises(StoreError):
        store.mark_executing(intent.id)
    final = store.finish_intent(intent.id, IntentState.SUCCEEDED, result={"cursor": 123})
    assert final.result == {"cursor": 123} and final.state == IntentState.SUCCEEDED
    with pytest.raises(StoreError):
        store.finish_intent(intent.id, IntentState.FAILED)
    assert [e.event_type for e in store.list_events()] == ["intent.created", "intent.finished"]
    with pytest.raises(StoreError):
        store.mark_executing(final.id)


def test_concurrent_fencing_and_idempotency(tmp_path: Path) -> None:
    path = tmp_path / "shared.db"
    with HostStore(path) as first, HostStore(path) as second, ThreadPoolExecutor(4) as pool:
        stores = [first, second] * 8
        tokens = [pool.submit(s.next_lease_token, "audio") for s in stores]
        assert sorted(token.result() for token in tokens) == list(range(1, 17))
        writes = [
            pool.submit(s.create_intent, "key", "say", "audio", {}, IntentSource.AGENT, ())
            for s in stores
        ]
        records = [w.result() for w in writes]
        assert len({record.id for record, _ in records}) == 1
        assert sum(not duplicate for _, duplicate in records) == 1
        assert len(first.list_events()) == 1


def test_crashed_writer_recovers_once_without_replay(tmp_path: Path) -> None:
    path = tmp_path / "host.db"
    program = """
import os, sys
from bellis_host import HostStore, IntentSource, IntentState
store = HostStore(sys.argv[1])
for key in ("pending", "executing", "done"):
    intent, _ = store.create_intent(key, "say", "audio", {}, IntentSource.AGENT, ["speech.output"])
    if key == "executing":
        store.mark_executing(intent.id)
    if key == "done":
        store.finish_intent(intent.id, IntentState.FAILED, error="offline")
os._exit(0)
"""
    subprocess.run([sys.executable, "-c", program, str(path)], check=True, timeout=15)
    with HostStore(path) as journal:
        core = SafetyCore(journal)
        core.start_live()
        assert [i.key for i in journal.recovered_intents] == ["pending", "executing"]
        for intent in journal.recovered_intents:
            assert intent.state == IntentState.UNKNOWN and intent.error == "interrupted_by_restart"
            with pytest.raises(StoreError):
                journal.mark_executing(intent.id)
            denied = core.authorize_intent(replace(SPEAK, key=intent.key, payload={}))
            assert denied == GateDecision(False, "duplicate_intent", intent, True)
        done = journal.get_intent("done")
        assert done and done.state == IntentState.FAILED and done.error == "offline"
    with HostStore(path) as journal:
        assert journal.recovered_intents == ()
        assert [e.event_type for e in journal.list_events()].count("intent.recovered") == 2


def test_failed_audit_rolls_back_intent(tmp_path: Path) -> None:
    path = tmp_path / "host.db"
    with HostStore(path) as journal, closing(sqlite3.connect(path)) as db:
        db.execute("""CREATE TRIGGER reject_audit BEFORE INSERT ON events
                      BEGIN SELECT RAISE(ABORT,'full'); END""")
        core = SafetyCore(journal)
        assert core.authorize_intent(STAGE_URL) == GateDecision(False, "store_unavailable")
        assert journal.get_intent(STAGE_URL.key) is None
        assert journal.list_events() == []


def test_modes_and_leases(tmp_path: Path) -> None:
    now = 10.0
    path = tmp_path / "host.db"
    with HostStore(path) as journal:
        config = SafetyConfig(lease_ttl_s={**SafetyConfig().lease_ttl_s, "obs.stage-url": 5.0})
        core = SafetyCore(journal, config=config, clock=lambda: now)
        updates: list[LeaseUpdate] = []
        unsubscribe = core.on_lease_update(updates.append)
        assert core.snapshot().mode == HostMode.SAFE_STOP
        url = core.grant_lease("obs.stage-url", "console")
        with pytest.raises(SafetyError):
            core.grant_lease("game.input", "host")
        core.start_live()
        with pytest.raises(SafetyError):
            core.start_live()
        lease = core.grant_lease("game.input", "host")
        with pytest.raises(SafetyError):
            core.grant_lease(lease.resource, "other")
        with pytest.raises(SafetyError):
            core.renew_lease(lease.resource, "other", lease.token)
        now += 0.25
        renewal = core.renew_lease(lease.resource, lease.holder, lease.token)
        assert renewal.token == lease.token and renewal.expires_at == 12.25
        now = renewal.expires_at
        assert not core.is_lease_valid(lease.resource, lease.token)
        assert core.snapshot().active_leases == (url,)
        with pytest.raises(SafetyError):
            core.renew_lease(lease.resource, lease.holder, lease.token)
        replacement = core.grant_lease(lease.resource, "other")
        assert replacement.token == 2
        assert core.pause_live() == 1
        assert journal.current_lease_token(lease.resource) == 3
        assert core.snapshot().active_leases == (url,)
        assert updates[-1] == LeaseUpdate(lease.resource, None, "operator_pause")
        unsubscribe()
        assert core.revoke_lease(url.resource, "takeover")
        assert not core.revoke_lease(url.resource, "again")
        assert len(updates) == 5
    with HostStore(path) as journal:
        core = SafetyCore(journal)
        core.start_live()
        assert core.grant_lease(lease.resource, "host").token == 4
        core.close()
        assert journal.current_lease_token(lease.resource) == 5
        assert not core.snapshot().active_leases
        with pytest.raises(SafetyError):
            core.grant_lease(url.resource, "console")


def test_emergency_precedes_storage_even_if_closed(store: HostStore) -> None:
    core = SafetyCore(store)
    core.start_live()
    audio = core.grant_lease("stage.audio", "host")
    url = core.grant_lease("obs.stage-url", "console")
    observed: list[object] = []

    def on_revoke(update: LeaseUpdate) -> None:
        observed.append((update, core.snapshot().active_leases))

    def close_store(summary: EmergencySummary) -> None:
        observed.append((summary, store.current_lease_token(audio.resource)))
        store.close()

    core.on_lease_update(on_revoke)
    unsubscribe = core.on_emergency(close_store)
    summary = core.trigger_emergency("hotkey")
    assert observed == [
        (LeaseUpdate(audio.resource, None, "hotkey"), ()),
        (LeaseUpdate(url.resource, None, "hotkey"), ()),
        (summary, audio.token),
    ]
    assert summary.revoked_resources == (audio.resource, url.resource)
    assert store.closed and core.snapshot().emergency_reason == "hotkey"
    assert core.authorize_intent(STAGE_URL).reason == "emergency_stop"
    with pytest.raises(SafetyError):
        core.start_live()
    with pytest.raises(SafetyError):
        core.renew_lease(url.resource, url.holder, url.token)
    unsubscribe()
    core.clear_emergency()
    assert core.snapshot().mode == HostMode.SAFE_STOP
    core.start_live()
    assert core.authorize_intent(SPEAK).reason == "store_unavailable"
    assert core.trigger_emergency("db offline").mode == HostMode.EMERGENCY_STOP
    assert len(observed) == 3


def test_obs_watchdog_and_telemetry(store: HostStore, tmp_path: Path) -> None:
    with JsonlTelemetry(tmp_path / "safety.jsonl") as telemetry:
        core = SafetyCore(store, telemetry=telemetry)
        assert core.reconcile_obs_external("mute") is None
        core.start_live()
        summary = core.reconcile_obs_external("scene")
        assert summary and summary.reason == "obs_external:scene"
        assert core.reconcile_obs_external("mute") is None
        assert core.record_watchdog_acted("deadline").reason == "watchdog:deadline"
        assert core.snapshot().watchdog_acted
        core.clear_emergency()
        snapshot = core.snapshot()
        assert (snapshot.mode, snapshot.emergency_reason, snapshot.watchdog_acted) == (
            HostMode.SAFE_STOP,
            None,
            False,
        )
    events = store.list_events()
    assert [e.source for e in events] == ["obs", "operator", "obs", "obs", "watchdog", "operator"]
    lines = [json.loads(line) for line in telemetry.path.read_text("utf-8").splitlines()]
    assert [line["span"] for line in lines] == [e.event_type for e in events]
    assert lines[-2]["attrs"]["reason"] == "watchdog:deadline"


def test_emergency_with_closed_store_and_failed_listener(store: HostStore) -> None:
    core = SafetyCore(store)
    core.start_live()
    lease = core.grant_lease("stage.audio", "host")
    updates: list[LeaseUpdate] = []

    def disconnected(_: LeaseUpdate) -> None:
        raise OSError("disconnected")

    core.on_lease_update(disconnected)
    core.on_lease_update(updates.append)
    store.close()
    summary = core.trigger_emergency("stop")
    assert summary == EmergencySummary("stop", (lease.resource,), HostMode.EMERGENCY_STOP)
    assert not core.is_lease_valid(lease.resource, lease.token)
    assert updates == [LeaseUpdate(lease.resource, None, "stop")]


def test_gate_order_and_sliding_windows(store: HostStore) -> None:
    now = 0.0
    config = SafetyConfig(
        rate_limits={"speech.output": RateLimit(2, 4), "obs.control": RateLimit(1, 2)}
    )
    core = SafetyCore(store, clock=lambda: now, config=config)
    for invalid in [
        replace(SPEAK, holder=""),
        replace(SPEAK, key=""),
        replace(SPEAK, intent_type=""),
        replace(SPEAK, target=""),
        replace(SPEAK, capabilities=frozenset()),
    ]:
        assert core.authorize_intent(invalid).reason == "invalid_request"
    assert (
        core.authorize_intent(replace(STAGE_URL, source=IntentSource.UNTRUSTED)).reason
        == "untrusted_source_denied"
    )
    assert core.authorize_intent(SPEAK).reason == "safe_stop"
    assert core.authorize_intent(STAGE_URL).allowed
    assert store.get_intent(SPEAK.key) is None
    core.start_live()
    both = replace(SPEAK, capabilities=frozenset({"speech.output", "obs.control"}))
    first = core.authorize_intent(both)
    assert first.allowed and first.intent and not first.duplicate
    now = 1.0
    assert core.authorize_intent(both).reason == "rate_limited"
    assert core.authorize_intent(replace(SPEAK, key="second")).allowed
    now = 3.99
    assert core.authorize_intent(both).reason == "rate_limited"
    now = 4.0
    assert core.authorize_intent(both) == GateDecision(True, "ok", first.intent, True)
    store.finish_intent(first.intent.id, IntentState.SUCCEEDED)
    now = 8.0
    assert core.authorize_intent(both).reason == "duplicate_intent"
    assert core.authorize_intent(replace(both, time_sensitive=False)).allowed


@pytest.mark.parametrize(
    ("count", "window"), [(0, 1), (-1, 1), (1, 0), (1, -1), (1, float("inf")), (1, float("nan"))]
)
def test_invalid_rate_limits(count: int, window: float) -> None:
    with pytest.raises(ValueError):
        RateLimit(count, window)


def test_stop_interrupts_inflight_authorization(tmp_path: Path) -> None:
    path = tmp_path / "locked.db"
    writing, notified = Event(), Event()

    def timestamp() -> int:
        writing.set()
        return 10

    with HostStore(path, now_ms=timestamp) as journal, closing(sqlite3.connect(path)) as db:
        core = SafetyCore(journal)
        core.start_live()
        core.on_emergency(lambda _: notified.set())
        writing.clear()
        db.execute("BEGIN IMMEDIATE")
        with ThreadPoolExecutor(2) as pool:
            gate = pool.submit(core.authorize_intent, SPEAK)
            try:
                assert writing.wait(3)
                stop = pool.submit(core.trigger_emergency, "operator")
                assert notified.wait(3)
                assert core.snapshot().mode == HostMode.EMERGENCY_STOP
            finally:
                db.rollback()
            assert stop.result().reason == "operator"
            assert gate.result().reason == "emergency_stop"
