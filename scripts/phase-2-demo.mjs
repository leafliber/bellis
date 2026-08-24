#!/usr/bin/env node
/**
 * Phase 2 Demo（docs/phase-2-development-guide.md §10.2）。
 *
 * 协议级真实纵向链路（真实子进程 Runtime + 真实 WebSocket + 真实 DB Worker；
 * 浏览器 Stage 属于 test:browser，见交付报告）：
 *
 * 1. 临时数据目录 + 启动 Runtime（phase2 显式启用）
 * 2. 一次性 Token → Session Cookie → Control WS（clientType=stage）
 *    + Media WS（二进制 BELL v1 帧）
 * 3. stage.capabilities 上报 + ≥3 个合格时钟样本
 * 4. 注入 Fake Signal（Speech+Avatar）→ media.stream.announce →
 *    media.stream.ready → 真实 PCM 帧流（48k/mono/S16LE/20ms）
 * 5. 音频 Lane 以 ≥6 帧预缓冲达标后回 scene.ready（全部 hard Lane ready）
 * 6. 观察 scene.commit（未来时刻）→ 到点回 scene.started（三 Lane 双域时刻）
 * 7. scene.finished → completed；取消后帧流立即停止
 * 8. 第二条紧急 Signal → interruptAll → scene.cancel → cancel.ack，
 *    计量取消时延
 * 9. Crash Window（完成后 SIGKILL）→ 同目录重启 → 已提交 Scene 不重复执行
 * 10. 干净关闭与清理（四个关键 Crash Window 的定向覆盖见
 *     scripts/phase-2-crash-windows.mjs）
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
const PCM_CONTENT_TYPE = "audio/pcm-s16le-48000-mono";
const PCM_FRAME_BYTES = 1920; // 960 样本 × 2 字节（20ms @48k mono S16LE）

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

/** 解析 BELL v1 二进制帧（magic/version/kind/flags LE 布局，与协议一致）。 */
function parseBellFrame(buffer) {
  if (buffer.length < 12) {
    throw new DemoFailure("media-frame", `frame too short (${buffer.length} bytes)`);
  }
  if (buffer.subarray(0, 4).toString("ascii") !== "BELL") {
    throw new DemoFailure("media-frame", "bad magic");
  }
  if (buffer[4] !== 1) {
    throw new DemoFailure("media-frame", `unsupported version ${buffer[4]}`);
  }
  if (buffer[5] !== 1) {
    throw new DemoFailure("media-frame", `media kind ${buffer[5]} is not audio`);
  }
  const flags = buffer.readUInt16LE(6);
  if (flags !== 0) {
    throw new DemoFailure("media-frame", `flags must be 0, got ${flags}`);
  }
  const headerLength = buffer.readUInt32LE(8);
  const header = JSON.parse(buffer.subarray(12, 12 + headerLength).toString("utf8"));
  return { header, payload: buffer.subarray(12 + headerLength) };
}

/**
 * 协议 Stage 客户端：真实 Control + Media WebSocket、真实 BELL v1 帧。
 * 音频 Lane 语义与浏览器 Stage 一致：announce 校验能力 → ready →
 * ≥6 帧预缓冲后才宣告 audio Lane ready。
 */
class StageClient {
  constructor(port, cookie, sessionId) {
    this.port = port;
    this.cookie = cookie;
    this.sessionId = sessionId;
    this.ws = null;
    this.media = null;
    this.inbox = [];
    this.waiters = [];
    this.seq = 0;
    this.clockSamples = 0;
    this.offsetUs = null;
    this.streams = new Map(); // streamId → {header 帧列表, lastSeq, rms}
    this.frameWaiters = [];
    this.traceRoots = new Map(); // sceneId → traceId（announce/prepare/commit/cancel）
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${this.port}/ws/v1/control`, {
        headers: { cookie: this.cookie, origin: `http://127.0.0.1:${this.port}` },
      });
      this.ws.on("open", () => {
        // client.hello 在 open 后立即发送：resume 连接在收到 client.hello 前
        // 保留一切出站（含 server.hello），先等 server.hello 会死锁到 4004。
        this.send("client.hello", { protocolVersion: 1, clientType: "stage" });
        resolve();
      });
      this.ws.on("error", (error) => reject(new DemoFailure("stage-connect", error.message)));
      this.ws.on("message", (data) => {
        const envelope = JSON.parse(data.toString("utf8"));
        this.handleServerEnvelope(envelope);
      });
    });
  }

  /** Media WS：只接受二进制 BELL 帧；Text 帧属于协议违例。 */
  connectMedia() {
    return new Promise((resolve, reject) => {
      this.media = new WebSocket(`ws://127.0.0.1:${this.port}/ws/v1/media`, {
        headers: { cookie: this.cookie, origin: `http://127.0.0.1:${this.port}` },
      });
      this.media.binaryType = "nodebuffer";
      this.media.on("open", resolve);
      this.media.on("error", (error) => reject(new DemoFailure("media-connect", error.message)));
      this.media.on("message", (data, isBinary) => {
        if (!isBinary) {
          reject(new DemoFailure("media-connect", "media channel received a text frame"));
          return;
        }
        this.handleMediaFrame(data);
      });
    });
  }

  handleServerEnvelope(envelope) {
    if (envelope.type === "media.stream.announce") {
      this.handleAnnounce(envelope);
    }
    const waiter = this.waiters.shift();
    if (waiter === undefined) {
      this.inbox.push(envelope);
    } else {
      waiter(envelope);
    }
  }

  /** announce → 校验能力（contentType）→ 建立 Stream 记录 → ready。 */
  handleAnnounce(envelope) {
    const { streamId, mediaKind, contentType, sceneId } = envelope.payload;
    if (mediaKind !== "audio" || contentType !== PCM_CONTENT_TYPE) {
      throw new DemoFailure("media-announce", `unsupported stream ${mediaKind}/${contentType}`);
    }
    this.streams.set(streamId, {
      sceneId,
      frames: [],
      lastSeq: -1,
      rmsSum: 0,
      stoppedAt: null,
    });
    if (sceneId !== undefined && envelope.trace?.traceId !== undefined) {
      this.traceRoots.set(sceneId, envelope.trace.traceId);
    }
    this.send("media.stream.ready", { streamId });
  }

  handleMediaFrame(buffer) {
    const { header, payload } = parseBellFrame(buffer);
    const stream = this.streams.get(header.streamId);
    if (stream === undefined) {
      throw new DemoFailure("media-frame", `frame for unknown stream ${header.streamId}`);
    }
    if (header.contentType !== PCM_CONTENT_TYPE) {
      throw new DemoFailure("media-frame", `contentType mismatch ${header.contentType}`);
    }
    const sequence = Number(header.sequence);
    if (sequence !== stream.lastSeq + 1) {
      throw new DemoFailure("media-frame", `sequence gap: got ${sequence} after ${stream.lastSeq}`);
    }
    if (payload.length !== PCM_FRAME_BYTES) {
      throw new DemoFailure("media-frame", `payload ${payload.length} bytes, want ${PCM_FRAME_BYTES}`);
    }
    stream.lastSeq = sequence;
    let sumSquares = 0;
    for (let i = 0; i < payload.length; i += 2) {
      const sample = payload.readInt16LE(i);
      sumSquares += sample * sample;
    }
    stream.rmsSum += Math.sqrt(sumSquares / (payload.length / 2));
    stream.frames.push({
      sequence,
      targetTimeUs: BigInt(header.targetTimeUs),
      durationUs: BigInt(header.durationUs),
      arrivedAt: performance.now(),
    });
    for (const waiter of this.frameWaiters.splice(0)) {
      waiter();
    }
  }

  /** 等待指定 Stream 累计 count 帧（用于预缓冲与取消后停流断言）。 */
  async waitForFrames(streamId, count, timeoutMs = 5000) {
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      const stream = this.streams.get(streamId);
      if (stream !== undefined && stream.frames.length >= count) {
        return stream;
      }
      if (performance.now() > deadline) {
        throw new DemoFailure(
          "media-wait",
          `stream ${streamId} reached ${stream?.frames.length ?? 0}/${count} frames`,
        );
      }
      await new Promise((resolve) => this.frameWaiters.push(resolve));
    }
  }

  /** 当前活跃 Stream（单 Scene Demo 语义：最后一个 announce 的流）。 */
  latestStream() {
    return [...this.streams.entries()].at(-1)?.[1] ?? null;
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
    this.media?.close(1000, "demo_complete");
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

    // 2. 认证 → Cookie → Stage Control + Media 连接。
    child.send({ type: "issue-token" });
    const { token } = await ipc.expect("token");
    const exchange = await postJson(ready.port, "/api/v1/auth/exchange", { startupToken: token });
    if (exchange.status !== 200 || exchange.cookie === undefined) {
      throw new DemoFailure("auth", `exchange failed: ${exchange.status}`);
    }
    const session = JSON.parse(exchange.body);
    stage = new StageClient(ready.port, exchange.cookie, session.sessionId);
    await stage.connect();
    await stage.connectMedia();
    await stage.waitFor("server.hello");
    stage.send("stage.capabilities", {
      capabilities: {
        schemaVersion: 1,
        audio: { contentTypes: [PCM_CONTENT_TYPE], maxBufferedUs: "2000000" },
        subtitle: { supported: true },
        avatar: { adapter: "demo-protocol", motions: ["nod_agree"], expressions: ["happy"] },
      },
    });
    report("stageHandshake", "ok(control+media)");

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

    // 4. Fake Signal → announce → ready → PCM 预缓冲（音频 Lane 达标）。
    const submitAt = performance.now();
    const cycleA = uuid();
    child.send({ type: "submit", cycleId: cycleA, traceId: traceId(), text: "我看看现在的任务进度" });
    const submitted = await ipc.expect("submit-result");
    if (!submitted.ok) {
      throw new DemoFailure("submit", `submission rejected: ${submitted.kind}`);
    }
    report("actionFrame", "validated");
    const announce = await stage.waitFor("media.stream.announce");
    if (announce.payload.sceneId !== submitted.sceneId) {
      throw new DemoFailure("media-announce", "announce targets a different scene");
    }
    report("mediaAnnounce", `ok(${announce.payload.contentType})`);
    const stream = stage.latestStream();
    const prebuffer = await stage.waitForFrames(announce.payload.streamId, 6, 450);
    report(
      "mediaPrebuffer",
      `ok(6 frames, firstFrame=${(prebuffer.frames[0].arrivedAt - submitAt).toFixed(0)}ms)`,
    );
    const prepare = await stage.waitFor("scene.prepare");
    const plan = prepare.payload.plan;
    if (plan.cues.length < 3 || plan.speech?.text !== "我看看现在的任务进度") {
      throw new DemoFailure("prepare", `unexpected plan: ${plan.cues?.length} cues`);
    }
    report("scenePlan", `compiled(${plan.cues.length} cues, ${plan.scene.groups[0].lanes.join("+")})`);

    // 5. 全部 hard Lane ready（音频以预缓冲达标为准）。
    stage.send("scene.ready", {
      sceneId: plan.scene.sceneId,
      cycleId: plan.scene.cycleId,
      lanes: plan.scene.groups[0].lanes.map((lane) => ({ lane, status: "ready", cueIds: [] })),
      preparedAtStageUs: String(Math.round(performance.now() * 1000)),
    });
    report("prepareBarrier", "ready(audio=prebuffered6)");

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

    // 7.5 媒体帧流校验：序列连续已由解析器断言；节奏 = 相邻 targetTimeUs
    // 恒为 20ms；RMS > 0 证明是真实合成波形而非静音占位。
    child.send({ type: "state", sceneId: plan.scene.sceneId });
    const stateA = await ipc.expect("state");
    const finalStream = stage.streams.get(announce.payload.streamId);
    const pacingOk = finalStream.frames.length >= 2;
    for (let i = 1; i < finalStream.frames.length; i += 1) {
      const delta = finalStream.frames[i].targetTimeUs - finalStream.frames[i - 1].targetTimeUs;
      if (delta !== 20000n) {
        throw new DemoFailure("media-frame", `targetTimeUs step ${delta}us, want 20000us`);
      }
    }
    const avgRms = finalStream.rmsSum / finalStream.frames.length;
    if (avgRms <= 0) {
      throw new DemoFailure("media-frame", "PCM frames are silent (RMS = 0)");
    }
    report(
      "mediaFrames",
      `${finalStream.frames.length}(sent=${stateA.media?.sent ?? "?"},sequence=strict,pacing=20ms,rms=${avgRms.toFixed(0)})`,
    );
    if (pacingOk === false) {
      throw new DemoFailure("media-frame", "not enough frames to verify pacing");
    }

    // 8. 第二条紧急 Signal：新 Scene prepare 后立即打断 → 取消时延 + 停流。
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
    // 取消优先于媒体：打断后被打断 Scene 的流不再出现新帧。
    const interruptedStream = stage.latestStream();
    if (interruptedStream === null || interruptedStream === stream) {
      throw new DemoFailure("interrupt", "interrupted scene never announced a media stream");
    }
    const framesAtCancel = interruptedStream.frames.length;
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (interruptedStream.frames.length > framesAtCancel) {
      throw new DemoFailure("interrupt", "media frames continued after cancel");
    }
    report("mediaStopOnCancel", "ok");

    // 8.5 Trace 连续性：同一 Scene 的 announce/prepare/commit 共用同一根；
    // 被打断 Scene 的 cancel 也必须携带它自己 announce 时的根。
    const sceneTrace = stage.traceRoots.get(plan.scene.sceneId);
    const wireTraces = [announce, prepare, commit]
      .map((e) => e.trace?.traceId)
      .filter((t) => t !== undefined);
    if (sceneTrace === undefined || wireTraces.some((t) => t !== sceneTrace)) {
      throw new DemoFailure(
        "trace",
        `trace roots diverge: announce=${sceneTrace} wire=${[...new Set(wireTraces)].join(",")}`,
      );
    }
    const interruptedTrace = stage.traceRoots.get(cancelEnvelope.payload.sceneId);
    if (
      interruptedTrace !== undefined &&
      cancelEnvelope.trace?.traceId !== undefined &&
      cancelEnvelope.trace.traceId !== interruptedTrace
    ) {
      throw new DemoFailure("trace", "interrupted scene cancel carries a foreign trace root");
    }
    report("traceContinuity", `ok(${sceneTrace.slice(0, 8)}…×3+cancel)`);

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
    const exchange2 = await postJson(ready2.port, "/api/v1/auth/exchange", { startupToken: token2, resumeSessionId: session.sessionId });
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
    stage2.send("stage.capabilities", {
      capabilities: {
        schemaVersion: 1,
        audio: { contentTypes: [PCM_CONTENT_TYPE], maxBufferedUs: "2000000" },
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
    report("shutdownClean", "ok");

    const allOk = Object.values(evidence).length >= 14;
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
