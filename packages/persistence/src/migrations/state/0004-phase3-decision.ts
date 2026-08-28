import type { MigrationDefinition } from "../definition.js";

/**
 * state.db 0004：Phase 3 决策域持久化（ADR 0004）。
 *
 * - phase3_signals：入库 Signal 全文 + Session 内单调序号（十进制字符串）
 *   + (session_id, signal_id) 唯一索引承载来源去重；未消费 Signal 据此
 *   重建 Batch（恢复矩阵 §14）。
 * - phase3_decision_state：每 Session 的决策消费水位（Cycle adoption
 *   事务内单调推进；与传输重放用的 signal_watermarks 相互独立）。
 * - phase3_cycles：已采用 Cycle 的原子审计行（adoption 事务写入）。
 * - phase3_tool_runs：Tool Run 状态投影；非幂等崩溃后恢复为 uncertain。
 * - phase3_tool_cache：L2 TTL 缓存（键含 Tool/版本/revision/归一化输入）。
 */
export const statePhase3Decision: MigrationDefinition = {
  version: 4,
  name: "phase3-decision",
  sql: `
CREATE TABLE phase3_signals (
  session_id TEXT NOT NULL,
  sequence TEXT NOT NULL,
  signal_id TEXT NOT NULL,
  priority_class TEXT NOT NULL,
  received_at_ms INTEGER NOT NULL,
  signal_json TEXT NOT NULL,
  PRIMARY KEY (session_id, sequence)
);
CREATE UNIQUE INDEX idx_phase3_signals_dedupe ON phase3_signals (session_id, signal_id);

CREATE TABLE phase3_decision_state (
  session_id TEXT PRIMARY KEY,
  consumed_watermark TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE phase3_cycles (
  session_id TEXT NOT NULL,
  cycle_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  cycle_index INTEGER NOT NULL,
  batch_id TEXT NOT NULL,
  watermark_from TEXT NOT NULL,
  watermark_to TEXT NOT NULL,
  next_action TEXT NOT NULL,
  degraded INTEGER NOT NULL,
  packet_digest TEXT NOT NULL,
  adopted_at_ms INTEGER NOT NULL,
  PRIMARY KEY (session_id, cycle_id)
);

CREATE TABLE phase3_tool_runs (
  session_id TEXT NOT NULL,
  tool_run_id TEXT NOT NULL,
  cycle_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  state TEXT NOT NULL,
  idempotency_key_hash TEXT,
  cache_source TEXT,
  error_code TEXT,
  duration_ms INTEGER,
  result_summary_json TEXT,
  started_at_ms INTEGER,
  finished_at_ms INTEGER,
  PRIMARY KEY (session_id, tool_run_id)
);
CREATE INDEX idx_phase3_tool_runs_cycle ON phase3_tool_runs (session_id, cycle_id);

CREATE TABLE phase3_tool_cache (
  cache_key TEXT PRIMARY KEY,
  tool_name TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL
);
`,
};
