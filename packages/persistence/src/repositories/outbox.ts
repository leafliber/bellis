import { OutboxMessageSchema } from "@bellis/contracts";
import type { OutboxMessage } from "@bellis/contracts";
import { PersistenceError } from "../errors.js";
import type { OutboxRetryPolicy } from "../outbox/retry-policy.js";
import { computeRetryDelayMs, shouldDeadLetter } from "../outbox/retry-policy.js";
import { readInt, readText } from "./sqlite-port.js";
import type { SqliteDatabase, SqliteRow } from "./sqlite-port.js";

/**
 * outbox 表：至少一次交付的持久化状态机（P2 文档 §10）。
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
        nowMs,
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
    const rows = db
      .prepare(
        `SELECT * FROM outbox
          WHERE status = 'pending' AND available_at_ms <= ?
          ORDER BY available_at_ms, outbox_id LIMIT ?`,
      )
      .all(query.leaseNowMs, query.limit);
    const update = db.prepare(
      `UPDATE outbox
          SET status = 'in_flight', lease_until_ms = ?, lease_owner_instance_id = ?,
              updated_at_ms = ?
        WHERE outbox_id = ? AND status = 'pending' AND available_at_ms <= ?`,
    );
    const leaseUntil = query.leaseNowMs + query.leaseMs;
    for (const row of rows) {
      const changed = update.run(
        leaseUntil,
        query.ownerInstanceId,
        query.leaseNowMs,
        readText(row, "outbox_id"),
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

export function completeOutboxRow(
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
  readonly nowMs: number;
}

export function retryOutboxRow(
  db: SqliteDatabase,
  command: RetryOutboxCommand,
  policy: OutboxRetryPolicy,
): "retry" | "dead" {
  const row = db
    .prepare("SELECT status, attempts, lease_owner_instance_id FROM outbox WHERE outbox_id = ?")
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
    command.nowMs + delayMs,
    command.errorCode,
    command.nowMs,
    command.outboxId,
    command.ownerInstanceId,
  );
  return "retry";
}

/** Worker 启动恢复：旧实例的 in_flight 项立即回到可领取状态。 */
export function requeueInFlightRows(db: SqliteDatabase, nowMs: number): number {
  const changed = db
    .prepare(
      `UPDATE outbox
          SET status = 'pending', lease_until_ms = NULL, lease_owner_instance_id = NULL,
              updated_at_ms = ?
        WHERE status = 'in_flight'`,
    )
    .run(nowMs);
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
