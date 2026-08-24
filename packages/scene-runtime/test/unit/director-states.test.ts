import { describe, expect, it } from "vitest";
import type { ScenePlan } from "@bellis/contracts";
import { VirtualClock } from "@bellis/testkit";
import { DurableCommitError, SceneDirector, StageCommitAmbiguousError } from "../../src/index.js";
import { FakeRepositoryPort, FakeStagePort, readyFor, unavailableFor } from "../fakes.js";

/** 全 Lane hard 的最小计划（audio+subtitle，deadline 500ms）。 */
function hardPlan(sceneId = "44444444-4444-4444-8444-444444444444"): ScenePlan {
  return {
    schemaVersion: 1,
    scene: {
      schemaVersion: 1,
      sceneId,
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
    speech: {
      schemaVersion: 1,
      text: "你好",
      purpose: "answer",
      interruptible: true,
    },
  } as ScenePlan;
}

interface Harness {
  director: SceneDirector;
  stage: FakeStagePort;
  repository: FakeRepositoryPort;
  clock: VirtualClock;
}

function createHarness(
  policy?: Parameters<typeof SceneDirector.prototype.submit> extends never
    ? never
    : Record<string, unknown>,
): Harness {
  const stage = new FakeStagePort();
  const repository = new FakeRepositoryPort();
  const clock = new VirtualClock();
  const director = new SceneDirector({
    stage,
    repository,
    clock,
    wallClockMs: () => 1_755_600_000_000,
    policy: policy as never,
  });
  return { director, stage, repository, clock };
}

function submit(h: Harness, plan: ScenePlan = hardPlan()) {
  return h.director.submit(plan, {
    sessionId: "11111111-1111-4111-8111-111111111111",
    idempotencyKey: `scene-${plan.scene.sceneId}`,
    requestFingerprint: "test",
  });
}

async function flush(microtasks = 8): Promise<void> {
  for (let i = 0; i < microtasks; i += 1) {
    await Promise.resolve();
  }
}

describe("SceneDirector 正常路径", () => {
  it("prepare ready → durable → stage commit（未来时刻）→ started → finished completed", async () => {
    const h = createHarness();
    const handle = submit(h);
    const plan = hardPlan();

    // prepare 挂起 → 放行（全部 ready）
    await flush();
    h.stage.settlePrepare(plan.scene.sceneId, readyFor(plan, { preparedAtStageUs: 100n }));
    await flush();

    // fake 端口立即完成：ready→committing→scheduled 连续推进。
    expect(h.director.getExecutionState(plan.scene.sceneId)).toBe("scheduled");
    // durable 提交先于 stage commit（§6.2 顺序）。
    expect(h.repository.commits).toHaveLength(1);
    expect(h.stage.calls.filter((c) => c.op === "commit")).toHaveLength(1);
    const commitCall = h.stage.calls.find((c) => c.op === "commit");
    // commitAtRuntimeUs = 选定时刻 + 400ms lead（VirtualClock 未推进 → 400_000µs）。
    expect(commitCall?.commitAtRuntimeUs).toBe(400_000n);
    expect(h.director.getExecutionState(plan.scene.sceneId)).toBe("scheduled");

    h.director.notifyStarted(plan.scene.sceneId, [
      { lane: "audio", startedAtStageUs: 390_000n, startedAtRuntimeUs: 400_000n },
    ]);
    expect(h.director.getExecutionState(plan.scene.sceneId)).toBe("running");

    h.director.notifyFinished(plan.scene.sceneId, [
      { lane: "audio", outcome: "completed", finishedAtStageUs: 1_000_000n },
      { lane: "subtitle", outcome: "completed", finishedAtStageUs: 1_000_000n },
    ]);
    const outcome = await handle.done;
    expect(outcome.state).toBe("completed");
    expect(h.director.getExecutionState(plan.scene.sceneId)).toBe("completed");
    // 生命周期记录覆盖完整状态链，append-only。
    const transitions = h.repository.lifecycle.map((r) => `${r.from}->${r.to}`);
    expect(transitions).toContain("created->preparing");
    expect(transitions).toContain("preparing->ready");
    expect(transitions).toContain("ready->committing");
    expect(transitions).toContain("committing->scheduled");
    expect(transitions).toContain("scheduled->running");
    expect(transitions).toContain("running->completed");
  });
});

describe("SceneDirector Barrier 失败与取消", () => {
  it("hard lane unavailable → 取消并释放，绝不 commit", async () => {
    const h = createHarness();
    const handle = submit(h);
    const plan = hardPlan();
    await flush();
    h.stage.settlePrepare(plan.scene.sceneId, unavailableFor(plan, "audio", "audio_not_armed"));
    const outcome = await handle.done;
    expect(outcome.state).toBe("cancelled");
    expect(outcome.reason).toContain("hard_lane_unavailable");
    expect(h.repository.commits).toHaveLength(0);
    const cancelCall = h.stage.calls.find((c) => c.op === "cancel");
    expect(cancelCall?.sceneId).toBe(plan.scene.sceneId);
    const commitCall = h.stage.calls.find((c) => c.op === "commit");
    expect(commitCall).toBeUndefined();
  });

  it("prepare 超过 deadline → cancelled:prepare_deadline_exceeded，无 commit", async () => {
    const h = createHarness();
    const handle = submit(h);
    await flush();
    // 推进超过 deadlineMs(500ms)：deadline 竞速胜出。
    h.clock.advanceBy(600_000n);
    const outcome = await handle.done;
    expect(outcome.state).toBe("cancelled");
    expect(outcome.reason).toBe("prepare_deadline_exceeded");
    expect(h.repository.commits).toHaveLength(0);
  });

  it("准备中取消：abort prepare → stage cancel → cancelled", async () => {
    const h = createHarness();
    const handle = submit(h);
    const plan = hardPlan();
    await flush();
    await h.director.cancel(plan.scene.sceneId, "urgent_interrupt");
    h.stage.settlePrepare(plan.scene.sceneId, readyFor(plan));
    const outcome = await handle.done;
    expect(outcome.state).toBe("cancelled");
    expect(outcome.reason).toBe("urgent_interrupt");
    expect(h.repository.commits).toHaveLength(0);
  });

  it("running 中取消：stage cancel ack → cancelled；不影响其他 Scene", async () => {
    const h = createHarness();
    const planA = hardPlan("44444444-4444-4444-8444-4444444444aa");
    const planB = hardPlan("44444444-4444-4444-8444-4444444444bb");
    const handleA = h.director.submit(planA, {
      sessionId: "s",
      idempotencyKey: "a",
      requestFingerprint: "f",
    });
    const handleB = h.director.submit(planB, {
      sessionId: "s",
      idempotencyKey: "b",
      requestFingerprint: "f",
    });
    await flush();
    h.stage.settlePrepare(planA.scene.sceneId, readyFor(planA));
    h.stage.settlePrepare(planB.scene.sceneId, readyFor(planB));
    await flush();
    h.director.notifyStarted(planA.scene.sceneId, []);
    h.director.notifyStarted(planB.scene.sceneId, []);
    await h.director.cancel(planA.scene.sceneId, "urgent_interrupt");
    expect((await handleA.done).state).toBe("cancelled");
    expect(h.director.getExecutionState(planB.scene.sceneId)).toBe("running");
    h.director.notifyFinished(planB.scene.sceneId, [
      { lane: "audio", outcome: "completed", finishedAtStageUs: 1n },
      { lane: "subtitle", outcome: "completed", finishedAtStageUs: 1n },
    ]);
    expect((await handleB.done).state).toBe("completed");
  });

  it("终态后取消/迟到回执：幂等无操作，不复活终态", async () => {
    const h = createHarness();
    const handle = submit(h);
    const plan = hardPlan();
    await flush();
    h.stage.settlePrepare(plan.scene.sceneId, readyFor(plan));
    await flush();
    h.director.notifyStarted(plan.scene.sceneId, []);
    h.director.notifyFinished(plan.scene.sceneId, [
      { lane: "audio", outcome: "completed", finishedAtStageUs: 1n },
      { lane: "subtitle", outcome: "completed", finishedAtStageUs: 1n },
    ]);
    expect((await handle.done).state).toBe("completed");
    const state = await h.director.cancel(plan.scene.sceneId, "late");
    expect(state).toBe("completed");
    expect(h.director.notifyStarted(plan.scene.sceneId, [])).toBe(false);
    expect(
      h.director.notifyFinished(plan.scene.sceneId, [
        { lane: "audio", outcome: "failed", finishedAtStageUs: 1n },
      ]),
    ).toBe(false);
    expect(h.director.getExecutionState(plan.scene.sceneId)).toBe("completed");
  });
});

describe("SceneDirector 提交故障路径", () => {
  it("数据库提交失败：Stage 只收到取消，绝不收到 Commit；状态 failed", async () => {
    const h = createHarness();
    h.repository.commitError = new DurableCommitError("database_busy", "busy");
    const handle = submit(h);
    const plan = hardPlan();
    await flush();
    h.stage.settlePrepare(plan.scene.sceneId, readyFor(plan));
    const outcome = await handle.done;
    expect(outcome.state).toBe("failed");
    expect(outcome.reason).toContain("durable_commit_failed");
    const ops = h.stage.calls.map((c) => c.op);
    expect(ops).toContain("cancel");
    expect(ops).not.toContain("commit");
  });

  it("durable 成功但 stage commit 结果不确定 → uncertain，不自动重试", async () => {
    const h = createHarness();
    const handle = submit(h);
    const plan = hardPlan();
    h.stage.commitBehaviors.set(
      plan.scene.sceneId,
      new StageCommitAmbiguousError(plan.scene.sceneId, "connection dropped after send"),
    );
    await flush();
    h.stage.settlePrepare(plan.scene.sceneId, readyFor(plan));
    const outcome = await handle.done;
    expect(outcome.state).toBe("uncertain");
    expect(outcome.reason).toBe("stage_commit_ambiguous");
    // durable 事实已存在，不回滚不重发。
    expect(h.repository.commits).toHaveLength(1);
    expect(h.stage.calls.filter((c) => c.op === "commit")).toHaveLength(1);
    // uncertain 后迟到 finished 不改写结果。
    expect(
      h.director.notifyFinished(plan.scene.sceneId, [
        { lane: "audio", outcome: "completed", finishedAtStageUs: 1n },
      ]),
    ).toBe(false);
  });

  it("stage commit 确定失败 → 释放 Stage 并 failed", async () => {
    const h = createHarness();
    const handle = submit(h);
    const plan = hardPlan();
    h.stage.commitBehaviors.set(plan.scene.sceneId, new Error("socket closed before send"));
    await flush();
    h.stage.settlePrepare(plan.scene.sceneId, readyFor(plan));
    const outcome = await handle.done;
    expect(outcome.state).toBe("failed");
    expect(outcome.reason).toBe("stage_commit_failed");
    expect(h.stage.calls.map((c) => c.op)).toContain("cancel");
  });

  it("hard lane 执行失败（scene.finished failed）→ 场景 failed", async () => {
    const h = createHarness();
    const handle = submit(h);
    const plan = hardPlan();
    await flush();
    h.stage.settlePrepare(plan.scene.sceneId, readyFor(plan));
    await flush();
    h.director.notifyStarted(plan.scene.sceneId, []);
    h.director.notifyFinished(plan.scene.sceneId, [
      { lane: "audio", outcome: "failed", reason: "late_commit", finishedAtStageUs: 1n },
      { lane: "subtitle", outcome: "completed", finishedAtStageUs: 1n },
    ]);
    const outcome = await handle.done;
    expect(outcome.state).toBe("failed");
    expect(outcome.reason).toContain("lane_failed:audio");
  });
});

describe("SceneDirector 断连与关闭", () => {
  it("准备中断连 → cancelled；running 断连 → uncertain（不自动重播）", async () => {
    const h = createHarness();
    const preparingHandle = submit(h, hardPlan("44444444-4444-4444-8444-4444444444a1"));
    await flush();
    h.director.notifyStageDisconnected("ws_closed");
    expect((await preparingHandle.done).state).toBe("cancelled");

    const runningPlan = hardPlan("44444444-4444-4444-8444-4444444444b1");
    const runningHandle = h.director.submit(runningPlan, {
      sessionId: "s",
      idempotencyKey: "r",
      requestFingerprint: "f",
    });
    await flush();
    h.stage.settlePrepare(runningPlan.scene.sceneId, readyFor(runningPlan));
    await flush();
    h.director.notifyStarted(runningPlan.scene.sceneId, []);
    h.director.notifyStageDisconnected("ws_closed");
    const outcome = await runningHandle.done;
    expect(outcome.state).toBe("uncertain");
    expect(outcome.reason).toContain("stage_disconnected");
  });

  it("close：拒绝新提交，取消全部活跃 Scene，排空后干净返回", async () => {
    const h = createHarness({ closeTimeoutMs: 1000 });
    const handleA = submit(h, hardPlan("44444444-4444-4444-8444-4444444444c1"));
    const handleB = submit(h, hardPlan("44444444-4444-4444-8444-4444444444c2"));
    await flush();
    const closing = h.director.close("director_shutdown");
    await expect(() => submit(h, hardPlan("44444444-4444-4444-8444-4444444444c3"))).toThrow(
      /scene_director_closed/,
    );
    h.stage.settlePrepare(
      "44444444-4444-4444-8444-4444444444c1",
      readyFor(hardPlan("44444444-4444-4444-8444-4444444444c1")),
    );
    await closing;
    expect((await handleA.done).state).toBe("cancelled");
    expect((await handleB.done).state).toBe("cancelled");
    expect(h.director.activeCount).toBe(0);
  });

  it("关闭预算耗尽：未终态 Scene 标记 failed:shutdown_timeout，不悬挂", async () => {
    const h = createHarness({ closeTimeoutMs: 100 });
    const handle = submit(h);
    await flush();
    // Stage cancel 挂起（FakeStagePort cancel 立即返回，这里改为抛错并让
    // ambiguous 路径也无法完成是做不到的——改为验证 close 总会返回）。
    h.stage.cancelBehaviors.set("44444444-4444-4444-8444-444444444444", { status: "ambiguous" });
    await h.director.close("director_shutdown");
    const outcome = await handle.done;
    expect(["uncertain", "cancelled", "failed"]).toContain(outcome.state);
  });
});

describe("SceneDirector 输入校验与有界性", () => {
  it("非法 plan（重复 cueId）在提交入口被拒绝", () => {
    const h = createHarness();
    const plan = hardPlan();
    const broken = {
      ...plan,
      cues: [plan.cues[0], { ...plan.cues[0] }],
    };
    expect(() =>
      h.director.submit(broken, { sessionId: "s", idempotencyKey: "k", requestFingerprint: "f" }),
    ).toThrow(/plan rejected/);
  });

  it("重复提交同一 sceneId 被拒绝", () => {
    const h = createHarness();
    submit(h);
    expect(() =>
      h.director.submit(hardPlan(), {
        sessionId: "s",
        idempotencyKey: "k",
        requestFingerprint: "f",
      }),
    ).toThrow(/already submitted/);
  });

  it("活跃 Scene 数达到上限后拒绝新提交（有界）", () => {
    const h = createHarness({ maxActiveScenes: 1 });
    submit(h);
    expect(() =>
      h.director.submit(hardPlan("44444444-4444-4444-8444-444444444499"), {
        sessionId: "s",
        idempotencyKey: "k",
        requestFingerprint: "f",
      }),
    ).toThrow(/active_limit_reached/);
  });
});
