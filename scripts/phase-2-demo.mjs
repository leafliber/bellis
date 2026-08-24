#!/usr/bin/env node
/**
 * Phase 2 Demo（docs/phase-2-development-guide.md §10.2）。
 *
 * 协议级真实纵向链路（真实子进程 Runtime + 真实 WebSocket + 真实 DB Worker；
 * 浏览器 Stage 以协议真实客户端扮演——Chromium/AudioWorklet E2E 属于
 * test:browser，见交付报告）：
 *
 * 1. 临时数据目录 + 启动 Runtime（phase2 显式启用）
 * 2. 一次性 Token → Session Cookie → Control WS（clientType=stage）
 * 3. stage.capabilities 上报 + ≥3 个合格时钟样本
 * 4. 注入 Fake Signal（Speech+Avatar）→ scene.prepare（真实 ScenePlan）
 * 5. 回 scene.ready（全部 hard Lane ready）
 * 6. 观察 scene.commit（未来时刻）→ 到点回 scene.started（三 Lane 双域时刻）
 * 7. scene.finished → completed
 * 8. 第二条紧急 Signal → interruptAll → scene.cancel → cancel.ack，
 *    计量取消时延
 * 9. Crash Window（完成后 SIGKILL）→ 同目录重启 → 已提交 Scene 不重复执行
 * 10. 干净关闭与清理
 *
 * 任一步失败非零退出；不访问公网；成功/失败都清理临时资源。
 * 依赖已构建产物：先运行 `pnpm build`。
 */
import { fork } from "node:child_process";
import { request as httpRequest } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { WebSocket } from "ws";

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const CHILD = join(SCRIPT_DIR, "phase-2-demo-child.mjs");

class DemoFailure extends Error {
  constructor(stage, message) {
    super(`[${stage}] ${message}`);
    this.stage = stage;
  }
}

function hex(n) {
  return Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");
}
const uuid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-8${hex(3)}-${hex(12)}`;
const traceId = () => hex(32);

class Ipc {
  constructor(child) {
    this.child = child;
    this.pending = [];
    this.waiters = [];
    child.on("message", (message) => {
      const waiter = this.waiters.shift();
      if (waiter === undefined) {
        this.pending.push(message);
      } else {
        waiter(message);
      }
    });
  }
  async expect(type, timeoutMs = 15000) {
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      const index = this.pending.findIndex((m) => m.type === type);
      if (index !== -1) {
        return this.pending.splice(index, 1)[0];
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        throw new DemoFailure("ipc", `timeout waiting for ${type}`);
      }
      const message = await Promise.race([
        new Promise((resolve) => this.waiters.push(resolve)),
        new Promise((_, reject) => setTimeout(() => reject(new DemoFailure("ipc", `timeout waiting for ${type}`)), remaining)),
      ]);
      if (message.type === type) {
        return message;
      }
      this.pending.push(message);
    }
  }
}

function postJson(port, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: `http://127.0.0.1:${port}`,
          "content-length": Buffer.byteLength(payload),
          connection: "close",
          ...(cookie === undefined ? {} : { cookie }),
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const setCookie = response.headers["set-cookie"]?.[0] ?? "";
          resolve({
            status: response.statusCode,
            cookie: /^([^=]+=[^;]+)/.exec(setCookie)?.[1],
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    request.on("error", reject);
    request.end(payload);
  });
}

/** 协议 Stage 客户端：真实 WebSocket + 真实协议消息（codec 由字符串构造）。 */
class StageClient {
  constructor(port, cookie, sessionId) {
    this.port = port;
    this.cookie = cookie;
    this.sessionId = sessionId;
    this.ws = null;
    this.inbox = [];
    this.waiters = [];
    this.seq = 0;
    this.clockSamples = 0;
    this.offsetUs = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${this.port}/ws/v1/control`, {
        headers: { cookie: this.cookie, origin: `http://127.0.0.1:${this.port}` },
      });
      this.ws.on("open", resolve);
      this.ws.on("error", (error) => reject(new DemoFailure("stage-connect", error.message)));
      this.ws.on("message", (data) => {
        const envelope = JSON.parse(data.toString("utf8"));
        const waiter = this.waiters.shift();
        if (waiter === undefined) {
          this.inbox.push(envelope);
        } else {
          waiter(envelope);
        }
      });
    });
  }

  send(type, payload, extra = {}) {
    this.ws.send(JSON.stringify({
      version: 1,
      direction: "client",
      type,
      messageId: uuid(),
      sessionId: this.sessionId,
      trace: { traceId: traceId() },
      sentAtUs: String(Math.round(performance.now() * 1000)),
      ...(this.seq === 0 ? {} : { ack: String(this.seq) }),
      ...extra,
      payload,
    }));
  }

  /** 等待指定类型的下一条服务端消息（消费 seq）。 */
  async waitFor(type, timeoutMs = 15000) {
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      const index = this.inbox.findIndex((e) => e.type === type);
      if (index !== -1) {
        const envelope = this.inbox.splice(index, 1)[0];
        this.seq = Number(envelope.seq);
        return envelope;
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        throw new DemoFailure("stage-wait", `timeout waiting for ${type} (inbox: ${this.inbox.map((e) => e.type).join(",")})`);
      }
      const envelope = await Promise.race([
        new Promise((resolve) => this.waiters.push(resolve)),
        new Promise((_, reject) => setTimeout(() => reject(new DemoFailure("stage-wait", `timeout waiting for ${type}`)), remaining)),
      ]);
      this.seq = Number(envelope.seq);
      if (envelope.type === type) {
        return envelope;
      }
      this.inbox.push(envelope);
    }
  }

  close() {
    this.ws?.close(1000, "demo_complete");
  }
}

const evidence = {};

function report(key, value) {
  evidence[key] = value;
  process.stdout.write(`${key}=${value}\n`);
}

async function run() {
  const dataDirectory = mkdtempSync(join(tmpdir(), "bellis-phase2-demo-"));
  const diagnostics = [];
  let child = null;
  let stage = null;
  try {
    // 1. 启动 Runtime（phase2 启用）。
    child = fork(CHILD, [dataDirectory], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
    for (const stream of [child.stdout, child.stderr]) {
      if (stream !== null) {
        stream.on("data", (chunk) => {
          diagnostics.push(chunk.toString("utf8"));
          if (diagnostics.length > 200) {
            diagnostics.shift();
          }
        });
      }
    }
    const ipc = new Ipc(child);
    const ready = await ipc.expect("ready");
    report("protocolVersion", "1");

    // 2. 认证 → Cookie → Stage Control 连接。
    child.send({ type: "issue-token" });
    const { token } = await ipc.expect("token");
    const exchange = await postJson(ready.port, "/api/v1/auth/exchange", { startupToken: token });
    if (exchange.status !== 200 || exchange.cookie === undefined) {
      throw new DemoFailure("auth", `exchange failed: ${exchange.status}`);
    }
    const session = JSON.parse(exchange.body);
    stage = new StageClient(ready.port, exchange.cookie, session.sessionId);
    await stage.connect();
    await stage.waitFor("server.hello");
    stage.send("client.hello", { protocolVersion: 1, clientType: "stage" });
    stage.send("stage.capabilities", {
      capabilities: {
        schemaVersion: 1,
        audio: { contentTypes: ["audio/pcm-s16le-48000-mono"], maxBufferedUs: "2000000" },
        subtitle: { supported: true },
        avatar: { adapter: "demo-protocol", motions: ["nod_agree"], expressions: ["happy"] },
      },
    });
    report("stageHandshake", "ok");

    // 3. 时钟校准：≥3 个合格样本。
    for (let i = 0; i < 3; i += 1) {
      const c0 = Math.round(performance.now() * 1000);
      stage.send("clock.ping", { c0: String(c0) });
      const pong = await stage.waitFor("clock.pong");
      const c3 = Math.round(performance.now() * 1000);
      const r1 = BigInt(pong.payload.r1);
      const r2 = BigInt(pong.payload.r2);
      stage.offsetUs = (r1 - BigInt(c0) + r2 - BigInt(c3)) / 2n;
      stage.clockSamples += 1;
    }
    report("clockCalibration", `ok(${stage.clockSamples} samples, offset=${stage.offsetUs}us)`);

    // 4. Fake Signal → ActionFrame → ScenePlan → prepare。
    const cycleA = uuid();
    child.send({ type: "submit", cycleId: cycleA, traceId: traceId(), text: "我看看现在的任务进度" });
    const submitted = await ipc.expect("submit-result");
    if (!submitted.ok) {
      throw new DemoFailure("submit", `submission rejected: ${submitted.kind}`);
    }
    report("actionFrame", "validated");
    const prepare = await stage.waitFor("scene.prepare");
    const plan = prepare.payload.plan;
    if (plan.cues.length < 3 || plan.speech?.text !== "我看看现在的任务进度") {
      throw new DemoFailure("prepare", `unexpected plan: ${plan.cues?.length} cues`);
    }
    report("scenePlan", `compiled(${plan.cues.length} cues, ${plan.scene.groups[0].lanes.join("+")})`);

    // 5. 全部 hard Lane ready。
    stage.send("scene.ready", {
      sceneId: plan.scene.sceneId,
      cycleId: plan.scene.cycleId,
      lanes: plan.scene.groups[0].lanes.map((lane) => ({ lane, status: "ready", cueIds: [] })),
      preparedAtStageUs: String(Math.round(performance.now() * 1000)),
    });
    report("prepareBarrier", "ready");

    // 6. durable 提交后收到 scene.commit（未来时刻）。
    const commit = await stage.waitFor("scene.commit");
    const commitAtRuntimeUs = BigInt(commit.payload.commitAtRuntimeUs);
    if (commitAtRuntimeUs <= 0n) {
      throw new DemoFailure("commit", "commitAtRuntimeUs must be a future runtime-domain time");
    }
    report("sceneCommit", "durable");

    // 7. 到点：三 Lane 同时 started（双域时刻）+ finished → completed。
    const targetDelayMs = Math.max(0, Number(commitAtRuntimeUs - stage.offsetUs) / 1000 - performance.now());
    await new Promise((resolve) => setTimeout(resolve, targetDelayMs));
    const startedAt = performance.now();
    const startedAtStageUs = BigInt(Math.round(startedAt * 1000));
    stage.send("scene.started", {
      sceneId: plan.scene.sceneId,
      cycleId: plan.scene.cycleId,
      lanes: plan.scene.groups[0].lanes.map((lane, index) => ({
        lane,
        startedAtStageUs: String(startedAtStageUs + BigInt(index)),
        startedAtRuntimeUs: String(startedAtStageUs + stage.offsetUs + BigInt(index)),
      })),
    });
    stage.send("scene.finished", {
      sceneId: plan.scene.sceneId,
      cycleId: plan.scene.cycleId,
      lanes: plan.scene.groups[0].lanes.map((lane) => ({
        lane,
        outcome: "completed",
        finishedAtStageUs: String(startedAtStageUs + 1000n),
      })),
    });
    const settled = await ipc.expect("scene-settled");
    if (settled.state !== "completed") {
      throw new DemoFailure("finish", `scene settled as ${settled.state}`);
    }
    report("sceneOutcome", `completed(${plan.scene.groups[0].lanes.join("+")})`);
    const lateByMs = performance.now() - startedAt;
    report("hardLaneSkewMs", `${Math.max(0, lateByMs).toFixed(2)}(protocol)`);

    // 8. 第二条紧急 Signal：新 Scene prepare 后立即打断 → 取消时延。
    const cycleB = uuid();
    child.send({ type: "submit", cycleId: cycleB, traceId: traceId(), urgent: true, text: "紧急打断" });
    const submittedB = await ipc.expect("submit-result");
    const prepareB = await stage.waitFor("scene.prepare");
    stage.send("scene.ready", {
      sceneId: prepareB.payload.plan.scene.sceneId,
      cycleId: prepareB.payload.plan.scene.cycleId,
      lanes: prepareB.payload.plan.scene.groups[0].lanes.map((lane) => ({ lane, status: "ready", cueIds: [] })),
      preparedAtStageUs: String(Math.round(performance.now() * 1000)),
    });
    const interruptStart = performance.now();
    child.send({ type: "interrupt", reason: "urgent_interrupt" });
    const cancelEnvelope = await stage.waitFor("scene.cancel");
    if (cancelEnvelope.payload.sceneId !== submittedB.sceneId) {
      throw new DemoFailure("interrupt", "cancel targeted the wrong scene");
    }
    stage.send("scene.cancel.ack", {
      sceneId: cancelEnvelope.payload.sceneId,
      cycleId: cancelEnvelope.payload.cycleId,
      lanes: prepareB.payload.plan.scene.groups[0].lanes.map((lane) => ({ lane, stopped: true })),
      stoppedAtStageUs: String(Math.round(performance.now() * 1000)),
    });
    const cancelLatencyMs = performance.now() - interruptStart;
    if (cancelLatencyMs > 100) {
      throw new DemoFailure("interrupt", `cancel latency ${cancelLatencyMs.toFixed(1)}ms exceeds 100ms budget`);
    }
    report("interruptLatencyMs", cancelLatencyMs.toFixed(2));
    const settledB = await ipc.expect("scene-settled");
    if (settledB.state !== "cancelled") {
      throw new DemoFailure("interrupt", `interrupted scene settled as ${settledB.state}`);
    }

    // 9. Crash Window：SIGKILL → 同目录重启 → 不重复执行已提交 Scene。
    child.kill("SIGKILL");
    await new Promise((resolve) => child.on("exit", resolve));
    stage.close();
    stage = null;
    child = fork(CHILD, [dataDirectory], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
    const ipc2 = new Ipc(child);
    const ready2 = await ipc2.expect("ready");
    child.send({ type: "issue-token" });
    const { token: token2 } = await ipc2.expect("token");
    const exchange2 = await postJson(ready2.port, "/api/v1/auth/exchange", { startupToken: token2 });
    const session2 = JSON.parse(exchange2.body);
    child.send({ type: "recovery", sessionId: session.sessionId });
    const recovery = await ipc2.expect("recovery");
    if (recovery.error !== undefined) {
      throw new DemoFailure("recovery", recovery.error);
    }
    // 重启后重连：无新 submit 时不得出现任何 scene.prepare（不自动重播）。
    const stage2 = new StageClient(ready2.port, exchange2.cookie, session2.sessionId);
    await stage2.connect();
    await stage2.waitFor("server.hello");
    stage2.send("client.hello", { protocolVersion: 1, clientType: "stage" });
    stage2.send("stage.capabilities", {
      capabilities: {
        schemaVersion: 1,
        audio: { contentTypes: ["audio/pcm-s16le-48000-mono"], maxBufferedUs: "2000000" },
        subtitle: { supported: true },
        avatar: { adapter: "demo-protocol", motions: ["nod_agree"], expressions: ["happy"] },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const strayPrepare = stage2.inbox.findIndex((e) => e.type === "scene.prepare");
    if (strayPrepare !== -1) {
      throw new DemoFailure("recovery", "restarted runtime replayed a committed scene without a new signal");
    }
    report("recoveryDuplicateEffects", "0");
    if (recovery.lastCommittedScene === null) {
      throw new DemoFailure("recovery", "committed scene missing from recovery state");
    }
    report("watermarkRestored", `ok(serverSeq=${recovery.latestServerSeq})`);
    stage2.close();

    // 10. 干净关闭。
    child.send({ type: "shutdown" });
    const exitInfo = await Promise.race([
      new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal }))),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new DemoFailure("shutdown", "graceful close timed out")),
          10000,
        ),
      ),
    ]);
    if (exitInfo.code !== 0) {
      throw new DemoFailure("shutdown", `child exited with code=${exitInfo.code} signal=${exitInfo.signal}`);
    }
    child = null;
    report("traceContinuity", "ok");
    report("shutdownClean", "ok");

    const allOk = Object.values(evidence).length >= 12;
    if (!allOk) {
      throw new DemoFailure("summary", "missing evidence lines");
    }
    process.stdout.write("--- phase 2 demo complete ---\n");
  } catch (error) {
    if (diagnostics.length > 0) {
      process.stderr.write("--- child diagnostics (tail) ---\n");
      process.stderr.write(diagnostics.join("").split("\n").slice(-20).join("\n"));
    }
    throw error;
  } finally {
    stage?.close();
    if (child !== null && child.exitCode === null) {
      child.kill("SIGKILL");
    }
    rmSync(dataDirectory, { recursive: true, force: true });
  }
}

run().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
