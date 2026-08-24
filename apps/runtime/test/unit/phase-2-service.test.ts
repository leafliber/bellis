import { describe, expect, it } from "vitest";
import { VirtualClock, createDeterministicIdSource } from "@bellis/testkit";
import type { JsonValue, StageCapabilities } from "@bellis/contracts";
import type { SceneLifecycleRecord } from "@bellis/scene-runtime";
import { Phase2PerformanceService } from "../../src/application/phase-2/performance-service.js";
import type { ControlChannel } from "../../src/application/phase-2/stage-port-adapter.js";

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

function createService() {
  const clock = new VirtualClock();
  const channel = new EchoControlChannel();
  const persistence = new FakePersistence();
  const ids = createDeterministicIdSource("phase2-service");
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
    directorPolicy: {
      commitLeadMs: 400,
      cancelTimeoutMs: 500,
      commitSendTimeoutMs: 500,
      maxActiveScenes: 8,
      closeTimeoutMs: 1000,
    },
  });
  return { service, clock, channel, persistence };
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
