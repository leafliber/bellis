/**
 * 协议级 Stage 客户端（Phase 2 Demo/Crash Windows 共用，仅测试脚本）。
 * 真实 Control + Media WebSocket、真实协议消息与 BELL v1 二进制帧。
 */
import { request as httpRequest } from "node:http";
import { performance } from "node:perf_hooks";
import { WebSocket } from "ws";

export const PCM_CONTENT_TYPE = "audio/pcm-s16le-48000-mono";
export const PCM_FRAME_BYTES = 1920;

export class ScriptFailure extends Error {
  constructor(stage, message) {
    super(`[${stage}] ${message}`);
    this.stage = stage;
  }
}

export function hex(n) {
  return Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");
}
export const uuid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-8${hex(3)}-${hex(12)}`;
export const traceId = () => hex(32);

export function postJson(port, path, body, cookie) {
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
export function parseBellFrame(buffer) {
  if (buffer.length < 12) {
    throw new ScriptFailure("media-frame", `frame too short (${buffer.length} bytes)`);
  }
  if (buffer.subarray(0, 4).toString("ascii") !== "BELL") {
    throw new ScriptFailure("media-frame", "bad magic");
  }
  if (buffer[4] !== 1) {
    throw new ScriptFailure("media-frame", `unsupported version ${buffer[4]}`);
  }
  const headerLength = buffer.readUInt32LE(8);
  return {
    header: JSON.parse(buffer.subarray(12, 12 + headerLength).toString("utf8")),
    payload: buffer.subarray(12 + headerLength),
  };
}

export class StageClient {
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
    this.streams = new Map();
    this.frameWaiters = [];
    this.traceRoots = new Map();
    this.closedObserved = null;
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
      this.ws.on("error", (error) => reject(new ScriptFailure("stage-connect", error.message)));
      this.ws.on("close", (code, reason) => {
        this.closedObserved = { code, reason: String(reason) };
      });
      this.ws.on("message", (data) => {
        const envelope = JSON.parse(data.toString("utf8"));
        this.handleServerEnvelope(envelope);
      });
    });
  }

  connectMedia() {
    return new Promise((resolve, reject) => {
      this.media = new WebSocket(`ws://127.0.0.1:${this.port}/ws/v1/media`, {
        headers: { cookie: this.cookie, origin: `http://127.0.0.1:${this.port}` },
      });
      this.media.binaryType = "nodebuffer";
      this.media.on("open", resolve);
      this.media.on("error", (error) => reject(new ScriptFailure("media-connect", error.message)));
      this.media.on("message", (data, isBinary) => {
        if (!isBinary) {
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

  handleAnnounce(envelope) {
    const { streamId, mediaKind, contentType, sceneId } = envelope.payload;
    if (mediaKind !== "audio" || contentType !== PCM_CONTENT_TYPE) {
      throw new ScriptFailure("media-announce", `unsupported stream ${mediaKind}/${contentType}`);
    }
    this.streams.set(streamId, { sceneId, frames: [], lastSeq: -1, rmsSum: 0 });
    if (sceneId !== undefined && envelope.trace?.traceId !== undefined) {
      this.traceRoots.set(sceneId, envelope.trace.traceId);
    }
    this.send("media.stream.ready", { streamId });
  }

  handleMediaFrame(buffer) {
    const { header, payload } = parseBellFrame(buffer);
    const stream = this.streams.get(header.streamId);
    if (stream === undefined) {
      return;
    }
    const sequence = Number(header.sequence);
    if (sequence !== stream.lastSeq + 1) {
      throw new ScriptFailure("media-frame", `sequence gap: ${sequence} after ${stream.lastSeq}`);
    }
    stream.lastSeq = sequence;
    let sumSquares = 0;
    for (let i = 0; i < payload.length; i += 2) {
      const sample = payload.readInt16LE(i);
      sumSquares += sample * sample;
    }
    stream.rmsSum += Math.sqrt(sumSquares / (payload.length / 2));
    stream.frames.push({ sequence, targetTimeUs: BigInt(header.targetTimeUs) });
    for (const waiter of this.frameWaiters.splice(0)) {
      waiter();
    }
  }

  latestStream() {
    return [...this.streams.entries()].at(-1)?.[1] ?? null;
  }

  send(type, payload, extra = {}) {
    this.ws.send(
      JSON.stringify({
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
      }),
    );
  }

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
        throw new ScriptFailure(
          "stage-wait",
          `timeout waiting for ${type} (inbox: ${this.inbox.map((e) => e.type).join(",")})`,
        );
      }
      let timer = undefined;
      let alive = true;
      try {
        const envelope = await Promise.race([
          new Promise((resolve) => {
            this.waiters.push((delivered) => {
              if (alive) {
                resolve(delivered);
              } else {
                this.inbox.push(delivered);
              }
            });
          }),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new ScriptFailure("stage-wait", `timeout waiting for ${type}`)),
              remaining,
            );
          }),
        ]);
        this.seq = Number(envelope.seq);
        if (envelope.type === type) {
          return envelope;
        }
        this.inbox.push(envelope);
      } finally {
        alive = false;
        clearTimeout(timer);
      }
    }
  }

  /** 是否在 timeoutMs 内观察到 type（不消费其它消息）。 */
  async observeType(type, timeoutMs) {
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      const index = this.inbox.findIndex((e) => e.type === type);
      if (index !== -1) {
        return this.inbox.splice(index, 1)[0];
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        return null;
      }
      let timer = undefined;
      let alive = true;
      try {
        const envelope = await Promise.race([
          new Promise((resolve) => {
            this.waiters.push((delivered) => {
              if (alive) {
                resolve(delivered);
              } else {
                this.inbox.push(delivered);
              }
            });
          }),
          new Promise((resolve) => {
            timer = setTimeout(resolve, remaining);
          }),
        ]);
        if (envelope !== undefined && envelope.type === type) {
          this.seq = Number(envelope.seq);
          return envelope;
        }
        if (envelope !== undefined) {
          this.inbox.push(envelope);
        }
      } finally {
        alive = false;
        clearTimeout(timer);
      }
    }
  }

  close() {
    this.media?.close(1000, "script_complete");
    this.ws?.close(1000, "script_complete");
  }
}

export class Ipc {
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
        throw new ScriptFailure("ipc", `timeout waiting for ${type}`);
      }
      // 计时器在成功/失败两侧都清理；超时方遗留的 waiter 标记失效
      //（消息送达死 waiter 时原样回队，不吞消息）。
      let timer = undefined;
      let alive = true;
      try {
        const message = await Promise.race([
          new Promise((resolve) => {
            this.waiters.push((delivered) => {
              if (alive) {
                resolve(delivered);
              } else {
                // 超时后送达：死 waiter 不吞消息，原样回队。
                this.pending.push(delivered);
              }
            });
          }),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new ScriptFailure("ipc", `timeout waiting for ${type}`)),
              remaining,
            );
          }),
        ]);
        if (message.type === type) {
          return message;
        }
        this.pending.push(message);
      } finally {
        alive = false;
        clearTimeout(timer);
      }
    }
  }
}
