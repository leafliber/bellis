import { describe, expect, it } from "vitest";
import { VirtualClock } from "@bellis/testkit";
import { encodeMediaFrame } from "@bellis/transport";
import type { StageSocket } from "../../src/control/stage-socket.js";
import { StageMediaClient, type InboundMediaFrame } from "../../src/media/stage-media-client.js";

/**
 * Stage 媒体客户端单元测试（Node 环境，Fake Socket；真实 AudioWorklet/
 * 浏览器 WebSocket 由 test:browser 覆盖）：
 * - announce 能力校验（contentType 不在声明清单 → 拒绝且不回 ready）；
 * - 帧校验复用 Registry：sequence 严格连续、session 一致；
 * - PCM 解交织为 Int16Array；
 * - 断线释放全部 Stream 状态；close() 零残留。
 */

class FakeSocket implements StageSocket {
  onopen: (() => void) | null = null;
  onmessage: ((data: string | Uint8Array) => void) | null = null;
  onclose: ((code: number, reason: string) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: (string | Uint8Array)[] = [];
  #closed = false;

  get closed(): boolean {
    return this.#closed;
  }

  send(data: string | Uint8Array): void {
    if (this.#closed) {
      throw new Error("socket closed");
    }
    this.sent.push(data);
  }

  close(_code?: number, _reason?: string): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.onclose?.(1000, "closed");
  }

  serverOpen(): void {
    this.onopen?.();
  }

  serverSend(data: string | Uint8Array): void {
    this.onmessage?.(data);
  }
}

const SESSION = "11111111-1111-4111-8111-111111111111";
const STREAM = "99999999-9999-4999-8999-999999999999";
const SCENE = "44444444-4444-4444-8444-444444444444";
const CONTENT_TYPE = "audio/pcm-s16le-48000-mono";

function frameBytes(sequence: number, samplesValue = 0x0102): Uint8Array {
  const payload = new Uint8Array(1920);
  for (let i = 0; i < payload.length; i += 2) {
    payload[i] = samplesValue & 0xff;
    payload[i + 1] = (samplesValue >> 8) & 0xff;
  }
  return encodeMediaFrame(
    {
      mediaKind: "audio",
      header: {
        schemaVersion: 1,
        streamId: STREAM,
        frameId: `aaaaaaaa-aaaa-4aaa-8aaa-${sequence.toString(16).padStart(12, "0")}`,
        sessionId: SESSION,
        sceneId: SCENE,
        sequence: String(sequence),
        targetTimeUs: String(1_000_000n + BigInt(sequence) * 20_000n),
        durationUs: "20000",
        contentType: CONTENT_TYPE,
        traceId: "0123456789abcdef0123456789abcdef",
      },
      payload,
    },
    { maxPayloadBytes: 4096 },
  );
}

function createClient(
  frames: InboundMediaFrame[],
  options?: { readonly runtimeOffsetUs?: () => bigint | null },
) {
  const clock = new VirtualClock();
  let socket: FakeSocket | null = null;
  const client = new StageMediaClient({
    sessionId: SESSION,
    socketFactory: () => {
      socket = new FakeSocket();
      return socket;
    },
    clock,
    audioContentTypes: [CONTENT_TYPE],
    ...(options?.runtimeOffsetUs === undefined ? {} : { runtimeOffsetUs: options.runtimeOffsetUs }),
    onFrame: (frame) => frames.push(frame),
  });
  return {
    clock,
    client,
    socket: () => socket,
  };
}

describe("StageMediaClient", () => {
  it("announce 校验能力并回 ready；帧解交织为 Int16", async () => {
    const frames: InboundMediaFrame[] = [];
    const h = createClient(frames);
    h.client.connect();
    h.socket()!.serverOpen();

    const readyPayloads: unknown[] = [];
    const accepted = await h.client.handleAnnounce(
      { streamId: STREAM, mediaKind: "audio", contentType: CONTENT_TYPE },
      (payload) => {
        readyPayloads.push(payload);
        return true;
      },
    );
    expect(accepted).toBe(true);
    expect(readyPayloads).toEqual([{ streamId: STREAM }]);

    h.socket()!.serverSend(frameBytes(0));
    h.socket()!.serverSend(frameBytes(1));
    expect(frames).toHaveLength(2);
    expect(frames[0]?.samples).toHaveLength(960);
    expect(frames[0]?.samples[0]).toBe(0x0102);
    expect(frames[0]?.sceneId).toBe(SCENE);
    expect(frames[1]?.sequence).toBe(1n);
    h.client.close();
  });

  it("contentType 不在能力清单：拒绝 announce，不回 ready", async () => {
    const frames: InboundMediaFrame[] = [];
    const h = createClient(frames);
    h.client.connect();
    h.socket()!.serverOpen();
    const accepted = await h.client.handleAnnounce(
      { streamId: STREAM, mediaKind: "audio", contentType: "audio/opus" },
      () => true,
    );
    expect(accepted).toBe(false);
    expect(frames).toHaveLength(0);
    h.client.close();
  });

  it("sequence 跳号：帧被拒绝且 Stream 关闭（后续帧不再接受）", async () => {
    const frames: InboundMediaFrame[] = [];
    const h = createClient(frames);
    h.client.connect();
    h.socket()!.serverOpen();
    await h.client.handleAnnounce(
      { streamId: STREAM, mediaKind: "audio", contentType: CONTENT_TYPE },
      () => true,
    );
    h.socket()!.serverSend(frameBytes(0));
    h.socket()!.serverSend(frameBytes(2)); // 跳号
    h.socket()!.serverSend(frameBytes(3)); // Stream 已关：拒绝
    expect(frames).toHaveLength(1);
    expect(h.client.stats.rejectedFrames).toBe(2);
    h.client.close();
  });

  it("断线：Stream 状态全部释放，重连后旧 Stream 不可复活", async () => {
    const frames: InboundMediaFrame[] = [];
    const disconnects: string[] = [];
    const clock = new VirtualClock();
    let socket: FakeSocket | null = null;
    const client = new StageMediaClient({
      sessionId: SESSION,
      socketFactory: () => {
        socket = new FakeSocket();
        return socket;
      },
      clock,
      audioContentTypes: [CONTENT_TYPE],
      onFrame: (frame) => frames.push(frame),
      onDisconnected: (reason) => disconnects.push(reason),
    });
    client.connect();
    socket!.serverOpen();
    await client.handleAnnounce(
      { streamId: STREAM, mediaKind: "audio", contentType: CONTENT_TYPE },
      () => true,
    );
    socket!.serverSend(frameBytes(0));
    expect(frames).toHaveLength(1);
    socket!.close(1006, "abnormal");
    expect(disconnects).toHaveLength(1);
    // 重连（虚拟时钟推进退避）后旧 Stream 必须重新 announce 才接受帧。
    clock.advanceBy(600_000n);
    await Promise.resolve();
    socket!.serverOpen();
    socket!.serverSend(frameBytes(1));
    expect(frames).toHaveLength(1);
    client.close();
  });
});

describe("StageMediaClient Deadline 时钟域映射", () => {
  it("targetTimeUs（Runtime 域）经偏移映射后判定：过期拒绝、未过期接受", async () => {
    const frames: InboundMediaFrame[] = [];
    // Runtime 时钟领先本域 500ms：映射后 now(runtime) = 本域 + 500ms。
    const h = createClient(frames, { runtimeOffsetUs: () => 500_000n });
    h.client.connect();
    h.socket()!.serverOpen();
    await h.client.handleAnnounce(
      { streamId: STREAM, mediaKind: "audio", contentType: CONTENT_TYPE },
      () => true,
    );
    // 帧 0 目标 = 1_000_000（Runtime 域）；本域时钟 0 → 映射后 500_000
    // < 目标：未过期，接受。
    h.socket()!.serverSend(frameBytes(0));
    expect(frames).toHaveLength(1);
    // 帧 1 目标 = 1_020_000：本域推进 620_000 → 映射后 1_120_000 − 目标
    // = 100ms ≥ 宽限（默认 100ms：发送按目标节奏 + 抖动余量）→
    // deadline_exceeded，拒绝且不入帧。
    h.clock.advanceBy(620_000n);
    h.socket()!.serverSend(frameBytes(1));
    expect(frames).toHaveLength(1);
  });

  it("偏移估计缺失（clock_ready 前）：跳过 Deadline 检查，帧照常接受", async () => {
    const frames: InboundMediaFrame[] = [];
    const h = createClient(frames, { runtimeOffsetUs: () => null });
    h.client.connect();
    h.socket()!.serverOpen();
    await h.client.handleAnnounce(
      { streamId: STREAM, mediaKind: "audio", contentType: CONTENT_TYPE },
      () => true,
    );
    // 本域时钟远小于 Runtime 域目标——不做跨域比较，直接接受。
    h.clock.advanceBy(10n);
    h.socket()!.serverSend(frameBytes(0));
    expect(frames).toHaveLength(1);
  });
});
