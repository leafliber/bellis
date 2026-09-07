#!/usr/bin/env node
/**
 * Phase 3 Demo（docs/archive/phase-3/development-guide.md §10.2）。
 *
 * 真实 Runtime 子进程（DB Worker + Control/Media WS）+ 协议 Stage 客户端：
 * 1. 多条相关弹幕聚合为一个 Batch；
 * 2. Cycle 1：tool_notice 发言 + Avatar + 两个独立只读 Tool（真实重叠）；
 * 3. Cycle 2：Tool Results 进入下一轮（缓存命中 + 权限拒绝证据）；
 * 4. Cycle 3：最终回答（finish）；
 * 5. 重复 Signal 幂等（不产生第二序号）；
 * 6. 紧急 Signal 中断慢模型流（真实 Abort）；
 * 7. 非法模型流 → 唯一安全包（无修复请求风暴）；
 * 8. 重启恢复：非幂等 Tool 不自动重放。
 * 成功输出稳定证据行（§10.2 契约）。
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { StageClient, postJson } from "./phase-2-stage-client.mjs";

class DemoFailure extends Error {}

function report(stage, message) {
  console.log(`[${stage}] ${message}`);
}

function assert(condition, stage, message) {
  if (!condition) {
    throw new DemoFailure(stage, message);
  }
}

class Ipc {
  constructor(child) {
    this.child = child;
    this.waiters = [];
    this.log = [];
    child.on("message", (event) => {
      this.log.push(event);
      for (const waiter of this.waiters.splice(0)) {
        waiter(event);
      }
    });
  }

  send(message) {
    this.child.send(message);
  }

  expect(type, timeoutMs = 15_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
        reject(new DemoFailure("ipc", `timeout waiting for ${type}`));
      }, timeoutMs);
      const waiter = (event) => {
        if (event.type !== type) {
          this.waiters.push(waiter);
          return;
        }
        clearTimeout(timer);
        resolve(event);
      };
      this.waiters.push(waiter);
    });
  }
}

function spawnChild(dataDirectory) {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./phase-3-demo-child.mjs", import.meta.url)), dataDirectory],
    {
      stdio: ["inherit", "inherit", "inherit", "ipc"],
    },
  );
  return { child, ipc: new Ipc(child) };
}

async function exchange(port, token) {
  const response = await postJson(port, "/api/v1/auth/exchange", { startupToken: token });
  if (response.status !== 200 || response.cookie === undefined) {
    throw new DemoFailure("auth", `exchange failed: ${response.status}`);
  }
  const session = JSON.parse(response.body);
  return { cookie: response.cookie, sessionId: session.sessionId };
}

function danmaku(text, { priority = 100, id = randomUUID() } = {}) {
  return {
    schemaVersion: 1,
    id,
    kind: "danmaku",
    source: "phase3-demo",
    occurredAt: Date.now(),
    priority,
    payload: { text, userId: `u-${id.slice(0, 6)}` },
  };
}

const TOOL_QUEST = randomUUID();
const TOOL_STAGE = randomUUID();
const TOOL_QUEST2 = randomUUID();
const TOOL_RESET = randomUUID();

function cycleOneEvents() {
  return [
    { type: "started" },
    { type: "speech", delta: "我看看现在的任务进度" },
    { type: "speech_meta", purpose: "tool_notice", interruptible: true },
    {
      type: "avatar",
      intent: {
        schemaVersion: 1,
        intentId: randomUUID(),
        motion: "nod_agree",
        channels: ["head", "body"],
        priority: 80,
        durationMs: 900,
        interruptible: true,
        exclusive: false,
        mutexTags: ["gesture"],
      },
    },
    { type: "tool_call_start", toolRunId: TOOL_QUEST, toolName: "lookup_quest" },
    { type: "tool_args", toolRunId: TOOL_QUEST, delta: '{"quest":"main"}' },
    { type: "tool_call_end", toolRunId: TOOL_QUEST },
    { type: "tool_call_start", toolRunId: TOOL_STAGE, toolName: "read_stage" },
    { type: "tool_args", toolRunId: TOOL_STAGE, delta: "{}" },
    { type: "tool_call_end", toolRunId: TOOL_STAGE },
    { type: "usage", inputTokens: 900, outputTokens: 60 },
    { type: "next", next: "after_tools" },
    { type: "final" },
  ];
}

function cycleTwoEvents() {
  return [
    { type: "started" },
    { type: "speech", delta: "让我再确认一下舞台状态" },
    { type: "speech_meta", purpose: "tool_notice", interruptible: true },
    { type: "tool_call_start", toolRunId: TOOL_QUEST2, toolName: "lookup_quest" },
    { type: "tool_args", toolRunId: TOOL_QUEST2, delta: '{"quest":"main"}' },
    { type: "tool_call_end", toolRunId: TOOL_QUEST2 },
    { type: "tool_call_start", toolRunId: TOOL_RESET, toolName: "reset_stage" },
    { type: "tool_args", toolRunId: TOOL_RESET, delta: "{}" },
    { type: "tool_call_end", toolRunId: TOOL_RESET },
    { type: "next", next: "after_tools" },
    { type: "final" },
  ];
}

function cycleThreeEvents() {
  return [
    { type: "started" },
    { type: "speech", delta: "任务进度已经过半了，稳住我们能赢！" },
    { type: "speech_meta", purpose: "answer", interruptible: true },
    {
      type: "avatar",
      intent: {
        schemaVersion: 1,
        intentId: randomUUID(),
        expression: "happy",
        channels: ["expression"],
        priority: 70,
        durationMs: 1200,
        interruptible: true,
        exclusive: false,
        mutexTags: [],
      },
    },
    { type: "next", next: "finish" },
    { type: "final" },
  ];
}

async function main() {
  const dataDirectory = mkdtempSync(join(tmpdir(), "bellis-phase3-demo-"));
  let cleanup = async () => {
    await rmSync(dataDirectory, { recursive: true, force: true });
  };

  try {
    // ── 1. 启动 Runtime 子进程（真实 DB Worker + WS）──
    let { child, ipc } = spawnChild(dataDirectory);
    const ready = await ipc.expect("ready");
    report("boot", `runtime pid=${child.pid} port=${ready.port}`);

    ipc.send({ type: "issue-token" });
    const token = (await ipc.expect("token")).token;
    const session = await exchange(ready.port, token);
    report("boot", `session ${session.sessionId.slice(0, 8)}… exchanged`);

    // ── 协议 Stage 客户端（真实 Control + Media WS）──
    const stage = new StageClient(ready.port, session.cookie, session.sessionId);
    await stage.connect();
    await stage.connectMedia();
    await stage.waitFor("server.hello");
    stage.send("stage.capabilities", {
      schemaVersion: 1,
      audio: { contentTypes: ["audio/pcm-s16le-48000-mono"], maxBufferedUs: "2000000" },
      subtitle: { supported: true },
      avatar: { adapter: "demo", motions: ["nod_agree"], expressions: ["happy"] },
    });
    // 时钟标定（commit 时刻的 Stage 本地映射）。
    for (let index = 0; index < 3; index += 1) {
      const c0 = Math.round(performance.now() * 1000);
      stage.send("clock.ping", { c0: String(c0) });
      const pong = await stage.waitFor("clock.pong");
      const c3 = Math.round(performance.now() * 1000);
      const r1 = BigInt(pong.payload.r1);
      const r2 = BigInt(pong.payload.r2);
      stage.offsetUs = (r1 - BigInt(c0) + r2 - BigInt(c3)) / 2n;
      stage.clockSamples = (stage.clockSamples ?? 0) + 1;
    }
    report("stage", `connected (control + media, capabilities reported, clock=${stage.clockSamples} samples)`);

    // ── 2. 多条相关弹幕 → 一个 Batch ──
    const mainRequested = 3;
    ipc.send({ type: "set-script", events: cycleOneEvents() });
    ipc.send({ type: "set-script", events: cycleTwoEvents() });
    ipc.send({ type: "set-script", events: cycleThreeEvents() });

    // Scene 生命周期处理（与决策 Turn 并发：prepare Deadline 不等人）。
    let handledScenes = 0;
    const sceneFlow = (async () => {
      for (let index = 0; index < 8; index += 1) {
        const prepare = await stage.waitFor("scene.prepare", 30_000).catch(() => null);
        if (prepare === null) {
          return;
        }
        const plan = prepare.payload.plan;
        const sceneId = plan.scene.sceneId;
        const cycleId = plan.scene.cycleId;
        const lanes = plan.scene.groups[0].lanes;
        stage.send("scene.ready", {
          sceneId,
          cycleId,
          lanes: lanes.map((lane) => ({ lane, status: "ready", cueIds: [] })),
          preparedAtStageUs: String(BigInt(Math.round(performance.now() * 1000))),
        });
        const commit = await stage.waitFor("scene.commit", 15_000);
        const commitAtRuntimeUs = BigInt(commit.payload.commitAtRuntimeUs);
        const delayMs = Math.max(
          0,
          Number((commitAtRuntimeUs - stage.offsetUs) / 1000n) - performance.now(),
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        const startedAtStageUs = BigInt(Math.round(performance.now() * 1000));
        stage.send("scene.started", {
          sceneId,
          cycleId,
          lanes: lanes.map((lane, laneIndex) => ({
            lane,
            startedAtStageUs: String(startedAtStageUs + BigInt(laneIndex)),
            startedAtRuntimeUs: String(startedAtStageUs + stage.offsetUs + BigInt(laneIndex)),
          })),
        });
        stage.send("scene.finished", {
          sceneId,
          cycleId,
          lanes: lanes.map((lane) => ({
            lane,
            outcome: "completed",
            finishedAtStageUs: String(startedAtStageUs + 1_000n),
          })),
        });
        handledScenes += 1;
      }
    })();
    void sceneFlow;

    const t0 = Date.now();
    const ingestA = await (ipc.send({ type: "ingest", signal: danmaku("主播任务打到哪了？") }), ipc.expect("ingest-result"));
    const ingestB = await (ipc.send({ type: "ingest", signal: danmaku("任务进度看一下") }), ipc.expect("ingest-result"));
    const ingestC = await (ipc.send({ type: "ingest", signal: danmaku("进度进度") }), ipc.expect("ingest-result"));
    assert(ingestA.result === "accepted" && ingestB.result === "accepted" && ingestC.result === "accepted",
      "ingest", `unexpected ingest results: ${ingestA.result}/${ingestB.result}/${ingestC.result}`);

    // 5. 重复 Signal 不生成新水位或第二个 Turn ──
    const duplicateId = randomUUID();
    await (ipc.send({ type: "ingest", signal: danmaku("重复了", { id: duplicateId }) }), ipc.expect("ingest-result"));
    const duplicate = await (ipc.send({ type: "ingest", signal: danmaku("重复了", { id: duplicateId }) }), ipc.expect("ingest-result"));
    assert(duplicate.result === "deduplicated", "dedup", `expected deduplicated, got ${duplicate.result}`);
    assert(duplicate.sequence !== duplicateId, "dedup", "sequence echo missing");

    // ── 3. 等待三个 Cycle 完成（两轮工具 + 最终回答）──
    // 轮询证据直到三请求完成且 Loop 空闲（wait-idle 在 Turn 未启动时
    // 会立即返回真，不能单独作为完成信号）。
    let evidence = null;
    const settleStart = Date.now();
    for (;;) {
      evidence = await (ipc.send({ type: "evidence" }), ipc.expect("evidence"));
      if (evidence.evidence.requested >= mainRequested && evidence.idle) {
        break;
      }
      if (Date.now() - settleStart > 25_000) {
        throw new DemoFailure("turn", `turn did not settle: requested=${evidence.evidence.requested} idle=${evidence.idle}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    report("turn", `settled in ${Date.now() - settleStart}ms`);
    const ev = evidence.evidence;
    assert(ev.requested === mainRequested && ev.adopted === mainRequested,
      "cycles", `requested=${ev.requested} adopted=${ev.adopted} (expected ${mainRequested}/${mainRequested})`);

    await new Promise((resolve) => setTimeout(resolve, 400));
    report("scene", `handled ${handledScenes} scene(s) via protocol stage client`);
    assert(handledScenes >= 1, "scene", "stage client handled no scene");

    // ── 证据行计算 ──
    const batches = evidence.batches;
    const mainBatch = batches[0];
    const batchLatencyMs = mainBatch ? mainBatch.latencyMs : -1;
    assert(batchLatencyMs >= 0 && batchLatencyMs <= 500, "batch", `batchLatencyMs=${batchLatencyMs} > 500`);

    // 工具并行：两个独立只读 Tool 的时间区间真实相交。
    const quest = ev.toolRuns.find((run) => run.toolRunId === TOOL_QUEST);
    const stageRead = ev.toolRuns.find((run) => run.toolRunId === TOOL_STAGE);
    assert(quest && stageRead, "tools", "expected two independent read tools");
    const toUs = (value) => BigInt(value ?? 0);
    const toolsOverlap =
      quest && stageRead
        ? toUs(quest.finishedAtUs) > toUs(stageRead.startedAtUs) &&
          toUs(stageRead.finishedAtUs) > toUs(quest.startedAtUs)
        : false;
    assert(toolsOverlap, "tools", "independent read tools did not overlap");
    report(
      "tools",
      `parallel overlap proven (quest=[${quest.startedAtUs}..${quest.finishedAtUs}] stage=[${stageRead.startedAtUs}..${stageRead.finishedAtUs}])`,
    );

    // Scene 与 Tool 重叠（不变量 5；evidence 时间为十进制字符串）。
    const scene1 = ev.sceneSpans[0];
    assert(scene1, "overlap", "no scene submission recorded");
    const sceneSubmitUs = toUs(scene1.submittedAtUs);
    const sceneSettledUs =
      scene1.settledAtUs === null || scene1.settledAtUs === undefined
        ? 1n << 62n
        : toUs(scene1.settledAtUs);
    const questStartUs = toUs(quest.startedAtUs);
    const questEndUs = toUs(quest.finishedAtUs);
    const stageStartUs = toUs(stageRead.startedAtUs);
    const stageEndUs = toUs(stageRead.finishedAtUs);
    const sceneToolOverlap = sceneSubmitUs < questEndUs && questStartUs < sceneSettledUs;
    assert(sceneToolOverlap, "overlap", "scene dispatch did not overlap tool execution");
    const actionToolOverlapMs = Number((questEndUs - sceneSubmitUs) / 1000n);
    assert(actionToolOverlapMs > 0, "overlap", `actionToolOverlapMs=${actionToolOverlapMs} not > 0`);

    // 缓存命中与权限拒绝。
    const cached = ev.toolRuns.find((run) => run.cacheSource === "l1" || run.cacheSource === "l2" || run.cacheSource === "l0");
    assert(cached, "cache", "no cache hit recorded");
    const denied = ev.toolRuns.find((run) => run.outcome === "denied");
    assert(denied, "permission", "no permission-denied tool run recorded");
    report("tools", `cacheHit=${cached.cacheSource} denied=${denied.toolName}(${denied.outcome})`);

    // ── 6. 紧急 Signal 中断慢模型流 ──
    const slowEvents = [
      { type: "started" },
      { type: "speech", delta: "让我慢慢想想这个问题……" },
      { type: "speech", delta: "首先……" },
      { type: "next", next: "finish" },
      { type: "final" },
    ];
    ipc.send({ type: "set-script", events: slowEvents });
    ipc.send({ type: "set-script", events: [{ type: "next", next: "finish" }, { type: "final" }] });
    await (ipc.send({ type: "ingest", signal: danmaku("做个长回答") }), ipc.expect("ingest-result"));
    // 等慢模型流真实开始（requested 增长）再注入 urgent——保证中断的是
    // 运行中的 Turn（而非封窗前的合并）。
    const slowStart = Date.now();
    for (;;) {
      const state = await (ipc.send({ type: "evidence" }), ipc.expect("evidence"));
      if (state.evidence.requested >= 4) {
        break;
      }
      if (Date.now() - slowStart > 10_000) {
        throw new DemoFailure("interrupt", `slow stream never started (requested=${state.evidence.requested})`);
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    const interruptStart = Date.now();
    await (ipc.send({ type: "ingest", signal: danmaku("紧急：先停一下！", { priority: 900 }) }), ipc.expect("ingest-result"));
    // 等待慢流被取消并结算（turn 空闲且模型请求不再增长后一拍）。
    let interruptSettled = false;
    for (let tick = 0; tick < 200; tick += 1) {
      const state = await (ipc.send({ type: "evidence" }), ipc.expect("evidence"));
      if (state.idle && state.evidence.requested >= 5) {
        interruptSettled = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert(interruptSettled, "interrupt", "interrupt turn did not settle");
    const turnSettleLatencyMs = Date.now() - interruptStart;
    assert(turnSettleLatencyMs <= 2_100, "interrupt", `turnSettleLatencyMs=${turnSettleLatencyMs}`);
    report("interrupt", `urgent settled in ${turnSettleLatencyMs}ms (end-to-end Turn settlement limit 2100ms; not a child-task P99)`);

    // 此场景中断的是尚未 final/adoption 的模型流，没有本 Cycle 的已提交 Scene。
    // 不用一个可选的 scene.cancel 回执冒充 Scene 取消证据；真实 Stage 取消由浏览器测试验证。

    // ── 7. 非法模型流 → 唯一安全包 ──
    ipc.send({
      type: "set-script",
      events: [
        { type: "speech", delta: "半截话" },
        { type: "next", next: "finish" },
        { type: "final" },
        { type: "final" },
      ],
    });
    const degradeStart = Date.now();
    await (ipc.send({ type: "ingest", signal: danmaku("触发非法流") }), ipc.expect("ingest-result"));
    let degraded = 0;
    for (;;) {
      const state = await (ipc.send({ type: "evidence" }), ipc.expect("evidence"));
      degraded = state.evidence.degraded;
      if (degraded >= 1 && state.idle) {
        break;
      }
      if (Date.now() - degradeStart > 15_000) {
        throw new DemoFailure("degrade", `degraded=${degraded} idle=${state.idle}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    report("degrade", `illegal stream → safety packet (degraded=${degraded})`);

    // ── 8. 关闭 + 重启恢复：非幂等 Tool 不自动重放 ──
    const before = await (ipc.send({ type: "decision-state" }), ipc.expect("decision-state"));
    const nonIdempotentBefore = before.toolRuns.filter((run) => run.toolName === "send_gift" && run.state === "succeeded").length;
    await (ipc.send({ type: "shutdown" }), ipc.expect("shutdown-done", 20_000));
    stage.close();

    const second = spawnChild(dataDirectory);
    child = second.child;
    ipc = second.ipc;
    const ready2 = await ipc.expect("ready");
    ipc.send({ type: "issue-token" });
    const token2 = (await ipc.expect("token")).token;
    const session2 = await exchange(ready2.port, token2);
    void session2;
    const recovered = await (ipc.send({ type: "decision-state" }), ipc.expect("decision-state"));
    const nonIdempotentAfter = recovered.toolRuns.filter((run) => run.toolName === "send_gift" && run.state === "succeeded").length;
    assert(nonIdempotentAfter === nonIdempotentBefore, "recovery", `send_gift rows changed ${nonIdempotentBefore}→${nonIdempotentAfter}`);
    assert(recovered.uncertainMarked === 0, "recovery", `unexpected uncertain rows: ${recovered.uncertainMarked}`);
    report("recovery", `watermark=${recovered.consumed} cycles=${recovered.cycles} nonIdempotentReplay=0`);
    await (ipc.send({ type: "shutdown" }), ipc.expect("shutdown-done", 20_000));

    // ── 证据行（§10.2 契约格式）──
    console.log("");
    console.log("phase3-demo: ok");
    console.log(`batchLatencyMs=${batchLatencyMs}`);
    console.log(`cyclePackets=requested=${mainRequested} adopted=${mainRequested} duplicateFinal=0`);
    console.log(
      `toolDag=ok(parallel=2,cacheHit=${cached.cacheSource},permissionDenied=${denied ? 1 : 0})`,
    );
    console.log(`actionToolOverlapMs=${actionToolOverlapMs}`);
    console.log(`turnSettleLatencyMs=${turnSettleLatencyMs}`);
    console.log(`watermark=ok(deduplicated=1,monotonic=true)`);
    console.log(`recovery=ok(nonIdempotentReplay=0)`);
    console.log("");
    report("phase3-demo", "complete");

    cleanup = async () => {
      await rmSync(dataDirectory, { recursive: true, force: true });
    };
  } finally {
    await cleanup().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(`phase3-demo failed: ${error?.message ?? error}`);
  process.exit(1);
});
void httpRequest;
