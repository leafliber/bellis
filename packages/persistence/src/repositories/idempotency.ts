import { PersistenceError } from "../errors.js";
import { readText } from "./sqlite-port.js";
import type { SqliteDatabase } from "./sqlite-port.js";

/**
 * idempotency_keys 表（P2 文档 §8.3）：
 * - Key 带作用域（scene_commit:{sessionId}），非全库裸唯一。
 * - 保存请求摘要与结果引用；同 Key 同摘要返回第一次结果，
 *   同 Key 不同摘要返回不可重试冲突。
 * - requestFingerprint 信任边界：调用方提供的 1..256 稳定字符串，
 *   只用于相等比较，不解析语义。
 */

export const FINGERPRINT_MAX_LENGTH = 256;
export const IDEMPOTENCY_KEY_MAX_LENGTH = 256;

export interface StoredIdempotencyKey {
  readonly requestFingerprint: string;
  readonly resultRef: string;
}

export function sceneCommitScope(sessionId: string): string {
  return `scene_commit:${sessionId}`;
}

export function findIdempotencyKey(
  db: SqliteDatabase,
  scope: string,
  key: string,
): StoredIdempotencyKey | null {
  const row = db
    .prepare(
      "SELECT request_fingerprint, result_ref FROM idempotency_keys WHERE scope = ? AND key = ?",
    )
    .get(scope, key);
  if (row === undefined) {
    return null;
  }
  return {
    requestFingerprint: readText(row, "request_fingerprint"),
    resultRef: readText(row, "result_ref"),
  };
}

export function insertIdempotencyKey(
  db: SqliteDatabase,
  input: {
    readonly scope: string;
    readonly key: string;
    readonly requestFingerprint: string;
    readonly resultType: string;
    readonly resultRef: string;
    readonly createdAtMs: number;
  },
): void {
  try {
    db.prepare(
      "INSERT INTO idempotency_keys (scope, key, request_fingerprint, result_type, result_ref, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      input.scope,
      input.key,
      input.requestFingerprint,
      input.resultType,
      input.resultRef,
      input.createdAtMs,
    );
  } catch (error) {
    const message = String(error);
    if (message.includes("UNIQUE")) {
      throw new PersistenceError(
        "idempotency_conflict",
        "idempotency key already committed by a concurrent request",
        { cause: error },
      );
    }
    throw error;
  }
}
