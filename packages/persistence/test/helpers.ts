import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { OutboxMessage, Scene, SessionRecord, TraceContext } from "@bellis/contracts";

/** 共享测试夹具：临时目录、TS Worker 注入与合法协议对象工厂。 */

export const TRACE: TraceContext = {
  traceId: "0123456789abcdef0123456789abcdef",
};

export const SESSION_ID = "11111111-1111-4111-8111-111111111111";
export const SCENE_ID = "22222222-2222-4222-8222-222222222222";
export const CYCLE_ID = "33333333-3333-4333-8333-333333333333";
export const OUTBOX_ID = "55555555-5555-4555-8555-555555555555";

export function sceneId(n: number): string {
  return `22222222-2222-4222-8222-${n.toString().padStart(12, "0")}`;
}

export function cycleId(n: number): string {
  return `33333333-3333-4333-8333-${n.toString().padStart(12, "0")}`;
}

export function outboxId(n: number): string {
  return `55555555-5555-4555-8555-${n.toString().padStart(12, "0")}`;
}

export function makeScene(overrides?: Partial<Scene>): Scene {
  return {
    schemaVersion: 1,
    sceneId: SCENE_ID,
    cycleId: CYCLE_ID,
    groups: [
      {
        schemaVersion: 1,
        groupId: "44444444-4444-4444-8444-444444444444",
        lanes: ["audio"],
        level: "hard",
      },
    ],
    deadlineMs: 5_000,
    interruptPolicy: "finish",
    ...overrides,
  };
}

export function makeOutboxMessage(overrides?: Partial<OutboxMessage>): OutboxMessage {
  return {
    schemaVersion: 1,
    outboxId: OUTBOX_ID,
    topic: "scene.committed",
    partitionKey: SESSION_ID,
    payload: { sceneId: SCENE_ID },
    createdAtMs: 1,
    ...overrides,
  };
}

export function makeSessionRecord(overrides?: Partial<SessionRecord>): SessionRecord {
  const base: SessionRecord = {
    schemaVersion: 1,
    recordId: "66666666-6666-4666-8666-666666666666",
    sessionId: SESSION_ID,
    recordType: "session.opened",
    traceId: TRACE.traceId,
    occurredAtMs: 1,
    payload: { reason: "initial" },
  };
  // Partial 展开引入显式 undefined，与 extensibleJsonObject 的索引签名
  // 不兼容；这里以受控断言收窄回闭合类型。
  return overrides === undefined ? base : ({ ...base, ...overrides } as SessionRecord);
}

/** 临时数据目录：成功/失败后都必须清理（P2 文档 §6.1）。 */
export function createTempDataDirectory(prefix = "bellis-p2-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function cleanupTempDataDirectory(directory: string): void {
  rmSync(directory, { recursive: true, force: true });
}

/** TS 源码 Worker 注入（vitest 与子进程 harness 共用）。 */
export const WORKER_FIXTURE = {
  url: pathToFileURL(join(import.meta.dirname, "..", "src", "worker", "entry.ts")),
  execArgv: [
    "--import",
    pathToFileURL(join(import.meta.dirname, "fixtures", "ts-worker-resolve.mjs")).href,
  ],
} as const;
