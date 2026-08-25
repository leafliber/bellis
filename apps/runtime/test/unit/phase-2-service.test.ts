import { describe, expect, it } from "vitest";
import { VirtualClock, createDeterministicIdSource } from "@bellis/testkit";
import type { JsonValue, StageCapabilities } from "@bellis/contracts";
import type { SceneLifecycleRecord } from "@bellis/scene-runtime";
import { Phase2PerformanceService } from "../../src/application/phase-2/performance-service.js";
import {
  PersistenceSceneRepository,
  type ControlChannel,
} from "../../src/application/phase-2/stage-port-adapter.js";
import { Phase2RuntimeHost } from "../../src/application/phase-2/host.js";
import { buildSessionSnapshot } from "../../src/application/recovery.js";

/**
 * Phase 2 应用服务全链路（docs/phase-2-development-guide.md §9.2）：
 * Signal → Fake Model → Compiler → Director（真实状态机）→ Control 通道
 * （Fake，回放 Stage 协议消息）→ 持久化（Fake Client 记录调用）。
 * 验证：编译产物落库携带 plan、started/finished 聚合、紧急打断取消。
 */

const CAPABILITIES: StageCapabilities = {
  schemaVersion: 1,
  audio: { contentTypes: ["audio/pcm-s16le-48000-mono"], maxBufferedUs: "2000000" },
  subtitle: { supported: true },
  avatar: { adapter: "recording", motions: ["nod_agree"], expressions: ["happy"] },
};

interface SentMessage {
  readonly type: string;
  readonly payload: JsonValue;
}

class EchoControlChannel implements ControlChannel {
  readonly sent: SentMessage[] = [];
  connected = true;
  readonly disconnectHandlers: (() => void)[] = [];

  enqueueServerMessage(input: { type: string; payload: JsonValue }): boolean {
    this.sent.push({ type: input.type, payload: input.payload });
    return true;
  }

  hasStageConnection(): boolean {
    return this.connected;
  }

  onDisconnected(handler: () => void): void {
    this.disconnectHandlers.push(handler);
  }

  /** 测试驱动：服务发出的 prepare/commit 消息即时回放 Stage 应答。 */
  reply(service: Phase2PerformanceService, clock: VirtualClock): void {
    for (const message of Array.from(this.sent)) {
      if (message.type === "scene.prepare") {
        const plan = (
          message.payload as {
            plan: {
              scene: { sceneId: string; cycleId?: string; groups: { lanes: string[] }[] };
              cues: unknown[];
            };
          }
        ).plan;
        const lanes = plan.scene.groups.flatMap((group) =>
          group.lanes.map((lane) => ({ lane, status: "ready", cueIds: [] })),
        );
        service.handleStageMessage(
          "scene.ready",
          {
            sceneId: plan.scene.sceneId,
            cycleId: plan.scene.cycleId ?? FIXTURE_CYCLE,
            lanes,
            preparedAtStageUs: clock.nowUs().toString(),
          },
          clock.nowUs(),
        );
      }
    }
  }
}

class FakePersistence {
  readonly commits: unknown[] = [];
  readonly records: unknown[] = [];

  commitScene = async (input: unknown): Promise<unknown> => {
    this.commits.push(input);
    return { sceneId: "ignored", committedAtMs: 1_755_600_000_000, duplicate: false };
  };

  appendRecord = async (input: unknown): Promise<unknown> => {
    this.records.push(input);
    return input;
  };
}

function createService(options?: {
  readonly media?: {
    sendFrame: (frame: { header: Record<string, string | number>; payload: Uint8Array }) => boolean;
  };
}) {
  const clock = new VirtualClock();
  const channel = new EchoControlChannel();
  const persistence = new FakePersistence();
  const ids = createDeterministicIdSource("phase2-service");
  const mediaDisconnectHandlers: (() => void)[] = [];
  const repository = {
    commit: async (input: {
      plan: { scene: { sceneId: string; cycleId?: string } };
      idempotencyKey: string;
      requestFingerprint: string;
      sessionId: string;
    }) => {
      const raw = (await persistence.commitScene({
        sceneId: input.plan.scene.sceneId,
        cycleId: input.plan.scene.cycleId ?? FIXTURE_CYCLE,
        sessionId: input.sessionId,
        scene: input.plan.scene,
        plan: input.plan,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: input.requestFingerprint,
        watermarks: [],
        outbox: [],
      })) as { committedAtMs: number };
      return {
        sceneId: input.plan.scene.sceneId,
        committedAtMs: raw.committedAtMs,
        duplicate: false,
      };
    },
    appendLifecycle: async (record: SceneLifecycleRecord) => {
      await persistence.appendRecord({ record: { payload: record } });
    },
  };
  const service = new Phase2PerformanceService({
    sessionId: "11111111-1111-4111-8111-111111111111",
    capabilities: CAPABILITIES,
    clock,
    wallClockMs: () => 1_755_600_000_000,
    compileIds: { nextId: () => ids.uuid("compile") },
    recordId: () => ids.uuid("record"),
    channel,
    repository,
    ...(options?.media === undefined
      ? {}
      : {
          mediaChannel: {
            sendFrame: options.media.sendFrame,
            onDisconnected: (handler: () => void) => {
              mediaDisconnectHandlers.push(handler);
            },
          },
        }),
    directorPolicy: {
      commitLeadMs: 400,
      cancelTimeoutMs: 500,
      commitSendTimeoutMs: 500,
      maxActiveScenes: 8,
      closeTimeoutMs: 1000,
    },
  });
  return {
    service,
    clock,
    channel,
    persistence,
    disconnectMedia: () => {
      for (const handler of mediaDisconnectHandlers) {
        handler();
      }
    },
  };
}

const FIXTURE_CYCLE = "33333333-3333-4333-8333-333333333333";

const SIGNAL = {
  schemaVersion: 1,
  id: "66666666-6666-4666-8666-666666666666",
  kind: "danmaku",
  source: "fake-demo",
  occurredAt: 1_755_600_000_000,
  priority: 100,
  payload: { text: "冲！" },
};

const FIXTURE = {
  cycleId: "33333333-3333-4333-8333-333333333333",
  traceId: "0123456789abcdef0123456789abcdef",
  scenario: "normal",
} as const;

async function flush(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
}

describe("Phase2PerformanceService", () => {
  it("完整链路：提交 → prepare 回执 → durable(plan) → stage commit → started → finished completed", async () => {
    const h = createService();
    const submission = h.service.submit({ signal: SIGNAL, fixture: FIXTURE });
    expect(submission.kind).toBe("submitted");
    if (submission.kind !== "submitted") {
      return;
    }
    await flush();
    h.channel.reply(h.service, h.clock);
    await flush();

    // 发出顺序：prepare → commit（durable 之后）。
    const types = h.channel.sent.map((m) => m.type);
    expect(types.indexOf("scene.prepare")).toBeGreaterThanOrEqual(0);
    expect(types.indexOf("scene.commit")).toBeGreaterThan(types.indexOf("scene.prepare"));
    // durable 提交携带完整 plan（含 cues 与 speech 扩展键）。
    expect(h.persistence.commits).toHaveLength(1);
    const commitInput = h.persistence.commits[0] as { plan: { cues: unknown[] } };
    expect(commitInput.plan.cues.length).toBeGreaterThanOrEqual(2);
    expect(h.service.getExecutionState(submission.sceneId)).toBe("scheduled");

    h.service.handleStageMessage(
      "scene.started",
      {
        sceneId: submission.sceneId,
        cycleId: FIXTURE.cycleId,
        lanes: [
          { lane: "audio", startedAtStageUs: "400000", startedAtRuntimeUs: "400000" },
          { lane: "subtitle", startedAtStageUs: "401000", startedAtRuntimeUs: "401000" },
          { lane: "avatar", startedAtStageUs: "402000", startedAtRuntimeUs: "402000" },
        ],
      },
      h.clock.nowUs(),
    );
    expect(h.service.getExecutionState(submission.sceneId)).toBe("running");
    h.service.handleStageMessage(
      "scene.finished",
      {
        sceneId: submission.sceneId,
        cycleId: FIXTURE.cycleId,
        lanes: [
          { lane: "audio", outcome: "completed", finishedAtStageUs: "1000000" },
          { lane: "subtitle", outcome: "completed", finishedAtStageUs: "1000000" },
          { lane: "avatar", outcome: "completed", finishedAtStageUs: "1000000" },
        ],
      },
      h.clock.nowUs(),
    );
    const outcome = await submission.handle.done;
    expect(outcome.state).toBe("completed");
    await h.service.close();
  });

  it("紧急打断：interruptAll 取消活动 Scene", async () => {
    const h = createService();
    const submission = h.service.submit({ signal: SIGNAL, fixture: FIXTURE });
    if (submission.kind !== "submitted") {
      throw new Error("expected submitted");
    }
    await flush();
    h.channel.reply(h.service, h.clock);
    await flush();
    h.service.handleStageMessage(
      "scene.started",
      {
        sceneId: submission.sceneId,
        cycleId: FIXTURE.cycleId,
        lanes: [{ lane: "audio", startedAtStageUs: "1", startedAtRuntimeUs: "1" }],
      },
      h.clock.nowUs(),
    );
    await h.service.interruptAll("urgent_interrupt");
    // 回放 cancel.ack（全部 Lane 已停止）。
    h.service.handleStageMessage(
      "scene.cancel.ack",
      {
        sceneId: submission.sceneId,
        cycleId: FIXTURE.cycleId,
        lanes: [
          { lane: "audio", stopped: true },
          { lane: "subtitle", stopped: true },
          { lane: "avatar", stopped: true },
        ],
        stoppedAtStageUs: "2",
      },
      h.clock.nowUs(),
    );
    const outcome = await submission.handle.done;
    expect(outcome.state).toBe("cancelled");
    expect(h.channel.sent.some((m) => m.type === "scene.cancel")).toBe(true);
    await h.service.close();
  });

  it("非法 Signal 与非法 DecisionPacket 在入口拒绝，不进入编译", () => {
    const h = createService();
    expect(h.service.submit({ signal: { bad: 1 }, fixture: FIXTURE }).kind).toBe("invalid_signal");
    expect(
      h.service.submit({ signal: SIGNAL, fixture: { ...FIXTURE, scenario: "invalid" } }).kind,
    ).toBe("invalid_packet");
    expect(h.channel.sent).toHaveLength(0);
    expect(h.persistence.commits).toHaveLength(0);
  });

  it("silent 场景：noOp 不伪造 Scene", () => {
    const h = createService();
    const outcome = h.service.submit({
      signal: SIGNAL,
      fixture: { ...FIXTURE, scenario: "silent" },
    });
    expect(outcome.kind).toBe("noop");
    expect(h.channel.sent).toHaveLength(0);
  });
});

describe("Phase2PerformanceService 媒体编排", () => {
  it("announce 先于 scene.prepare；ready 后按 lead 节奏发帧；取消即停流", async () => {
    const frames: { header: Record<string, string | number>; payload: Uint8Array }[] = [];
    const h = createService({
      media: {
        sendFrame: (frame) => {
          frames.push(frame);
          return true;
        },
      },
    });
    const submission = h.service.submit({ signal: SIGNAL, fixture: FIXTURE });
    if (submission.kind !== "submitted") {
      throw new Error("expected submitted");
    }
    await flush();
    // announce 在 scene.prepare 之前发出（音频 Lane prepare 依赖预缓冲）。
    const types = h.channel.sent.map((m) => m.type);
    expect(types.indexOf("media.stream.announce")).toBeGreaterThanOrEqual(0);
    expect(types.indexOf("media.stream.announce")).toBeLessThan(types.indexOf("scene.prepare"));
    const announce = h.channel.sent.find((m) => m.type === "media.stream.announce");
    const payload = announce?.payload as {
      streamId: string;
      mediaKind: string;
      contentType: string;
      sceneId: string;
    };
    expect(payload.mediaKind).toBe("audio");
    expect(payload.contentType).toBe("audio/pcm-s16le-48000-mono");
    expect(payload.sceneId).toBe(submission.sceneId);
    // ready 之前不发帧。
    expect(frames).toHaveLength(0);
    h.service.handleStageMessage(
      "media.stream.ready",
      { streamId: payload.streamId },
      h.clock.nowUs(),
    );
    await flush();
    // 首帧目标 = ready 时刻 + lead（150ms）；未到 lead 前静默。
    expect(frames).toHaveLength(0);
    h.clock.advanceBy(150_000n);
    await flush();
    expect(frames.length).toBeGreaterThanOrEqual(1);
    expect(frames[0]?.header.schemaVersion).toBe(1);
    expect(frames[0]?.header.sequence).toBe("0");
    expect(frames[0]?.header.streamId).toBe(payload.streamId);
    expect(frames[0]?.payload.byteLength).toBe(1920);
    // 取消优先于媒体：打断后帧不再增长。
    const beforeCancel = frames.length;
    const cancelPromise = h.service.interruptAll("urgent_interrupt");
    await flush();
    h.service.handleStageMessage(
      "scene.cancel.ack",
      {
        sceneId: submission.sceneId,
        cycleId: FIXTURE.cycleId,
        lanes: [{ lane: "audio", stopped: true }],
        stoppedAtStageUs: "2",
      },
      h.clock.nowUs(),
    );
    await cancelPromise;
    await submission.handle.done;
    h.clock.advanceBy(5_000_000n);
    await flush(20);
    expect(frames.length).toBe(beforeCancel);
    expect(h.service.mediaStats.sent).toBe(beforeCancel);
    await h.service.close();
  });

  it("媒体连接断开：全部帧任务立即停止（Stream 不跨连接复活）", async () => {
    const frames: unknown[] = [];
    const h = createService({
      media: {
        sendFrame: () => {
          frames.push(1);
          return true;
        },
      },
    });
    const submission = h.service.submit({ signal: SIGNAL, fixture: FIXTURE });
    if (submission.kind !== "submitted") {
      throw new Error("expected submitted");
    }
    await flush();
    const announce = h.channel.sent.find((m) => m.type === "media.stream.announce");
    if (announce === undefined) {
      throw new Error("expected media.stream.announce");
    }
    const streamId = (announce.payload as { streamId: string }).streamId;
    h.service.handleStageMessage("media.stream.ready", { streamId }, h.clock.nowUs());
    h.clock.advanceBy(200_000n);
    await flush();
    expect(frames.length).toBeGreaterThan(0);
    h.disconnectMedia();
    h.clock.advanceBy(5_000_000n);
    await flush(20);
    const afterDisconnect = frames.length;
    h.clock.advanceBy(5_000_000n);
    await flush(20);
    expect(frames.length).toBe(afterDisconnect);
    await h.service.interruptAll("stage_lost");
    h.service.handleStageMessage(
      "scene.cancel.ack",
      {
        sceneId: submission.sceneId,
        cycleId: FIXTURE.cycleId,
        lanes: [{ lane: "audio", stopped: true }],
        stoppedAtStageUs: "3",
      },
      h.clock.nowUs(),
    );
    await submission.handle.done;
    await h.service.close();
  });

  it("编译能力使用 stage.capabilities 快照（上报缺失动作 → 编译拒绝）", async () => {
    const h = createService();
    // Stage 上报不含 nod_agree：默认 Fixture 的 avatar 动作编译应被拒。
    h.service.handleStageMessage(
      "stage.capabilities",
      {
        capabilities: {
          schemaVersion: 1,
          audio: { contentTypes: ["audio/pcm-s16le-48000-mono"], maxBufferedUs: "2000000" },
          subtitle: { supported: true },
          avatar: { adapter: "reporting", motions: ["wave"], expressions: ["happy"] },
        },
      },
      h.clock.nowUs(),
    );
    const outcome = h.service.submit({ signal: SIGNAL, fixture: FIXTURE });
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      // hard 同步组的 Lane 缺能力 → 整组不可满足（保守拒绝，不降级）。
      expect(outcome.issues.some((issue) => issue.code === "hard_lane_unsatisfiable")).toBe(true);
    }
    // 未上报时以默认能力编译：同样输入提交成功（回落路径）。
    const h2 = createService();
    expect(h2.service.submit({ signal: SIGNAL, fixture: FIXTURE }).kind).toBe("submitted");
    for (const harness of [h, h2]) {
      const closing = harness.service.close();
      await flush();
      harness.clock.advanceBy(3_000_000n);
      await flush(20);
      await closing;
    }
  });

  it("审计 Record：signal 接受 / 决策包 / 编译结果（不含发言全文）", async () => {
    const records: { recordType: string; payload: JsonValue }[] = [];
    const clock = new VirtualClock();
    const channel = new EchoControlChannel();
    const ids = createDeterministicIdSource("phase2-audit");
    const repository = {
      commit: async () => ({ sceneId: "s", committedAtMs: 1, duplicate: false }),
      appendLifecycle: async () => {},
    };
    const service = new Phase2PerformanceService({
      sessionId: "11111111-1111-4111-8111-111111111111",
      capabilities: CAPABILITIES,
      clock,
      wallClockMs: () => 1_755_600_000_000,
      compileIds: { nextId: () => ids.uuid("compile") },
      recordId: () => ids.uuid("record"),
      channel,
      repository,
      audit: {
        append: async (record) => {
          records.push(record);
        },
      },
      directorPolicy: {
        commitLeadMs: 400,
        cancelTimeoutMs: 500,
        commitSendTimeoutMs: 500,
        maxActiveScenes: 8,
        closeTimeoutMs: 1000,
      },
    });
    service.submit({ signal: SIGNAL, fixture: FIXTURE });
    await flush();
    const types = records.map((record) => record.recordType);
    expect(types).toContain("phase2_signal_accepted");
    expect(types).toContain("phase2_decision_packet");
    expect(types).toContain("phase2_scene_plan_compiled");
    // 隐私约束：审计 payload 不携带 Signal/发言全文。
    const serialized = JSON.stringify(records);
    expect(serialized.includes("冲")).toBe(false);
    // 关闭排空：closeTimeout 预算由虚拟时钟推进兑现。
    const closing = service.close();
    await flush();
    clock.advanceBy(3_000_000n);
    await flush(20);
    await closing;
  });
});

describe("Phase2RuntimeHost 跨进程快照对账（decorateSnapshot）", () => {
  const RECOVERY = {
    sessionId: "11111111-2222-4333-8333-444444444444",
    latestServerSeq: 12n,
    signalWatermarks: [],
    lastCommittedScene: {
      sceneId: "44444444-4444-4444-8444-4444440000aa",
      cycleId: "33333333-3333-4333-8333-333333333333",
      committedAtMs: 1000,
    },
  } as const;

  function lifecycleRecord(to: string): { payload: { to: string } } {
    return { payload: { to } };
  }

  function createHost(): Phase2RuntimeHost {
    const persistence = new FakePersistence();
    const repository = new PersistenceSceneRepository({
      client: persistence,
      traceId: "0000000000000000000000000000000",
      newRecordId: () => "55555555-5555-4555-8555-555555555555",
    });
    return new Phase2RuntimeHost({
      sessionId: RECOVERY.sessionId,
      capabilities: CAPABILITIES,
      clock: new VirtualClock(),
      wallClockMs: () => 0,
      compileIds: { nextId: () => "77777777-7777-4777-8777-777777777777" },
      recordId: () => "66666666-6666-4666-8666-666666666666",
      repository,
    });
  }

  function baseSnapshot() {
    return buildSessionSnapshot(
      { ...RECOVERY },
      {
        reason: "replay_gap",
        sessionStatus: "ready",
        runtimeVersion: "0.1.0-test",
        generatedAtMs: 1,
      },
    );
  }

  it("落库 Scene 生命周期在途（非终态记录）→ v2 uncertain + requiresReprepare", () => {
    const host = createHost();
    const decorated = host.decorateSnapshot(baseSnapshot(), RECOVERY, [
      lifecycleRecord("created"),
      lifecycleRecord("committing"),
    ] as never);
    expect(decorated.schemaVersion).toBe(2);
    const active = (decorated as { activeScene: { executionState: string } }).activeScene;
    expect(active.executionState).toBe("uncertain");
  });

  it("生命周期记录已证终态（completed/cancelled/failed）→ 维持 v1", () => {
    const host = createHost();
    for (const terminal of ["completed", "cancelled", "failed"]) {
      const decorated = host.decorateSnapshot(baseSnapshot(), RECOVERY, [
        lifecycleRecord("running"),
        lifecycleRecord(terminal),
      ] as never);
      expect(decorated.schemaVersion).toBe(1);
    }
  });

  it("记录缺失（null）→ 结果不可证明 → v2 uncertain", () => {
    const host = createHost();
    const decorated = host.decorateSnapshot(baseSnapshot(), RECOVERY, null);
    expect(decorated.schemaVersion).toBe(2);
  });

  it("uncertain 记录保持对账视图（不可证终态）→ v2 uncertain", () => {
    const host = createHost();
    const decorated = host.decorateSnapshot(baseSnapshot(), RECOVERY, [
      lifecycleRecord("uncertain"),
    ] as never);
    expect(decorated.schemaVersion).toBe(2);
  });

  it("无落库 Scene → v1（不虚构状态）", () => {
    const host = createHost();
    const decorated = host.decorateSnapshot(
      baseSnapshot(),
      { ...RECOVERY, lastCommittedScene: null },
      null,
    );
    expect(decorated.schemaVersion).toBe(1);
  });
});
