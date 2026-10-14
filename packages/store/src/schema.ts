/** 数据库结构，版本 1。事件表只追加；许可令牌只增不减，由触发器兜底。 */
export const SCHEMA_VERSION = 1;

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  source TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  recorded_at INTEGER NOT NULL,
  data TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;

CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;

CREATE TABLE IF NOT EXISTS projections (
  name TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  seq INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS intents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  target TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  source TEXT NOT NULL,
  capabilities TEXT NOT NULL,
  time_sensitive INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'executing', 'succeeded', 'failed', 'unknown')),
  result TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS intents_by_state ON intents (state);

CREATE TABLE IF NOT EXISTS lease_tokens (
  resource TEXT PRIMARY KEY,
  token INTEGER NOT NULL CHECK (token > 0)
);

CREATE TRIGGER IF NOT EXISTS lease_tokens_increase BEFORE UPDATE ON lease_tokens
WHEN NEW.token <= OLD.token
BEGIN SELECT RAISE(ABORT, 'lease token must increase'); END;

CREATE TRIGGER IF NOT EXISTS lease_tokens_no_delete BEFORE DELETE ON lease_tokens
BEGIN SELECT RAISE(ABORT, 'lease tokens are never removed'); END;
`;
