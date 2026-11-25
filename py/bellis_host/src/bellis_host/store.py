"""Host intent journal. Open one HostStore per host lifetime to run restart recovery."""

import hashlib
import json
import sqlite3
import time
from collections.abc import Callable, Collection, Generator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from threading import RLock
from typing import Literal, Self


class StoreError(RuntimeError):
    """The journal could not perform the requested operation."""


class IntentState(StrEnum):
    PENDING = "pending"
    EXECUTING = "executing"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    UNKNOWN = "unknown"


class IntentSource(StrEnum):
    OPERATOR = "operator"
    SYSTEM = "system"
    AGENT = "agent"
    UNTRUSTED = "untrusted"


@dataclass(frozen=True)
class EventRecord:
    seq: int
    event_type: str
    source: str
    occurred_at_ms: int
    recorded_at_ms: int
    data: object


@dataclass(frozen=True)
class IntentRecord:
    id: int
    key: str
    intent_type: str
    target: str
    payload_hash: str
    source: IntentSource
    capabilities: frozenset[str]
    time_sensitive: bool
    state: IntentState
    result: object
    error: str | None
    created_at_ms: int
    updated_at_ms: int


def _json(value: object) -> str:
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False
    )


def payload_hash(payload: object) -> str:
    return hashlib.sha256(_json(payload).encode("utf-8")).hexdigest()


_SCHEMA = """
BEGIN IMMEDIATE;
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT OR IGNORE INTO meta VALUES ('schema_version','1');
CREATE TABLE IF NOT EXISTS events(
    seq INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, source TEXT NOT NULL,
    occurred_at_ms INTEGER NOT NULL, recorded_at_ms INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
    BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
    BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS events_no_replace BEFORE INSERT ON events
    WHEN EXISTS (SELECT 1 FROM events WHERE seq=NEW.seq)
    BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TABLE IF NOT EXISTS intents(
    id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, type TEXT NOT NULL,
    target TEXT NOT NULL, payload_hash TEXT NOT NULL, source TEXT NOT NULL,
    capabilities TEXT NOT NULL, time_sensitive INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending','executing','succeeded','failed','unknown')),
    result TEXT, error TEXT, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS intents_state ON intents(state);
CREATE TABLE IF NOT EXISTS lease_tokens(
    resource TEXT PRIMARY KEY, token INTEGER NOT NULL CHECK (token > 0)) STRICT, WITHOUT ROWID;
CREATE TRIGGER IF NOT EXISTS token_increases BEFORE UPDATE ON lease_tokens
    WHEN NEW.token <= OLD.token OR NEW.resource != OLD.resource
    BEGIN SELECT RAISE(ABORT, 'lease token must increase'); END;
CREATE TRIGGER IF NOT EXISTS tokens_no_delete BEFORE DELETE ON lease_tokens
    BEGIN SELECT RAISE(ABORT, 'lease tokens are never removed'); END;
CREATE TRIGGER IF NOT EXISTS tokens_no_reset BEFORE INSERT ON lease_tokens
    WHEN NEW.token <= (SELECT token FROM lease_tokens WHERE resource=NEW.resource)
    BEGIN SELECT RAISE(ABORT, 'lease token must increase'); END;
"""


def _intent(row: sqlite3.Row) -> IntentRecord:
    fields = dict(row)
    fields["intent_type"] = fields.pop("type")
    fields["source"] = IntentSource(row["source"])
    fields["state"] = IntentState(row["state"])
    fields["capabilities"] = frozenset(json.loads(row["capabilities"]))
    fields["time_sensitive"] = bool(row["time_sensitive"])
    fields["result"] = json.loads(row["result"] or "null")
    return IntentRecord(**fields)


class HostStore:
    def __init__(self, path: Path | str, *, now_ms: Callable[[], int] | None = None) -> None:
        if str(path) != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._now = now_ms or (lambda: time.time_ns() // 1_000_000)
        self._lock = RLock()
        self._closed = False
        self._db = sqlite3.connect(path, isolation_level="IMMEDIATE", check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        try:
            with self._access() as db:
                db.execute("PRAGMA busy_timeout = 5000")
                mode = db.execute("PRAGMA journal_mode = WAL").fetchone()[0]
                if str(path) != ":memory:" and mode != "wal":
                    raise StoreError("WAL unavailable")
                db.execute("PRAGMA synchronous = FULL")
                db.executescript(_SCHEMA)
                version = db.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
                if version[0] != "1":
                    raise StoreError("unsupported schema version")
                rows = db.execute(
                    "UPDATE intents SET state='unknown', error='interrupted_by_restart', "
                    "updated_at_ms=? WHERE state IN ('pending','executing') RETURNING *",
                    (self._now(),),
                )
                self.recovered_intents = tuple(sorted(map(_intent, rows), key=lambda i: i.id))
                for intent in self.recovered_intents:
                    self._event("intent.recovered", {"id": intent.id, "key": intent.key})
        except BaseException:
            self.close()
            raise

    @contextmanager
    def _access(self) -> Generator[sqlite3.Connection]:
        try:
            with self._lock, self._db:
                yield self._db
        except sqlite3.Error as exc:
            raise StoreError(str(exc)) from exc

    def _event(
        self, event_type: str, data: object, source: str = "host", occurred_at_ms: int | None = None
    ) -> EventRecord:
        now = self._now()
        occurred = now if occurred_at_ms is None else occurred_at_ms
        encoded = _json(data)
        seq = self._db.execute(
            "INSERT INTO events(type,source,occurred_at_ms,recorded_at_ms,data) VALUES(?,?,?,?,?) "
            "RETURNING seq",
            (event_type, source, occurred, now, encoded),
        ).fetchone()[0]
        return EventRecord(seq, event_type, source, occurred, now, json.loads(encoded))

    def append_event(
        self,
        event_type: str,
        data: object,
        *,
        source: str = "host",
        occurred_at_ms: int | None = None,
    ) -> EventRecord:
        with self._access():
            return self._event(event_type, data, source, occurred_at_ms)

    def list_events(self, *, after_seq: int = 0, limit: int = 200) -> list[EventRecord]:
        with self._access() as db:
            rows = db.execute(
                "SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT ?", (after_seq, limit)
            )
            return [
                EventRecord(seq, kind, src, occurred, recorded, json.loads(data))
                for seq, kind, src, occurred, recorded, data in rows
            ]

    def next_lease_token(self, resource: str) -> int:
        with self._access() as db:
            return db.execute(
                "INSERT INTO lease_tokens VALUES(?1, COALESCE("
                "(SELECT token+1 FROM lease_tokens WHERE resource=?1),1)) "
                "ON CONFLICT(resource) DO UPDATE SET token=excluded.token RETURNING token",
                (resource,),
            ).fetchone()[0]

    def current_lease_token(self, resource: str) -> int:
        with self._access() as db:
            query = "SELECT token FROM lease_tokens WHERE resource=?"
            row = db.execute(query, (resource,)).fetchone()
            return row[0] if row else 0

    def record_control(
        self, event: str, source: str, revoked: Mapping[str, int], reason: str
    ) -> None:
        """Fence revoked tokens and journal the control without superseding a later grant."""
        with self._access() as db:
            db.executemany(
                "UPDATE lease_tokens SET token=token+1 WHERE resource=? AND token=?",
                revoked.items(),
            )
            self._event(event, {"reason": reason, "resources": tuple(revoked)}, source)

    def create_intent(
        self,
        key: str,
        intent_type: str,
        target: str,
        payload: object,
        source: IntentSource,
        capabilities: Collection[str],
        *,
        time_sensitive: bool = True,
    ) -> tuple[IntentRecord, bool]:
        digest = payload_hash(payload)
        with self._access() as db:
            now = self._now()
            caps = _json(sorted(set(capabilities)))
            row = db.execute(
                "INSERT INTO intents(key,type,target,payload_hash,source,capabilities,"
                "time_sensitive,state,created_at_ms,updated_at_ms) "
                "VALUES(?,?,?,?,?,?,?,'pending',?,?) ON CONFLICT(key) DO NOTHING RETURNING *",
                (key, intent_type, target, digest, source, caps, time_sensitive, now, now),
            ).fetchone()
            if row:
                self._event("intent.created", {"id": row["id"], "key": key})
                return _intent(row), False
            existing = _intent(db.execute("SELECT * FROM intents WHERE key=?", (key,)).fetchone())
            if existing.payload_hash != digest:
                raise StoreError("intent key has a different payload hash")
            return existing, True

    def mark_executing(self, intent_id: int) -> IntentRecord:
        with self._access() as db:
            row = db.execute(
                "UPDATE intents SET state='executing', updated_at_ms=? "
                "WHERE id=? AND state='pending' RETURNING *",
                (self._now(), intent_id),
            ).fetchone()
            if not row:
                raise StoreError("intent is not pending")
            return _intent(row)

    def finish_intent(
        self,
        intent_id: int,
        state: Literal[IntentState.SUCCEEDED, IntentState.FAILED, IntentState.UNKNOWN],
        *,
        result: object = None,
        error: str | None = None,
    ) -> IntentRecord:
        if state not in (IntentState.SUCCEEDED, IntentState.FAILED, IntentState.UNKNOWN):
            raise StoreError("expected final intent state")
        with self._access() as db:
            encoded = None if result is None else _json(result)
            row = db.execute(
                "UPDATE intents SET state=?, result=?, error=?, updated_at_ms=? "
                "WHERE id=? AND state IN ('pending','executing') RETURNING *",
                (state, encoded, error, self._now(), intent_id),
            ).fetchone()
            if not row:
                raise StoreError("intent is missing or already final")
            self._event("intent.finished", {"id": intent_id, "key": row["key"], "state": state})
            return _intent(row)

    def get_intent(self, key: str) -> IntentRecord | None:
        with self._access() as db:
            row = db.execute("SELECT * FROM intents WHERE key=?", (key,)).fetchone()
            return _intent(row) if row else None

    @property
    def closed(self) -> bool:
        return self._closed

    def close(self) -> None:
        with self._lock:
            self._db.close()
            self._closed = True

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.close()
