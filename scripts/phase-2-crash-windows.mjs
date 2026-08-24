#!/usr/bin/env node
/**
 * Phase 2 四个关键 Crash Window 定向覆盖（docs/phase-2-development-guide.md §10.2）。
 *
 * 每个窗口：子进程 Runtime 在 Director 指定窗口 SIGKILL 自身（无清理路径
 * 的硬崩溃）→ 同目录重启 → resumeSessionId 重新挂载逻辑 Session → Stage
 * 重连对账。不变量（全部窗口共用）：
 *
 * - W1 Prepare 后、DB Commit 前：Scene 未落库（lastCommittedScene 缺席），
 *   重连无 prepare/commit 重放（无外部效果）。
 * - W2 DB Commit 后、Stage Commit 前：durable 事实落库，Stage 从未收到
 *   commit，重连不自动补发（uncertain 语义，绝不自动重试外部效果）。
 * - W3 Stage 已收到 Commit、Runtime 收到 started 前：Stage 持有 commit
 *   事实；重启后无 prepare/commit 重放。
 * - W4 Cancel 已入队、Ack 前：重连后 cancel 至多重放一次（可靠性语义），
 *   绝不重复取消；无 prepare/commit 重放。
 * - W0（同进程断连，非崩溃）：running 断连 → uncertain → 重连快照
 *   schemaVersion 2（activeScene.executionState=uncertain、
 *   requiresReprepare=true）。
 *
 * 任一步失败非零退出；不访问公网；成功/失败都清理临时资源。
 * 依赖已构建产物：先运行 `pnpm build`。
 */
import { fork } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Ipc,
  ScriptFailure,
  StageClient,
  postJson,
  traceId,
  uuid,
} from "./phase-2-stage-client.mjs";

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const CHILD = join(SCRIPT_DIR, "phase-2-demo-child.mjs");
const LANES = ["audio", "subtitle", "avatar"];
const CAPABILITIES = {
  schemaVersion: 1,
  audio: { contentTypes: ["audio/pcm-s16le-48000-mono"], maxBufferedUs: "2000000" },
  subtitle: { supported: true },
  avatar: { adapter: "crash-window", motions: ["nod_agree"], expressions: ["happy"] },
};

const evidence = [];
function report(key, value) {
  evidence.push([key, value]);
  process.stdout.write(`${key}=${value}\n`);
}

function forkChild(dataDirectory, faultPoint) {
  return fork(
    CHILD,
    faultPoint === undefined ? [dataDirectory] : [dataDirectory, faultPoint],
    { stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
}

function collectDiagnostics(child) {
  const chunks = [];
  for (const stream of [child.stdout, child.stderr]) {
    if (stream !== null) {
      stream.on("data", (chunk) => {
        chunks.push(chunk.toString("utf8"));
        if (chunks.length > 200) {
          chunks.shift();
        }
      });
    }
  }
  return () => chunks.join("");
}

/** 认证（可携带 resumeSessionId）→ {cookie, sessionId}。 */
async function auth(child, ipc, port, resumeSessionId) {
  child.send({ type: "issue-token" });
  const { token } = await ipc.expect("token");
  const exchange = await postJson(port, "/api/v1/auth/exchange", {
    startupToken: token,
    ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
  });
  if (exchange.status !== 200 || exchange.cookie === undefined) {
    throw new ScriptFailure("auth", `exchange failed: ${exchange.status} ${exchange.body}`);
  }
  return { cookie: exchange.cookie, session: JSON.parse(exchange.body) };
}

async function connectStage(port, cookie, sessionId) {
  const stage = new StageClient(port, cookie, sessionId);
  await stage.connect();
  await stage.waitFor("server.hello");
  // client.hello 已在 connect() 内以「水位未知」身份发出（不携带 ack）：
  // resume 连接按协议强制服务端发送完整快照（scene-execution.md §8）。
  stage.send("stage.capabilities", { capabilities: CAPABILITIES });
  return stage;
}

/** 提交 → 收到 prepare → 回 ready；返回 {sceneId, cycleId}。 */
async function submitAndReady(child, ipc, stage, text) {
  const cycleId = uuid();
  child.send({ type: "submit", cycleId, traceId: traceId(), text });
  const submitted = await ipc.expect("submit-result");
  if (!submitted.ok) {
    throw new ScriptFailure("submit", `rejected: ${submitted.kind}`);
  }
  const prepare = await stage.waitFor("scene.prepare");
  const plan = prepare.payload.plan;
  stage.send("scene.ready", {
    sceneId: plan.scene.sceneId,
    cycleId: plan.scene.cycleId,
    lanes: plan.scene.groups[0].lanes.map((lane) => ({ lane, status: "ready", cueIds: [] })),
    preparedAtStageUs: String(Date.now()),
  });
  return { sceneId: plan.scene.sceneId, cycleId: plan.scene.cycleId };
}

async function killChild(child) {
  // 已退出的子进程不能再挂 'exit' 监听等待（事件已触发，Promise 永不
  // resolve，事件循环清空后进程以 0 静默退出）。
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGKILL");
    setTimeout(() => resolve(), 5000).unref?.();
  });
}

/** 重启 + resume 重连 + 崩溃后不变量检查。 */
async function restartAndVerify(options) {
  const { dataDirectory, sessionId, expectCommitted, windowKey } = options;
  const child = forkChild(dataDirectory);
  const diagnostics = collectDiagnostics(child);
  const ipc = new Ipc(child);
  const ready = await ipc.expect("ready");
  const { cookie } = await auth(child, ipc, ready.port, sessionId);
  const stage = await connectStage(ready.port, cookie, sessionId);
  const snapshot = await stage.waitFor("session.snapshot");
  const snapshotBody = snapshot.payload.snapshot;
  if (snapshotBody.schemaVersion !== 1) {
    // 跨重启无 Director 状态：不得虚构执行状态（W0 之外均为 v1 形态）。
    throw new ScriptFailure(windowKey, `expected v1 snapshot, got v${snapshotBody.schemaVersion}`);
  }
  if (expectCommitted && snapshotBody.lastCommittedScene?.sceneId !== options.sceneId) {
    throw new ScriptFailure(windowKey, "committed scene missing from snapshot");
  }
  if (!expectCommitted && snapshotBody.lastCommittedScene !== undefined) {
    throw new ScriptFailure(windowKey, "snapshot claims a committed scene that never committed");
  }

  // 崩溃后不自动重播：无新 submit 时不得出现 prepare/commit。
  const strayPrepare = await stage.observeType("scene.prepare", 400);
  const strayCommit = await stage.observeType("scene.commit", 200);
  if (strayPrepare !== null || strayCommit !== null) {
    throw new ScriptFailure(windowKey, "restarted runtime auto-replayed scene effects");
  }

  // W4 附加：cancel 至多重放一次。
  let cancelCount = 0;
  if (options.expectCancelReplayPossible) {
    const replayedCancel = await stage.observeType("scene.cancel", 400);
    if (replayedCancel !== null) {
      cancelCount += 1;
      stage.send("scene.cancel.ack", {
        sceneId: replayedCancel.payload.sceneId,
        cycleId: replayedCancel.payload.cycleId,
        lanes: LANES.map((lane) => ({ lane, stopped: true })),
        stoppedAtStageUs: String(Date.now()),
      });
      const again = await stage.observeType("scene.cancel", 300);
      if (again !== null) {
        throw new ScriptFailure(windowKey, "cancel replayed more than once");
      }
    }
  }

  child.send({ type: "shutdown" });
  const exitInfo = await Promise.race([
    new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal }))),
    new Promise((_, reject) =>
      setTimeout(() => reject(new ScriptFailure(windowKey, "graceful close timed out")), 10_000),
    ),
  ]);
  if (exitInfo.code !== 0) {
    throw new ScriptFailure(
      windowKey,
      `restart child exited ${exitInfo.code}/${exitInfo.signal}\n${diagnostics().split("\n").slice(-10).join("\n")}`,
    );
  }
  stage.close();
  return { cancelCount };
}

async function crashWindow(faultPoint, verifier) {
  const dataDirectory = mkdtempSync(join(tmpdir(), `bellis-phase2-crash-${faultPoint}-`));
  let child = null;
  let stage = null;
  try {
    child = forkChild(dataDirectory, faultPoint);
    collectDiagnostics(child);
    const ipc = new Ipc(child);
    const ready = await ipc.expect("ready");
    const { cookie, session } = await auth(child, ipc, ready.port);
    stage = await connectStage(ready.port, cookie, session.sessionId);
    await stage.connectMedia();
    const context = { child, ipc, stage, session, ready, dataDirectory };
    const { crashConfirmed, ...rest } = await verifier(context);
    if (!crashConfirmed) {
      throw new ScriptFailure(faultPoint, "child did not crash in the expected window");
    }
    await killChild(child);
    child = null;
    stage.close();
    stage = null;
    await restartAndVerify({
      dataDirectory,
      sessionId: session.sessionId,
      windowKey: faultPoint,
      ...rest,
    });
  } finally {
    stage?.close();
    await killChild(child ?? { exitCode: 0, signalCode: null, kill: () => {} });
    rmSync(dataDirectory, { recursive: true, force: true });
  }
}

async function w0SnapshotV2() {
  const dataDirectory = mkdtempSync(join(tmpdir(), "bellis-phase2-crash-snapshot-"));
  let child = null;
  let stage = null;
  try {
    child = forkChild(dataDirectory);
    const ipc = new Ipc(child);
    const ready = await ipc.expect("ready");
    const { cookie, session } = await auth(child, ipc, ready.port);
    stage = await connectStage(ready.port, cookie, session.sessionId);
    await stage.connectMedia();
    const { sceneId } = await submitAndReady(child, ipc, stage, "运行中断连");
    const commit = await stage.waitFor("scene.commit");
    // running 中：回 started（不回 finished）→ 断开 Control（模拟 Stage 掉线）。
    const startedAtUs = BigInt(Date.now()) * 1000n;
    stage.send("scene.started", {
      sceneId,
      cycleId: commit.payload.cycleId,
      lanes: LANES.map((lane, index) => ({
        lane,
        startedAtStageUs: String(startedAtUs + BigInt(index)),
        startedAtRuntimeUs: String(startedAtUs + BigInt(index)),
      })),
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    stage.close();
    stage = null;
    const settled = await ipc.expect("scene-settled", 5000);
    if (settled.state !== "uncertain") {
      throw new ScriptFailure("w0", `expected uncertain after disconnect, got ${settled.state}`);
    }

    // 重连（resume，无 lastAck → 强制快照）：v2 + uncertain + requiresReprepare。
    const stage2 = await connectStage(ready.port, cookie, session.sessionId);
    const snapshot = await stage2.waitFor("session.snapshot");
    const body = snapshot.payload.snapshot;
    if (body.schemaVersion !== 2) {
      throw new ScriptFailure("w0", `expected v2 snapshot, got v${body.schemaVersion}`);
    }
    const active = body.activeScene;
    if (
      active === null ||
      active.sceneId !== sceneId ||
      active.executionState !== "uncertain" ||
      active.outcomeCertain !== false ||
      active.requiresReprepare !== true
    ) {
      throw new ScriptFailure("w0", `unexpected activeScene: ${JSON.stringify(active)}`);
    }
    // uncertain Scene 不自动重播：无新 submit 时无 prepare/commit。
    const stray = await stage2.observeType("scene.prepare", 400);
    if (stray !== null) {
      throw new ScriptFailure("w0", "uncertain scene auto-replayed after reconnect");
    }
    stage2.close();
    child.send({ type: "shutdown" });
    await new Promise((resolve) => child.on("exit", (code) => resolve(code)));
    report("snapshotV2", `ok(uncertain,requiresReprepare,scene=${sceneId.slice(0, 8)}…)`);
  } finally {
    stage?.close();
    await killChild(child ?? { exitCode: 0, signalCode: null, kill: () => {} });
    rmSync(dataDirectory, { recursive: true, force: true });
  }
}

async function main() {
  await w0SnapshotV2();

  // W1：Prepare 通过、DB Commit 前。
  await crashWindow("before_durable_commit", async ({ child, ipc, stage }) => {
    const { sceneId } = await submitAndReady(child, ipc, stage, "崩溃在提交前");
    void sceneId;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return { crashConfirmed: child.exitCode === null && child.signalCode === "SIGKILL", expectCommitted: false, sceneId };
  });
  report("crashWindow1", "ok(pre-commit:无落库,无重放)");

  // W2：DB Commit 后、Stage Commit 前。
  await crashWindow("after_durable_commit", async ({ child, ipc, stage }) => {
    const { sceneId } = await submitAndReady(child, ipc, stage, "崩溃在舞台提交前");
    const leaked = await stage.observeType("scene.commit", 300);
    if (leaked !== null) {
      throw new ScriptFailure("after_durable_commit", "stage received commit before crash window");
    }
    await new Promise((resolve) => setTimeout(resolve, 1200));
    return { crashConfirmed: child.exitCode === null && child.signalCode === "SIGKILL", expectCommitted: true, sceneId };
  });
  report("crashWindow2", "ok(durable落库,无commit外泄,不补发)");

  // W3：Stage 已收到 Commit、started 未回。
  await crashWindow("after_stage_commit", async ({ child, ipc, stage }) => {
    const { sceneId } = await submitAndReady(child, ipc, stage, "崩溃在开始前");
    const commit = await stage.waitFor("scene.commit");
    void commit;
    await new Promise((resolve) => setTimeout(resolve, 1200));
    return { crashConfirmed: child.exitCode === null && child.signalCode === "SIGKILL", expectCommitted: true, sceneId };
  });
  report("crashWindow3", "ok(commit已送达,无重放)");

  // W4：Cancel 已入队、Ack 前。
  await crashWindow("after_cancel_sent", async ({ child, ipc, stage }) => {
    const { sceneId } = await submitAndReady(child, ipc, stage, "紧急打断崩溃");
    const commit = await stage.waitFor("scene.commit");
    void commit;
    const startedAtUs = BigInt(Date.now()) * 1000n;
    stage.send("scene.started", {
      sceneId,
      cycleId: commit.payload.cycleId,
      lanes: LANES.map((lane) => ({
        lane,
        startedAtStageUs: String(startedAtUs),
        startedAtRuntimeUs: String(startedAtUs),
      })),
    });
    child.send({ type: "interrupt", reason: "crash_window_cancel" });
    const cancel = await stage.observeType("scene.cancel", 1000);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return {
      crashConfirmed: child.exitCode === null && child.signalCode === "SIGKILL",
      expectCommitted: true,
      sceneId,
      expectCancelReplayPossible: true,
      observedCancelPreCrash: cancel !== null,
    };
  });
  report("crashWindow4", "ok(cancel≤1次,无重复取消)");

  if (evidence.length < 5) {
    throw new ScriptFailure("summary", "missing evidence lines");
  }
  process.stdout.write("--- phase 2 crash windows complete ---\n");
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
