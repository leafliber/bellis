import { describe, expect, it } from "vitest";
import { VirtualClock } from "@bellis/testkit";
import type { Cue, CueLane, ScenePlan } from "@bellis/contracts";
import type { ClockEstimate } from "@bellis/transport/browser";
import { ClockOffsetEstimator } from "@bellis/transport/browser";
import { CueTimeline } from "../../src/timeline/cue-timeline.js";
import { LaneRegistry, type StageLaneAdapter } from "../../src/lanes/lane-registry.js";
import { SceneClient } from "../../src/scenes/scene-client.js";

/**
 * Stage Scene 客户端状态机测试：Fake Lane Adapter + VirtualClock。
 * 验证 prepare→ready、commit 调度与 started/finished 上报、late_commit、
 * cancel ack 与连接代际丢弃（docs/phase-2-development-guide.md §7）。
 */

const PLAN: ScenePlan = {
  schemaVersion: 1,
  scene: {
    schemaVersion: 1,
    sceneId: "44444444-4444-4444-8444-444444444444",
    cycleId: "33333333-3333-4333-8333-333333333333",
    groups: [
      {
        schemaVersion: 1,
        groupId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        lanes: ["audio", "subtitle"],
        level: "hard",
      },
    ],
    deadlineMs: 500,
    interruptPolicy: "fade",
  },
  cues: [
    {
      schemaVersion: 1,
      cueId: "55555555-5555-4555-8555-555555555555",
      lane: "audio",
      anchor: "scene_start",
      offsetMs: 0,
      intent: { speechRef: "plan" },
    },
    {
      schemaVersion: 1,
      cueId: "55555555-5555-4555-8555-555555555556",
      lane: "subtitle",
      anchor: "scene_start",
      offsetMs: 0,
      intent: { speechRef: "plan" },
    },
  ],
  speech: { schemaVersion: 1, text: "你好", purpose: "answer", interruptible: true },
} as ScenePlan;

class FakeLane implements StageLaneAdapter {
  readonly commands: string[] = [];
  prepareResult: { ready: boolean; reason?: string } = { ready: true };
  startError = false;

  constructor(readonly lane: CueLane) {}

  async prepare(sceneId: string, _cues: readonly Cue[], signal: AbortSignal) {
    this.commands.push(`prepare:${this.lane}:${sceneId.slice(-4)}`);
    if (signal.aborted) {
      return { ready: false, reason: "cancelled" };
    }
    return this.prepareResult;
  }

  async start(sceneId: string, atStageUs: bigint) {
    this.commands.push(`start:${this.lane}@${atStageUs}`);
    if (this.startError) {
      throw new Error("lane_error");
    }
    void sceneId;
  }

  async stop(sceneId: string, reason: string) {
    this.commands.push(`stop:${this.lane}:${reason}`);
    void sceneId;
  }

  async finish(sceneId: string) {
    this.commands.push(`finish:${this.lane}`);
    void sceneId;
  }

  async close() {
    this.commands.push(`close:${this.lane}`);
  }
}

function fixedEstimate(offsetUs: bigint): ClockEstimate {
  const estimator = new ClockOffsetEstimator();
  estimator.add({ c0: 0n, r1: offsetUs, r2: offsetUs, c3: 0n });
  return estimator.current()!;
}

interface SceneHarness {
  client: SceneClient;
  clock: VirtualClock;
  sent: { type: string; payload: unknown }[];
  audio: FakeLane;
  subtitle: FakeLane;
  events: { sceneId: string; state: string; reason?: string }[];
  set estimate(value: ClockEstimate | null);
}

function createSceneHarness(): SceneHarness {
  const clock = new VirtualClock();
  const timeline = new CueTimeline(clock);
  const lanes = new LaneRegistry();
  const audio = new FakeLane("audio");
  const subtitle = new FakeLane("subtitle");
  lanes.register(audio);
  lanes.register(subtitle);
  const sent: { type: string; payload: unknown }[] = [];
  const events: { sceneId: string; state: string; reason?: string }[] = [];
  let estimate: ClockEstimate | null = fixedEstimate(250_000n);
  const client = new SceneClient({
    clock,
    timeline,
    lanes,
    clockEstimate: () => estimate,
    send: (type, payload) => {
      sent.push({ type, payload });
      return true;
    },
    onEvent: (event) => events.push(event),
  });
  const harness: SceneHarness = {
    client,
    clock,
    sent,
    audio,
    subtitle,
    events,
    set estimate(value: ClockEstimate | null) {
      estimate = value;
    },
  };
  return harness;
}

async function flush(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
}

/** 测试辅助：断言存在并取值（消除 unsafe optional chaining）。 */
function expectFound<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("expected message not found");
  }
  return value;
}

describe("SceneClient", () => {
  it("prepare：并行缓冲（不生效）→ scene.ready 整包上报", async () => {
    const h = createSceneHarness();
    await h.client.handlePrepare({ plan: PLAN, prepareDeadlineUs: "1000" });
    await flush();
    const ready = h.sent.find((m) => m.type === "scene.ready");
    expect(ready).toBeDefined();
    const readyMsg = expectFound(ready);
    expect((readyMsg.payload as { lanes: { lane: string; status: string }[] }).lanes).toEqual([
      expect.objectContaining({ lane: "audio", status: "ready" }),
      expect.objectContaining({ lane: "subtitle", status: "ready" }),
    ]);
    // Prepare 只缓冲：没有任何 start。
    expect(h.audio.commands).toEqual(["prepare:audio:4444"]);
    expect(h.subtitle.commands).toEqual(["prepare:subtitle:4444"]);
  });

  it("Lane 准备失败：unavailable + 原因码上报，不阻塞其他 Lane 报告", async () => {
    const h = createSceneHarness();
    h.subtitle.prepareResult = { ready: false, reason: "subtitle_not_supported" };
    await h.client.handlePrepare({ plan: PLAN, prepareDeadlineUs: "1000" });
    await flush();
    const ready = h.sent.find((m) => m.type === "scene.ready");
    const lanes = (
      expectFound(ready).payload as { lanes: { lane: string; status: string; reason?: string }[] }
    ).lanes;
    expect(lanes.find((l) => l.lane === "subtitle")).toMatchObject({
      status: "unavailable",
      reason: "subtitle_not_supported",
    });
    expect(lanes.find((l) => l.lane === "audio")).toMatchObject({ status: "ready" });
  });

  it("commit：映射目标时刻 → 到点触发 Lane start + started 上报 → 完成后 finished", async () => {
    const h = createSceneHarness();
    await h.client.handlePrepare({ plan: PLAN, prepareDeadlineUs: "1000" });
    await flush();
    h.client.handleCommit(PLAN.scene.sceneId, 1_250_000n); // 本地目标 = 1_000_000µs
    await flush();
    // 目标在未来：到点前绝不启动（Commit 前零副作用在 Stage 侧同样成立）。
    expect(h.audio.commands).toEqual(["prepare:audio:4444"]);
    h.clock.advanceBy(1_000_000n);
    await flush();
    await flush();
    expect(h.audio.commands).toContain("start:audio@1000000");
    expect(h.subtitle.commands).toContain("start:subtitle@1000000");
    // started 上报携带双域时刻（stage 本地 + runtime 估算）。
    const started = h.sent.filter((m) => m.type === "scene.started");
    expect(started.length).toBeGreaterThanOrEqual(2);
    const firstStarted = started[0]?.payload as { lanes: { startedAtRuntimeUs: string }[] };
    const startedLane = firstStarted.lanes[0];
    // 本地 1_000_000µs + offset 250_000µs = Runtime 域 1_250_000。
    expect(BigInt(startedLane?.startedAtRuntimeUs ?? "0")).toBeGreaterThanOrEqual(1_250_000n);
    const finished = h.sent.find((m) => m.type === "scene.finished");
    expect(finished).toBeDefined();
    expect((expectFound(finished).payload as { lanes: unknown[] }).lanes).toHaveLength(2);
    expect(h.audio.commands).toContain("finish:audio");
    expect(h.client.activeCount).toBe(0);
  });

  it("late_commit：目标已过 → 全部 Lane failed:late_commit，绝不启动", async () => {
    const h = createSceneHarness();
    await h.client.handlePrepare({ plan: PLAN, prepareDeadlineUs: "1000" });
    await flush();
    h.clock.advanceBy(2_000_000n);
    h.client.handleCommit(PLAN.scene.sceneId, 1_250_000n); // 目标已过 1ms > 20µs 容忍
    await flush();
    expect(h.audio.commands).not.toContainEqual(expect.stringMatching(/^start/));
    const finished = h.sent.find((m) => m.type === "scene.finished");
    expect(
      (expectFound(finished).payload as { lanes: { reason?: string }[] }).lanes.every(
        (l) => l.reason === "late_commit",
      ),
    ).toBe(true);
  });

  it("cancel：取消调度 + 停止 Lane + cancel.ack；已停 Lane 不再触发", async () => {
    const h = createSceneHarness();
    await h.client.handlePrepare({ plan: PLAN, prepareDeadlineUs: "1000" });
    await flush();
    h.client.handleCommit(PLAN.scene.sceneId, 1_250_000n);
    await flush();
    await h.client.handleCancel(PLAN.scene.sceneId, "urgent_interrupt");
    await flush();
    const ack = h.sent.find((m) => m.type === "scene.cancel.ack");
    expect(ack).toBeDefined();
    expect(
      (expectFound(ack).payload as { lanes: { stopped: boolean }[] }).lanes.every((l) => l.stopped),
    ).toBe(true);
    expect(h.audio.commands).toContain("stop:audio:urgent_interrupt");
    h.clock.advanceBy(1_100_000n);
    await flush();
    expect(h.audio.commands).not.toContainEqual(expect.stringMatching(/^start/));
  });

  it("连接代际变化：未提交准备丢弃；提交后取消本地调度交由对账", async () => {
    const h = createSceneHarness();
    await h.client.handlePrepare({ plan: PLAN, prepareDeadlineUs: "1000" });
    await flush();
    h.client.handleCommit(PLAN.scene.sceneId, 1_250_000n);
    await flush();
    h.client.onConnectionGenerationChange();
    h.clock.advanceBy(1_100_000n);
    await flush();
    // 调度已取消：无 start、无 started 上报。
    expect(h.audio.commands).not.toContainEqual(expect.stringMatching(/^start/));
    expect(h.sent.some((m) => m.type === "scene.started")).toBe(false);
  });

  it("未知 Scene 的 commit/cancel：本地拒绝，不伪造回执", async () => {
    const h = createSceneHarness();
    h.client.handleCommit("44444444-4444-4444-8444-4444444444ff", 1n);
    await h.client.handleCancel("44444444-4444-4444-8444-4444444444ff", "x");
    await flush();
    expect(h.sent).toHaveLength(0);
  });

  it("时钟未校准时 commit：clock_not_ready 失败上报", async () => {
    const h = createSceneHarness();
    h.estimate = null;
    await h.client.handlePrepare({ plan: PLAN, prepareDeadlineUs: "1000" });
    await flush();
    h.client.handleCommit(PLAN.scene.sceneId, 1_250_000n);
    await flush();
    const finished = h.sent.find((m) => m.type === "scene.finished");
    expect(
      (expectFound(finished).payload as { lanes: { reason?: string }[] }).lanes.every(
        (l) => l.reason === "clock_not_ready",
      ),
    ).toBe(true);
  });
});
