import { describe, expect, it } from "vitest";
import { SceneSchema } from "@bellis/contracts";
import type { TraceContext } from "@bellis/contracts";
import type { CommitSceneInput, CommitSceneResult, PersistenceClient } from "@bellis/persistence";
import { createInMemoryMetrics, createNoopLogger } from "@bellis/observability";
import { SystemMonotonicClock } from "@bellis/transport";
import type { BroadcastOutcome, ControlBroadcast } from "../../src/index.js";
import { ApplicationError, FakeSceneCommitService } from "../../src/index.js";

/** 记录调用顺序的假持久化客户端（恢复语义由真实 Worker 集成测试覆盖）。 */
class RecordingClient implements PersistenceClient {
  readonly commits: CommitSceneInput[] = [];
  #result: CommitSceneResult;

  constructor(result?: Partial<CommitSceneResult>) {
    this.#result = {
      sceneId: result?.sceneId ?? "22222222-2222-4222-8222-222222222222",
      committedAtMs: result?.committedAtMs ?? 1_755_648_000_123,
      duplicate: result?.duplicate ?? false,
    };
  }

  commitScene(input: CommitSceneInput): Promise<CommitSceneResult> {
    this.commits.push(input);
    return Promise.resolve(this.#result);
  }

  migrate(): Promise<void> {
    throw new Error("not implemented in recording client");
  }

  ensureSession(): Promise<void> {
    throw new Error("not implemented in recording client");
  }

  appendRecord(): Promise<never> {
    throw new Error("not implemented in recording client");
  }

  advanceServerSeq(): Promise<bigint> {
    throw new Error("not implemented in recording client");
  }

  readRecoveryState(): Promise<never> {
    throw new Error("not implemented in recording client");
  }

  listRecords(): Promise<never> {
    throw new Error("not implemented in recording client");
  }

  claimOutbox(): Promise<never> {
    throw new Error("not implemented in recording client");
  }

  completeOutbox(): Promise<void> {
    throw new Error("not implemented in recording client");
  }

  retryOutbox(): Promise<never> {
    throw new Error("not implemented in recording client");
  }

  readOutboxStats(): Promise<never> {
    throw new Error("not implemented in recording client");
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

interface BroadcastEvent {
  readonly kind: "broadcast" | "commit";
  readonly type?: string;
}

function buildService(
  client: PersistenceClient,
  events: BroadcastEvent[],
): { service: FakeSceneCommitService; broadcast: ControlBroadcast } {
  const broadcast: ControlBroadcast = async (_sessionId, message) => {
    events.push({ kind: "broadcast", type: message.type });
    return "sent" satisfies BroadcastOutcome;
  };
  const wrappingClient: PersistenceClient = {
    ...client,
    commitScene: (input: CommitSceneInput) => {
      events.push({ kind: "commit" });
      return client.commitScene(input);
    },
  };
  const service = new FakeSceneCommitService({
    client: wrappingClient,
    broadcast,
    logger: createNoopLogger(),
    metrics: createInMemoryMetrics(),
    clock: new SystemMonotonicClock(),
  });
  return { service, broadcast };
}

const INPUT = {
  sessionId: "11111111-1111-4111-8111-111111111111",
  sceneId: "22222222-2222-4222-8222-222222222222",
  cycleId: "33333333-3333-4333-8333-333333333333",
  idempotencyKey: "demo-key-1",
  cues: [
    { cueId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", lane: "subtitle" as const },
    { cueId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", lane: "avatar" as const },
  ],
  watermarks: [{ source: "demo.asr", watermark: 1234567890123456789n }],
};

describe("FakeSceneCommitService", () => {
  it("顺序：scene.prepared 先于 commitScene；committed 只在 Commit 成功后", async () => {
    const client = new RecordingClient();
    const events: BroadcastEvent[] = [];
    const { service } = buildService(client, events);
    const result = await service.commit(INPUT);
    expect(events.map((event) => (event.kind === "broadcast" ? event.type : "commit"))).toEqual([
      "scene.prepared",
      "commit",
      "scene.committed",
    ]);
    expect(result.duplicate).toBe(false);
    expect(result.traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  it("duplicate 重放不发布第二条 committed", async () => {
    const client = new RecordingClient({ duplicate: true });
    const events: BroadcastEvent[] = [];
    const { service } = buildService(client, events);
    await service.commit(INPUT);
    expect(events.map((event) => (event.kind === "broadcast" ? event.type : "commit"))).toEqual([
      "scene.prepared",
      "commit",
    ]);
  });

  it("同一输入重放得到相同请求指纹（outboxId 等生成 ID 不影响）", async () => {
    const client = new RecordingClient();
    const { service } = buildService(client, []);
    await service.commit(INPUT);
    await service.commit(INPUT);
    expect(client.commits.length).toBe(2);
    const [first, second] = client.commits as [CommitSceneInput, CommitSceneInput];
    expect(first.requestFingerprint).toBe(second.requestFingerprint);
    expect(first.outbox[0]?.outboxId).not.toBe(second.outbox[0]?.outboxId);
    // 不同摘要：不同幂等键 → 指纹不同（冲突场景由 P2 保证）。
    const other = await service.commit({ ...INPUT, idempotencyKey: "another-key" });
    expect(other.duplicate).toBe(false);
    const third = client.commits[2];
    expect(third?.requestFingerprint).not.toBe(first.requestFingerprint);
  });

  it("Scene Payload 满足 SceneSchema 且 Outbox 携带 traceId", async () => {
    const client = new RecordingClient();
    const { service } = buildService(client, []);
    const result = await service.commit(INPUT);
    const commit = client.commits[0];
    expect(commit).toBeDefined();
    if (commit === undefined) {
      return;
    }
    expect(SceneSchema.safeParse(commit.scene).success).toBe(true);
    expect(commit.watermarks).toEqual([{ source: "demo.asr", watermark: 1234567890123456789n }]);
    const payload = commit.outbox[0]?.payload as Record<string, unknown>;
    expect(payload.traceId).toBe(result.traceId);
    expect(commit.outbox[0]?.topic).toBe("scene.committed");
    expect(commit.trace.traceId).toBe(result.traceId);
  });

  it("Commit 前 Abort：不进入事务、不发布 committed", async () => {
    const client = new RecordingClient();
    const events: BroadcastEvent[] = [];
    const { service } = buildService(client, events);
    const controller = new AbortController();
    controller.abort();
    await expect(service.commit(INPUT, controller.signal)).rejects.toBeInstanceOf(ApplicationError);
    expect(client.commits.length).toBe(0);
    expect(events.some((event) => event.type === "scene.committed")).toBe(false);
  });

  it("显式 trace 被沿用并注入业务 ID", async () => {
    const client = new RecordingClient();
    const { service } = buildService(client, []);
    const trace: TraceContext = { traceId: "0123456789abcdef0123456789abcdef" };
    const result = await service.commit({ ...INPUT, trace });
    expect(result.traceId).toBe("0123456789abcdef0123456789abcdef");
    const commit = client.commits[0];
    expect(commit?.trace.sessionId).toBe(INPUT.sessionId);
    expect(commit?.trace.sceneId).toBe(INPUT.sceneId);
  });

  it("非法输入被 Schema 拒绝", async () => {
    const client = new RecordingClient();
    const { service } = buildService(client, []);
    await expect(
      service.commit({ ...INPUT, watermarks: [{ source: "x", watermark: -1n }] }),
    ).rejects.toThrow();
    await expect(service.commit({ ...INPUT, sessionId: "nope" })).rejects.toThrow();
  });
});
