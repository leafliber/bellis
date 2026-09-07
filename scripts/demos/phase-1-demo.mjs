#!/usr/bin/env node
/**
 * Phase 1 Demo（docs/reference/phase-1.md）。
 *
 * 流程：临时数据目录 → 启动 Runtime（子进程）→ 一次性 Token 交换 →
 * Control Hello + Clock Sync → 注册 binary-test Media Stream 并发送合法
 * 随机字节帧 → Fake Scene Commit（Speech/Avatar Cue + Watermark + Outbox）
 * → 仅在数据库 Commit 后观察 scene.committed → 在
 * `after_scene_transaction_commit_before_outbox_dispatch` 检查点 SIGKILL →
 * 同一数据目录重启 → Scene/Watermark/Server Seq 恢复、Outbox 重新交付、
 * 相同幂等键重放无第二个逻辑结果 → 同一 TraceId 事件摘要 → 清理。
 *
 * 任一步失败非零退出；不访问公网；成功/失败都清理临时资源。
 * 依赖已构建产物：先运行 `pnpm build`。
 */
import { fork } from "node:child_process";
import { request as httpRequest } from "node:http";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const CHILD = join(SCRIPT_DIR, "phase-1-demo-child.mjs");
const RUNTIME_DIST = join(SCRIPT_DIR, "../..", "apps", "runtime", "dist", "index.js");

const DEMO = {
  sceneId: randomUUID(),
  cycleId: randomUUID(),
  idempotencyKey: "phase1-demo-commit-1",
  watermark: "314159265358979323846",
  watermarkSource: "demo.asr",
  cueSpeech: randomUUID(),
  cueAvatar: randomUUID(),
};

class DemoFailure extends Error {
  constructor(stage, message) {
    super(`[${stage}] ${message}`);
    this.stage = stage;
  }
}

/** 子进程 harness 客户端：IPC 收发 + 生命周期 + 缓冲诊断输出。 */
class Harness {
  constructor(child) {
    this.child = child;
    this.pending = [];
    this.waiters = [];
    this.exitInfo = null;
    this.exitWaiters = [];
    this.diagnostics = "";
    for (const stream of [child.stdout, child.stderr]) {
      if (stream !== null) {
        stream.on("data", (chunk) => {
          // 只保留尾部 32 KiB，失败时输出（已脱敏的结构化日志）。
          this.diagnostics = (this.diagnostics + chunk.toString("utf8")).slice(-32 * 1024);
        });
      }
    }
    child.on("message", (message) => {
      const waiter = this.waiters.shift();
      if (waiter === undefined) {
        this.pending.push(message);
      } else {
        waiter(message);
      }
    });
    child.on("exit", (code, signal) => {
      this.exitInfo = { code, signal };
      for (const waiter of this.exitWaiters.splice(0)) {
        waiter(this.exitInfo);
      }
      for (const waiter of this.waiters.splice(0)) {
        waiter({ type: "__exit__", ...this.exitInfo });
      }
    });
  }

  static spawn(dataDirectory, mode) {
    const child = fork(CHILD, [dataDirectory, mode], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    return new Harness(child);
  }

  next(timeoutMs, stage) {
    const buffered = this.pending.shift();
    if (buffered !== undefined) {
      return Promise.resolve(buffered);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) {
          this.waiters.splice(index, 1);
        }
        reject(new DemoFailure(stage, `timed out after ${timeoutMs}ms waiting for harness message`));
      }, timeoutMs);
      const waiter = (message) => {
        clearTimeout(timer);
        if (message.type === "__exit__") {
          reject(new DemoFailure(stage, `harness exited unexpectedly (code=${message.code}, signal=${message.signal})`));
          return;
        }
        resolve(message);
      };
      this.waiters.push(waiter);
    });
  }

  send(message) {
    this.child.send(message);
  }

  expect(type, stage, timeoutMs = 15_000) {
    return this.next(timeoutMs, stage).then((message) => {
      if (message.type === "harness-error" || message.type === "commit-error" || message.type === "recovery-error") {
        throw new DemoFailure(stage, message.message ?? "harness error");
      }
      if (message.type !== type) {
        throw new DemoFailure(stage, `expected ${type}, got ${JSON.stringify(message).slice(0, 300)}`);
      }
      return message;
    });
  }

  async kill(stage) {
    if (this.exitInfo !== null) {
      return;
    }
    const dead = new Promise((resolve) => {
      if (this.exitInfo !== null) {
        resolve(this.exitInfo);
        return;
      }
      this.exitWaiters.push(resolve);
    });
    this.child.kill("SIGKILL");
    let timer = null;
    try {
      const info = await Promise.race([
        dead,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new DemoFailure(stage, "child did not exit after SIGKILL")),
            10_000,
          );
        }),
      ]);
      void info;
    } finally {
      // 竞争失败的超时定时器必须清理，否则父进程被空定时器拖住延迟退出。
      if (timer !== null) {
        clearTimeout(timer);
      }
    }
  }

  async closeGracefully(stage) {
    if (this.exitInfo !== null) {
      return;
    }
    this.send({ type: "close" });
    const closed = new Promise((resolve) => {
      if (this.exitInfo !== null) {
        resolve(this.exitInfo);
        return;
      }
      this.exitWaiters.push(resolve);
    });
    let timer = null;
    let info;
    try {
      info = await Promise.race([
        closed,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new DemoFailure(stage, "graceful close timed out")),
            30_000,
          );
        }),
      ]);
    } finally {
      if (timer !== null) {
        clearTimeout(timer);
      }
    }
    if (info.code !== 0) {
      throw new DemoFailure(stage, `graceful close exited with code=${info.code}`);
    }
  }
}

/** 极简 Control 测试客户端（父进程侧）。 */
class ControlClient {
  constructor(url, cookie, origin) {
    this.socket = new WebSocket(url, { headers: { cookie, origin } });
    this.received = [];
    this.waiters = [];
    this.socket.on("message", (data, isBinary) => {
      if (isBinary) {
        return;
      }
      const envelope = JSON.parse(data.toString("utf8"));
      this.received.push(envelope);
      for (let index = this.waiters.length - 1; index >= 0; index -= 1) {
        const waiter = this.waiters[index];
        if (waiter.predicate(envelope)) {
          this.waiters.splice(index, 1);
          clearTimeout(waiter.timer);
          waiter.resolve(envelope);
        }
      }
    });
  }

  opened(stage) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new DemoFailure(stage, "websocket open timed out")), 10_000);
      this.socket.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      this.socket.once("error", (error) => {
        clearTimeout(timer);
        reject(new DemoFailure(stage, `websocket error: ${error.message}`));
      });
    });
  }

  waitFor(predicate, stage, timeoutMs = 10_000) {
    const existing = this.received.find(predicate);
    if (existing !== undefined) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((waiter) => waiter.resolve === resolve);
        if (index >= 0) {
          this.waiters.splice(index, 1);
        }
        reject(new DemoFailure(stage, "timed out waiting for control message"));
      }, timeoutMs);
      this.waiters.push({ predicate, resolve, timer });
    });
  }

  waitForType(type, stage) {
    return this.waitFor((envelope) => envelope.type === type, stage);
  }

  send(envelope) {
    this.socket.send(JSON.stringify(envelope));
  }

  close() {
    this.socket.close(1000, "demo done");
  }
}

function clientEnvelope(sessionId, type, payload, extra = {}) {
  return {
    version: 1,
    direction: "client",
    type,
    messageId: randomUUID(),
    sessionId,
    trace: { traceId: randomUUID().replaceAll("-", "") },
    sentAtUs: String(BigInt(Date.now()) * 1000n),
    ...extra,
    payload,
  };
}

/** binary-test 媒体帧（随机测试字节）。 */
function buildDemoMediaFrame(sessionId, streamId, frameId, sequence, traceId) {
  const header = {
    schemaVersion: 1,
    streamId,
    frameId,
    sessionId,
    sequence: String(sequence),
    contentType: "application/octet-stream",
    traceId,
  };
  const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
  const payload = crypto.getRandomValues(new Uint8Array(1024));
  const prefix = Buffer.alloc(12);
  prefix.write("BELL", 0, "latin1");
  prefix.writeUInt8(1, 4);
  prefix.writeUInt8(3, 5); // binary-test
  prefix.writeUInt16LE(0, 6);
  prefix.writeUInt32LE(headerBytes.length, 8);
  return Buffer.concat([prefix, headerBytes, Buffer.from(payload)]);
}

/**
 * 一次性 Token 交换（node:http + connection: close，避免全局 fetch 的
 * undici keep-alive Socket 在退出卫生断言时残留）。
 */
function exchange(port, token, stage) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ startupToken: token });
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: "/api/v1/auth/exchange",
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: `http://127.0.0.1:${port}`,
          "content-length": Buffer.byteLength(body),
          connection: "close",
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          if (response.statusCode !== 200) {
            reject(new DemoFailure(stage, `auth exchange failed with status ${response.statusCode}`));
            return;
          }
          const setCookie = response.headers["set-cookie"]?.[0] ?? "";
          const cookie = /^([^=]+=[^;]+)/.exec(setCookie)?.[1];
          if (cookie === undefined) {
            reject(new DemoFailure(stage, "auth exchange returned no session cookie"));
            return;
          }
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            resolve({ sessionId: parsed.sessionId, cookie });
          } catch (error) {
            reject(new DemoFailure(stage, `auth exchange body invalid: ${error.message}`));
          }
        });
      },
    );
    request.on("error", (error) => {
      reject(new DemoFailure(stage, `auth exchange failed: ${error.message}`));
    });
    request.end(body);
  });
}

async function pollDeliveries(harness, stage) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    harness.send({ type: "deliveries" });
    const reply = await harness.expect("deliveries", stage);
    if (reply.records.length > 0) {
      return reply.records;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new DemoFailure(stage, "no outbox deliveries observed after restart");
}

let dataDirectory = null;
const instance1Ref = { value: null };
const instance2Ref = { value: null };

function cleanup() {
  if (dataDirectory !== null) {
    rmSync(dataDirectory, { recursive: true, force: true });
    dataDirectory = null;
  }
}

/**
 * 断言父进程没有残留的子进程/TCP Socket/定时器句柄（stdio 除外）。
 * 打印全部成功摘要后 Demo 必须及时以 0 退出，不允许被空定时器拖住。
 */
async function assertExitHygiene() {
  await new Promise((resolve) => setTimeout(resolve, 200));
  const active = process._getActiveHandles?.() ?? [];
  const leftover = active.filter((handle) => {
    if (handle === process.stdin || handle === process.stdout || handle === process.stderr) {
      return false;
    }
    const name = handle?.constructor?.name ?? "";
    if (name === "Socket" && typeof handle.remoteAddress !== "string") {
      // 无对端地址的是 stdio 管道，不是网络 Socket。
      return false;
    }
    return name === "ChildProcess" || name === "Socket" || name === "Timeout";
  });
  if (leftover.length > 0) {
    const names = leftover.map((handle) => handle.constructor?.name).join(", ");
    throw new DemoFailure("exit-hygiene", `active handles remain: ${names}`);
  }
}

async function main() {
  if (!existsSync(RUNTIME_DIST)) {
    throw new DemoFailure("preflight", "runtime dist 未构建——请先运行 pnpm build");
  }

  // 1. 系统临时数据目录。
  dataDirectory = mkdtempSync(join(tmpdir(), "bellis-phase1-demo-"));
  const traceEvents = [];
  instance1Ref.value = null;
  instance2Ref.value = null;
  let instance1 = null;
  let instance2 = null;

  try {
    // 2. 启动 Runtime 子进程（armed 装配：可注入检查点）并等待 ready。
    instance1 = Harness.spawn(dataDirectory, "armed");
    instance1Ref.value = instance1;
    const ready1 = await instance1.expect("ready", "startup");
    const port1 = ready1.port;
    const instanceId1 = ready1.instanceId;

    // 3. 一次性 Token 交换 → Session Cookie。
    instance1.send({ type: "issue-token" });
    const tokenReply = await instance1.expect("token", "auth");
    const { sessionId, cookie } = await exchange(port1, tokenReply.token, "auth");

    // 4. Control WS：Hello + 一次 Clock Sync。
    const origin = `http://127.0.0.1:${port1}`;
    const control = new ControlClient(`ws://127.0.0.1:${port1}/ws/v1/control`, cookie, origin);
    await control.opened("control");
    const serverHello = await control.waitForType("server.hello", "control-hello");
    if (serverHello.payload.protocolVersion !== 1) {
      throw new DemoFailure("control-hello", `unexpected protocolVersion ${serverHello.payload.protocolVersion}`);
    }
    control.send(clientEnvelope(sessionId, "client.hello", { protocolVersion: 1, clientType: "test-client" }));
    await control.waitForType("server.ready", "control-hello");
    const c0 = BigInt(Date.now()) * 1000n;
    control.send(clientEnvelope(sessionId, "clock.ping", { c0: c0.toString() }));
    const clockPong = await control.waitForType("clock.pong", "clock-sync");
    if (clockPong.payload.c0 !== c0.toString() || BigInt(clockPong.payload.r2) < BigInt(clockPong.payload.r1)) {
      throw new DemoFailure("clock-sync", `invalid clock.pong ${JSON.stringify(clockPong.payload)}`);
    }

    // 5. 注册 binary-test Media Stream，发送一个合法随机字节帧并确认接收。
    const streamId = randomUUID();
    control.send(
      clientEnvelope(sessionId, "media.stream.open", {
        streamId,
        mediaKind: "binary-test",
        contentType: "application/octet-stream",
      }, { idempotencyKey: `demo-open-${streamId}` }),
    );
    const media = new WebSocket(`ws://127.0.0.1:${port1}/ws/v1/media`, { headers: { cookie, origin } });
    await new Promise((resolve, reject) => {
      media.once("open", resolve);
      media.once("error", (error) => reject(new DemoFailure("media", error.message)));
    });
    media.send(buildDemoMediaFrame(sessionId, streamId, randomUUID(), 0, randomUUID().replaceAll("-", "")));
    let accepted = 0;
    for (let attempt = 0; attempt < 50 && accepted === 0; attempt += 1) {
      instance1.send({ type: "media-stats", sessionId });
      const statsReply = await instance1.expect("media-stats", "media");
      accepted = statsReply.stats?.accepted ?? 0;
      if (accepted === 0) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    if (accepted !== 1) {
      throw new DemoFailure("media", `expected 1 accepted frame, got accepted=${accepted}`);
    }

    // 6-7. Fake Scene Commit（Speech/Avatar Cue + Watermark + Outbox）；
    //      仅在数据库 Commit 后观察 scene.committed。
    //      先武装检查点 2（评审修复 8）：Dispatcher 在 Claim 前冻结，
    //      目标 Outbox 在实例 1 内绝无发布机会。
    instance1.send({ type: "arm", checkpoint: "after_scene_transaction_commit_before_outbox_dispatch" });
    const commitInput = {
      sessionId,
      sceneId: DEMO.sceneId,
      cycleId: DEMO.cycleId,
      idempotencyKey: DEMO.idempotencyKey,
      cues: [
        { cueId: DEMO.cueSpeech, lane: "subtitle" },
        { cueId: DEMO.cueAvatar, lane: "avatar" },
      ],
      watermarks: [{ source: DEMO.watermarkSource, watermark: DEMO.watermark }],
    };
    instance1.send({ type: "commit", input: commitInput });
    // arm 先于提交：Dispatcher 冻结检查点与提交完成两条消息的先后不定，
    // 顺序无关地收集两者。
    let committedReply = null;
    let checkpointMsg = null;
    while (committedReply === null || checkpointMsg === null) {
      const message = await instance1.next(15_000, "scene-commit");
      if (message.type === "committed") {
        committedReply = message;
      } else if (message.type === "checkpoint") {
        checkpointMsg = message;
      } else if (
        message.type === "harness-error" ||
        message.type === "commit-error" ||
        message.type === "recovery-error"
      ) {
        throw new DemoFailure("scene-commit", message.message ?? "harness error");
      }
    }
    if (committedReply.duplicate) {
      throw new DemoFailure("scene-commit", "first commit reported duplicate");
    }
    const prepared = await control.waitForType("scene.prepared", "scene-commit");
    const committedEvent = await control.waitForType("scene.committed", "scene-commit");
    traceEvents.push(
      { event: "scene.prepared(on-wire)", traceId: prepared.trace.traceId },
      { event: "scene.committed(on-wire)", traceId: committedEvent.trace.traceId },
      { event: "commitScene(result)", traceId: committedReply.traceId },
    );
    // committed 已上线 ⇒ 数据库事实必须已存在（先 Commit 后发布）。
    instance1.send({ type: "recovery", sessionId });
    const durable = await instance1.expect("recovery", "scene-commit");
    if (durable.lastCommittedScene?.sceneId !== DEMO.sceneId) {
      throw new DemoFailure("scene-commit", "scene.committed observed before durable DB fact");
    }

    // 8. 检查点 after_scene_transaction_commit_before_outbox_dispatch 强制终止
    //    （检查点消息已在上方收到，这里只验证其身份）。
    if (
      checkpointMsg.checkpoint !== "after_scene_transaction_commit_before_outbox_dispatch"
    ) {
      throw new DemoFailure("crash", `unexpected checkpoint ${checkpointMsg.checkpoint}`);
    }
    const checkpoint = checkpointMsg;
    // 目标状态严格对应：实例 1 零交付（目标 Outbox 尚未被 Claim/发布）。
    instance1.send({ type: "deliveries" });
    const beforeKill = await instance1.expect("deliveries", "crash");
    if (beforeKill.records.length !== 0) {
      throw new DemoFailure("crash", `expected 0 deliveries before kill, got ${beforeKill.records.length}`);
    }
    await instance1.kill("crash");
    control.close();
    media.close(1000, "demo crash");

    // 9. 同一数据目录启动新 Runtime Instance（生产装配）。
    instance2 = Harness.spawn(dataDirectory, "production");
    instance2Ref.value = instance2;
    const ready2 = await instance2.expect("ready", "restart");
    const port2 = ready2.port;
    const instanceId2 = ready2.instanceId;
    if (instanceId2 === instanceId1) {
      throw new DemoFailure("restart", "new instance reused the old runtime instance id");
    }

    // 10. Scene/Watermark/Server Seq 恢复；Outbox 重新交付。
    instance2.send({ type: "recovery", sessionId });
    const recovery = await instance2.expect("recovery", "recovery");
    if (recovery.lastCommittedScene?.sceneId !== DEMO.sceneId) {
      throw new DemoFailure("recovery", `scene not restored: ${JSON.stringify(recovery.lastCommittedScene)}`);
    }
    if (recovery.latestServerSeq === "0") {
      throw new DemoFailure("recovery", "server seq watermark not restored");
    }
    const watermark = recovery.watermarks.find((entry) => entry.source === DEMO.watermarkSource);
    if (watermark?.watermark !== DEMO.watermark) {
      throw new DemoFailure("recovery", `watermark not restored: ${JSON.stringify(recovery.watermarks)}`);
    }
    const deliveries = await pollDeliveries(instance2, "outbox-recovery");
    const delivery = deliveries[0];
    if (delivery.topic !== "scene.committed") {
      throw new DemoFailure("outbox-recovery", `unexpected topic ${delivery.topic}`);
    }
    traceEvents.push({ event: "outbox.delivered(recovered)", traceId: delivery.traceId });

    // 11. 相同幂等键重放：无第二个逻辑结果。
    instance2.send({ type: "commit", input: commitInput });
    const replay = await instance2.expect("committed", "idempotency");
    if (replay.duplicate !== true) {
      throw new DemoFailure("idempotency", "replayed commit was not a duplicate");
    }
    instance2.send({ type: "deliveries" });
    const afterReplay = await instance2.expect("deliveries", "idempotency");
    if (afterReplay.records.length !== 1) {
      throw new DemoFailure("idempotency", `expected exactly 1 logical delivery, got ${afterReplay.records.length}`);
    }

    // 12. 同一 Trace ID 的关键事件摘要 + trace 连续性断言。
    const traceIds = new Set(traceEvents.map((event) => event.traceId));
    if (traceIds.size !== 1 || !traceIds.has(committedReply.traceId)) {
      throw new DemoFailure("trace-continuity", `expected a single trace id, got ${[...traceIds].join(", ")}`);
    }
    const rttMs = Number(BigInt(clockPong.payload.r2) - BigInt(clockPong.payload.r1)) / 1000;

    // 13. 正常关闭 + 清理。
    await instance2.closeGracefully("shutdown");

    // 14. 退出卫生断言（二轮评审修复 10）：九项证据打印前不允许残留
    //     子进程、TCP Socket 或待触发定时器——空超时定时器会把成功
    //     Demo 拖住一段时间才退出。
    await assertExitHygiene();

    console.log("protocolVersion=1");
    console.log("controlHandshake=ok");
    console.log("clockSync=ok");
    console.log("mediaFrame=accepted");
    console.log("sceneCommit=durable");
    console.log("watermark=restored");
    console.log("outboxRecovery=ok");
    console.log("idempotency=ok");
    console.log("traceContinuity=ok");
    console.log(`--- trace ${committedReply.traceId} ---`);
    for (const event of traceEvents) {
      console.log(`  ${event.event} traceId=${event.traceId}`);
    }
    console.log(
      `--- summary sceneId=${DEMO.sceneId} committedAtMs=${committedReply.committedAtMs} serverSeq=${recovery.latestServerSeq} clockRtt~${rttMs.toFixed(2)}ms instances=${instanceId1.slice(0, 8)}→${instanceId2.slice(0, 8)} ---`,
    );
  } finally {
    // 成功/失败都清理：杀死残留子进程并删除临时目录。
    if (instance1 !== null && instance1.exitInfo === null) {
      instance1.child.kill("SIGKILL");
    }
    if (instance2 !== null && instance2.exitInfo === null) {
      instance2.child.kill("SIGKILL");
    }
    cleanup();
  }
}

try {
  await main();
} catch (error) {
  const stage = error instanceof DemoFailure ? error.stage : "unexpected";
  console.error(`demo:phase1 failed at stage=${stage}: ${error instanceof Error ? error.message : String(error)}`);
  for (const harness of [instance1Ref.value, instance2Ref.value]) {
    if (harness !== null && harness.diagnostics !== "") {
      console.error(`--- diagnostics (${harness === instance1Ref.value ? "instance-1" : "instance-2"}) ---`);
      for (const line of harness.diagnostics.split("\n")) {
        if (line !== "") {
          console.error(line);
        }
      }
    }
  }
  process.exit(1);
}
