import { OutboxMessageSchema } from "@bellis/contracts";
import { historyBarrierTableExists, hasHistoryBarrier } from "./history-blocked.js";
import type { OutboxMessage } from "@bellis/contracts";
import { PersistenceError } from "../errors.js";
import type { OutboxRetryPolicy } from "../outbox/retry-policy.js";
import { computeRetryDelayMs, shouldDeadLetter } from "../outbox/retry-policy.js";
import { readInt, readText } from "./sqlite-port.js";
import type { SqliteDatabase, SqliteRow } from "./sqlite-port.js";

/**
 * outbox 表：至少一次交付的持久化状态机（docs/protocols/persistence-and-recovery.md）。
 *
 * pending → in_flight → delivered / pending(退避) / dead。
 * 所有状态转换都是条件更新（status + lease_owner_instance_id），
 * 两个 Dispatcher 不可能同时领取或完成同一项。
 * Lease 判断使用调用方（Worker）传入的 leaseNowMs 投影，不在 Repository
 * 内读取墙钟。
 */

export type OutboxRowStatus = "pending" | "in_flight" | "delivered" | "dead";

export const OUTBOX_STATUSES: readonly OutboxRowStatus[] = [
  "pending",
  "in_flight",
  "delivered",
  "dead",
];

function rowToMessage(row: SqliteRow): OutboxMessage {
  const parsed = OutboxMessageSchema.safeParse({
    schemaVersion: readInt(row, "schema_version"),
    outboxId: readText(row, "outbox_id"),
    topic: readText(row, "topic"),
    partitionKey: readText(row, "partition_key"),
    payload: JSON.parse(readText(row, "payload_json")) as unknown,
    createdAtMs: readInt(row, "created_at_ms"),
  });
  if (!parsed.success) {
    throw new PersistenceError("internal", "stored outbox message failed schema validation");
  }
  return parsed.data;
}

export function insertOutboxMessages(
  db: SqliteDatabase,
  sessionId: string,
  messages: readonly OutboxMessage[],
  nowMs: number,
  /** 调度时钟（Lease 单调投影）：available_at_ms 必须与 Claim 同域。 */
  leaseNowMs: number,
): void {
  const statement = db.prepare(
    `INSERT INTO outbox
       (outbox_id, session_id, topic, partition_key, schema_version, payload_json,
        status, attempts, available_at_ms, lease_until_ms, lease_owner_instance_id,
        last_error_code, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, NULL, NULL, NULL, ?, ?)`,
  );
  for (const message of messages) {
    const parsed = OutboxMessageSchema.safeParse(message);
    if (!parsed.success) {
      throw new PersistenceError("outbox_invalid", "outbox message failed schema validation");
    }
    try {
      statement.run(
        parsed.data.outboxId,
        sessionId,
        parsed.data.topic,
        parsed.data.partitionKey,
        parsed.data.schemaVersion,
        JSON.stringify(parsed.data.payload),
        leaseNowMs,
        nowMs,
        nowMs,
      );
    } catch (error) {
      const detail = String(error);
      if (detail.includes("UNIQUE")) {
        throw new PersistenceError("outbox_invalid", "outbox id already exists in this session", {
          cause: error,
        });
      }
      if (detail.includes("FOREIGN KEY")) {
        throw new PersistenceError("session_not_found", `session does not exist`, {
          cause: error,
        });
      }
      throw error;
    }
  }
}

export interface ClaimOutboxQuery {
  readonly limit: number;
  readonly leaseMs: number;
  readonly ownerInstanceId: string;
  readonly leaseNowMs: number;
}

export function claimOutboxRows(db: SqliteDatabase, query: ClaimOutboxQuery): OutboxMessage[] {
  if (query.limit < 1) {
    throw new PersistenceError("invalid_request", "claim limit must be >= 1");
  }
  const claimed: OutboxMessage[] = [];
  db.exec("BEGIN IMMEDIATE");
  try {
    const historyFence = historyBarrierTableExists(db)
      ? `AND (o.topic NOT IN ('memory.observe.v1','memory.usage.v1') OR NOT EXISTS (
          SELECT 1 FROM phase4_history_gaps AS gap WHERE gap.scope_key = COALESCE(
            json_extract(o.payload_json, '$.policy.scopeKey'),
            (SELECT scope_key FROM phase4_memory_session_scopes WHERE session_id = o.session_id))
        ))`
      : "";
    // 可领取 = 到期的 pending，或 Lease 已到期未被完成的 in_flight
    // （Dispatcher/Publisher 卡死但 Worker 存活时也能在同一 Worker
    // 生命周期内回收，不必等待 Worker 重启——评审阻断项 2）。
    const rows = db
      .prepare(
        `SELECT o.* FROM outbox AS o
          WHERE ((o.status = 'pending' AND o.available_at_ms <= ?)
             OR (o.status = 'in_flight' AND o.lease_until_ms <= ?))
          AND (o.topic <> 'memory.observe.v1' OR NOT EXISTS (
            SELECT 1 FROM outbox AS earlier
            WHERE earlier.topic = 'memory.observe.v1'
              AND earlier.partition_key = o.partition_key
              AND earlier.rowid < o.rowid AND earlier.status <> 'delivered'
          ))
          ${historyFence}
          ORDER BY o.available_at_ms, o.outbox_id LIMIT ?`,
      )
      .all(query.leaseNowMs, query.leaseNowMs, query.limit);
    const update = db.prepare(
      `UPDATE outbox
          SET status = 'in_flight', lease_until_ms = ?, lease_owner_instance_id = ?,
              updated_at_ms = ?
        WHERE outbox_id = ?
          AND ( (status = 'pending' AND available_at_ms <= ?)
             OR (status = 'in_flight' AND lease_until_ms <= ?) )`,
    );
    const leaseUntil = query.leaseNowMs + query.leaseMs;
    for (const row of rows) {
      const changed = update.run(
        leaseUntil,
        query.ownerInstanceId,
        query.leaseNowMs,
        readText(row, "outbox_id"),
        query.leaseNowMs,
        query.leaseNowMs,
      );
      if (changed.changes === 1) {
        claimed.push(rowToMessage(row));
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return claimed;
}

/** Remote acceptance and per-item local ACK are committed together. A crash
 * before this transaction resends the same immutable event and idempotency key. */
export function completeOutboxRow(
  db: SqliteDatabase,
  input: { outboxId: string; ownerInstanceId: string; nowMs: number },
): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    markOutboxDelivered(db, input);
    const row = db.prepare("SELECT topic FROM outbox WHERE outbox_id = ?").get(input.outboxId);
    if (row !== undefined && readText(row, "topic") === "memory.observe.v1") {
      db.prepare(
        "UPDATE phase4_observations SET ack_at_ms = ? WHERE outbox_id = ? AND ack_at_ms IS NULL",
      ).run(input.nowMs, input.outboxId);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function markOutboxDelivered(
  db: SqliteDatabase,
  input: { outboxId: string; ownerInstanceId: string; nowMs: number },
): void {
  const changed = db
    .prepare(
      `UPDATE outbox
          SET status = 'delivered', lease_until_ms = NULL, lease_owner_instance_id = NULL,
              updated_at_ms = ?
        WHERE outbox_id = ? AND status = 'in_flight' AND lease_owner_instance_id = ?`,
    )
    .run(input.nowMs, input.outboxId, input.ownerInstanceId);
  if (changed.changes === 0) {
    const row = db.prepare("SELECT status FROM outbox WHERE outbox_id = ?").get(input.outboxId);
    if (row !== undefined && readText(row, "status") === "delivered") {
      return;
    }
    throw new PersistenceError(
      "not_claimed",
      "outbox item is not leased by this dispatcher instance",
    );
  }
}

export interface RetryOutboxCommand {
  readonly outboxId: string;
  readonly ownerInstanceId: string;
  readonly errorCode: string;
  readonly retryable: boolean;
  /** 审计墙钟（updated_at_ms 等审计列）。 */
  readonly nowMs: number;
  /** 调度时钟（Lease 单调投影）：退避 available_at_ms = leaseNowMs + delay。 */
  readonly leaseNowMs: number;
}

export function retryOutboxRow(
  db: SqliteDatabase,
  command: RetryOutboxCommand,
  policy: OutboxRetryPolicy,
): "retry" | "dead" {
  const row = db
    .prepare(
      "SELECT status, attempts, lease_owner_instance_id, topic, payload_json, session_id FROM outbox WHERE outbox_id = ?",
    )
    .get(command.outboxId);
  if (
    row === undefined ||
    readText(row, "status") !== "in_flight" ||
    readText(row, "lease_owner_instance_id") !== command.ownerInstanceId
  ) {
    throw new PersistenceError(
      "not_claimed",
      "outbox item is not leased by this dispatcher instance",
    );
  }
  const attempts = readInt(row, "attempts");
  if (["memory.observe.v1", "memory.usage.v1"].includes(readText(row, "topic"))) {
    const payload = JSON.parse(readText(row, "payload_json")) as {
      policy?: { scopeKey?: unknown };
    } | null;
    const scopeKey =
      payload?.policy?.scopeKey ??
      (historyBarrierTableExists(db)
        ? db
            .prepare("SELECT scope_key FROM phase4_memory_session_scopes WHERE session_id = ?")
            .get(readText(row, "session_id"))?.scope_key
        : undefined);
    if (typeof scopeKey === "string" && hasHistoryBarrier(db, scopeKey)) {
      db.prepare(`UPDATE outbox SET status = 'pending', lease_until_ms = NULL,
        lease_owner_instance_id = NULL, last_error_code = 'history_unavailable', updated_at_ms = ?
        WHERE outbox_id = ? AND status = 'in_flight' AND lease_owner_instance_id = ?`).run(
        command.nowMs,
        command.outboxId,
        command.ownerInstanceId,
      );
      return "retry";
    }
  }
  if (shouldDeadLetter(policy, attempts, command.retryable)) {
    db.prepare(
      `UPDATE outbox
          SET status = 'dead', last_error_code = ?, lease_until_ms = NULL,
              lease_owner_instance_id = NULL, updated_at_ms = ?
        WHERE outbox_id = ? AND status = 'in_flight' AND lease_owner_instance_id = ?`,
    ).run(command.errorCode, command.nowMs, command.outboxId, command.ownerInstanceId);
    return "dead";
  }
  const delayMs = computeRetryDelayMs(policy, attempts);
  db.prepare(
    `UPDATE outbox
        SET status = 'pending', attempts = ?, available_at_ms = ?, last_error_code = ?,
            lease_until_ms = NULL, lease_owner_instance_id = NULL, updated_at_ms = ?
      WHERE outbox_id = ? AND status = 'in_flight' AND lease_owner_instance_id = ?`,
  ).run(
    attempts + 1,
    command.leaseNowMs + delayMs,
    command.errorCode,
    command.nowMs,
    command.outboxId,
    command.ownerInstanceId,
  );
  return "retry";
}

/**
 * Worker 启动恢复：in_flight 项立即回到可领取状态。
 * available_at_ms 一并重置为新 Worker 的 leaseNowMs——旧 Worker 的时钟域
 * 可能领先（或重启后墙钟回拨），保留旧值会让 pending 项在新时钟域里
 * “在未来”而无法立即领取（评审残留 2）。
 * 前置条件：worker-lock 单 Worker 独占（见 worker/database.ts）——
 * 同一数据目录不存在仍存活的其它 Worker，清空不会抢走活跃 Lease。
 */
export function requeueInFlightRows(db: SqliteDatabase, nowMs: number, leaseNowMs: number): number {
  if (db.prepare("SELECT 1 FROM outbox WHERE status = 'in_flight' LIMIT 1").get() === undefined)
    return 0;
  const changed = db
    .prepare(
      `UPDATE outbox
          SET status = 'pending', available_at_ms = ?, lease_until_ms = NULL,
              lease_owner_instance_id = NULL, updated_at_ms = ?
        WHERE status = 'in_flight'`,
    )
    .run(leaseNowMs, nowMs);
  return Number(changed.changes);
}

export interface OutboxStatusCounts {
  readonly pending: number;
  readonly inFlight: number;
  readonly delivered: number;
  readonly dead: number;
}

export function readOutboxStatusCounts(db: SqliteDatabase): OutboxStatusCounts {
  const counts: Record<string, number> = {};
  for (const row of db.prepare("SELECT status, COUNT(*) AS n FROM outbox GROUP BY status").all()) {
    counts[readText(row, "status")] = readInt(row, "n");
  }
  return {
    pending: counts["pending"] ?? 0,
    inFlight: counts["in_flight"] ?? 0,
    delivered: counts["delivered"] ?? 0,
    dead: counts["dead"] ?? 0,
  };
}
