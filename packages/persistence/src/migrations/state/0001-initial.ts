import type { MigrationDefinition } from "../definition.js";

/**
 * state.db 0001：Phase 1 最小事实表（P2 文档 §7）。
 *
 * - schema_migrations 由 Runner 的 bootstrap 独占创建（IF NOT EXISTS），
 *   版本化 Migration 内不再重复建表。
 * - STRICT 表：拒绝隐式类型转换，TEXT 列读出必为 string。
 * - 十进制 TEXT 承载无损大整数（Watermark/Server Seq/Aggregate Seq）。
 * - 外键删除策略显式采用默认 NO ACTION：Phase 1 不做隐式级联清理
 *   历史事实。
 * - scenes 的恢复排序依据是 commit_ordinal（事务内会话级递增），
 *   committed_at_ms 仅审计。
 */

export const stateInitial: MigrationDefinition = {
  version: 1,
  name: "initial",
  sql: `
CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  created_at_ms INTEGER NOT NULL,
  latest_server_seq TEXT NOT NULL DEFAULT '0',
  updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE session_records (
  record_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  record_type TEXT NOT NULL,
  aggregate_id TEXT,
  aggregate_seq TEXT,
  trace_id TEXT NOT NULL,
  occurred_at_ms INTEGER NOT NULL,
  schema_version INTEGER NOT NULL,
  payload_json TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX idx_session_records_aggregate
  ON session_records(session_id, aggregate_id, aggregate_seq)
  WHERE aggregate_id IS NOT NULL AND aggregate_seq IS NOT NULL;
CREATE INDEX idx_session_records_session
  ON session_records(session_id, occurred_at_ms, record_id);
CREATE INDEX idx_session_records_trace ON session_records(trace_id);

CREATE TABLE signal_watermarks (
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  source TEXT NOT NULL,
  watermark TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (session_id, source)
) STRICT;

CREATE TABLE scenes (
  scene_id TEXT PRIMARY KEY,
  cycle_id TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  status TEXT NOT NULL CHECK (status IN ('committed')),
  commit_ordinal INTEGER NOT NULL,
  committed_at_ms INTEGER NOT NULL,
  schema_version INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  UNIQUE (session_id, commit_ordinal)
) STRICT;

CREATE TABLE outbox (
  outbox_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  topic TEXT NOT NULL,
  partition_key TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'in_flight', 'delivered', 'dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at_ms INTEGER NOT NULL,
  lease_until_ms INTEGER,
  lease_owner_instance_id TEXT,
  last_error_code TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_outbox_claim ON outbox(status, available_at_ms, outbox_id);

CREATE TABLE idempotency_keys (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  result_type TEXT NOT NULL,
  result_ref TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (scope, key)
) STRICT;
`,
};
