/* StageSocket Port 以 on* setter 为接口（自研 Port，非 DOM 事件）。 */
/* oxlint-disable unicorn/prefer-add-event-listener */
import type { MonotonicClock } from "@bellis/contracts";
import { PHASE_2_PCM_FRAME_DURATION_US } from "@bellis/contracts";
import {
  MediaFrameParser,
  MediaFrameError,
  MediaStreamRegistry,
  type MediaFrame,
} from "@bellis/transport/browser";
import { MediaStreamAnnouncePayloadSchema } from "@bellis/contracts";
import type { StageSocket } from "../control/stage-socket.js";

/**
 * Stage 媒体客户端（docs/phase-2-development-guide.md §8；binary-media-websocket.md §10）。
 *
 * Runtime → Stage 方向的 BELL v1 帧接收端：
 * - `media.stream.announce`（Control）到达时校验能力（contentType ∈ 本端
 *   声明的 audio.contentTypes）并在本端 Registry 注册 Stream，随后由
 *   装配层经 Control 回 `media.stream.ready`；
 * - 帧走 Media WebSocket：增量 Parser 解析 + Registry 校验（session 一致、
 *   contentType/kind 一致、sequence 严格连续、frameId 唯一）；
 * - 校验通过的 PCM 帧解交织为 Int16Array 交给 AudioLane（缓冲不生效）；
 * - 连接关闭释放全部 Parser Buffer 与 Stream（不跨连接复活）；意外断线
 *   以有界退避重连（重连后 Stream 必须重新 announce）；
 * - 全部路径有界：帧解析上限、Stream 上限、重连退避封顶。
 */

export interface InboundMediaFrame {
  readonly streamId: string;
  readonly sceneId: string | null;
  readonly sequence: bigint;
  readonly targetTimeUs: bigint | null;
  readonly samples: Int16Array;
}

export interface StageMediaClientOptions {
  readonly sessionId: string;
  readonly socketFactory: () => StageSocket;
  readonly clock: MonotonicClock;
  /** 本端声明接受的能力（stage.capabilities.audio.contentTypes）。 */
  readonly audioContentTypes: readonly string[];
  /**
   * Runtime 时钟域偏移估计（runtime − stage，clock_ready 前为 null）：
   * targetTimeUs 属 Runtime 单调域，Deadline 检查必须先映射到本域——
   * 直接用本域时钟比较属跨域误判（检查形同虚设）。null 时跳过检查。
   */
  readonly runtimeOffsetUs?: () => bigint | null;
  /** 校验通过的 PCM 帧（appendFrame 送入有界缓冲，不生效）。 */
  readonly onFrame: (frame: InboundMediaFrame) => void;
  /**
   * Stream 关闭（media.stream.closed 处理后触发）：携带从已验收帧推导的
   * 发言结束时刻（映射到 Stage 本地域；无帧或无时钟估计为 null）。
   * 装配层据此驱动音频 EOS 与字幕定时撤下（Lane 真实完成信号）。
   */
  readonly onStreamClosed?: (info: {
    readonly streamId: string;
    readonly sceneId: string | null;
    readonly finalSequence: bigint | null;
    readonly endLocalUs: bigint | null;
  }) => void;
  /** 意外断线重连前的通知（装配层可清空 Lane 缓冲）。 */
  readonly onDisconnected?: (reason: string) => void;
  readonly maxHeaderBytes?: number;
  readonly maxPayloadBytes?: number;
  /** Deadline 判定宽限（默认 100ms；映射后的同域比较才有意义）。 */
  readonly deadlineGraceUs?: bigint;
}

export interface StageMediaStats {
  readonly acceptedFrames: number;
  readonly rejectedFrames: number;
  readonly openedStreams: number;
  readonly connectAttempts: number;
  /** 原始 WS message 事件数（解析前；诊断传输层是否送达）。 */
  readonly rawMessages: number;
}

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 8_000;
/**
 * Deadline 判定宽限：Runtime 按目标时刻节奏发送（到达 ≈ 目标时刻），
 * 加上传输/主线程处理抖动——超过该宽限才视为迟到不可用（丢弃）。
 */
const DEFAULT_DEADLINE_GRACE_US = 100_000n;
/** announce 到媒体连接就绪的等待上限（超时放弃该 Stream 的 ready）。 */
const READY_WAIT_TIMEOUT_MS = 2_000;

/** 已验收帧的流元数据（发言结束时刻推导）。 */
interface StreamMeta {
  sceneId: string | null;
  firstTargetUs: bigint | null;
  lastTargetUs: bigint | null;
}

export class StageMediaClient {
  readonly #options: StageMediaClientOptions;
  readonly #registry: MediaStreamRegistry;
  readonly #streamMeta = new Map<string, StreamMeta>();
  #socket: StageSocket | null = null;
  #parser: MediaFrameParser | null = null;
  #connected = false;
  #closedByUser = false;
  #reconnectAttempt = 0;
  #reconnectTimer: AbortController | null = null;
  #connectWaiters: Array<() => void> = [];
  #stats: StageMediaStats = {
    acceptedFrames: 0,
    rejectedFrames: 0,
    openedStreams: 0,
    connectAttempts: 0,
    rawMessages: 0,
  };

  constructor(options: StageMediaClientOptions) {
    this.#options = options;
    this.#registry = new MediaStreamRegistry({
      sessionId: options.sessionId,
      deadlineGraceUs: options.deadlineGraceUs ?? DEFAULT_DEADLINE_GRACE_US,
    });
  }

  get stats(): StageMediaStats {
    return { ...this.#stats };
  }

  get connected(): boolean {
    return this.#connected;
  }

  /** 打开媒体连接（发起即返回；就绪状态经 connected/announce 等待兑现）。 */
  connect(): void {
    if (this.#closedByUser || this.#connected || this.#socket !== null) {
      return;
    }
    this.#stats = { ...this.#stats, connectAttempts: this.#stats.connectAttempts + 1 };
    const socket = this.#options.socketFactory();
    this.#socket = socket;
    this.#parser = new MediaFrameParser({
      ...(this.#options.maxHeaderBytes === undefined
        ? {}
        : { maxHeaderBytes: this.#options.maxHeaderBytes }),
      ...(this.#options.maxPayloadBytes === undefined
        ? {}
        : { maxPayloadBytes: this.#options.maxPayloadBytes }),
    });
    socket.onopen = () => {
      this.#connected = true;
      this.#reconnectAttempt = 0;
      const waiters = this.#connectWaiters;
      this.#connectWaiters = [];
      for (const waiter of waiters) {
        waiter();
      }
    };
    socket.onmessage = (data) => this.#onMessage(data);
    socket.onclose = (code, reason) => {
      this.#handleClosed(`media_socket_closed:${code}:${reason}`);
    };
    socket.onerror = () => {
      // onclose 随后到达。
    };
  }

  /**
   * 处理 Control 通道的 media.stream.announce：能力校验 + 注册 + ready 回执。
   * 返回是否已回 ready（媒体连接未就绪时等待有界时限后放弃）。
   */
  async handleAnnounce(
    payload: unknown,
    sendReady: (payload: unknown) => boolean,
  ): Promise<boolean> {
    const parsed = MediaStreamAnnouncePayloadSchema.safeParse(payload);
    if (!parsed.success) {
      return false;
    }
    const announce = parsed.data;
    if (
      announce.mediaKind !== "audio" ||
      !this.#options.audioContentTypes.includes(announce.contentType)
    ) {
      return false;
    }
    const opened = this.#registry.open({
      streamId: announce.streamId,
      sessionId: this.#options.sessionId,
      mediaKind: announce.mediaKind,
      contentType: announce.contentType,
    });
    if (opened.status === "rejected") {
      return false;
    }
    this.#stats = { ...this.#stats, openedStreams: this.#stats.openedStreams + 1 };
    if (!this.#connected) {
      await this.#waitForConnected();
      if (this.#closedByUser || !this.#connected) {
        return false;
      }
    }
    return sendReady({ streamId: announce.streamId });
  }

  /**
   * 关闭单个 Stream（Control media.stream.closed 到达时调用）：释放
   * Registry 槽位（并发上限）与帧级状态。finalSequence 为关闭边界：
   * closed 与帧跨连接乱序时，边界内严格连续的迟到尾帧仍可入账。随后以
   * 已验收帧元数据推导发言结束时刻并触发 onStreamClosed（驱动 Lane 的
   * 真实完成信号）。
   */
  closeStream(streamId: string, finalSequence?: bigint): void {
    this.#registry.close(streamId, finalSequence === undefined ? undefined : { finalSequence });
    const meta = this.#streamMeta.get(streamId);
    if (meta === undefined) {
      return; // 从未验收过帧：无可推导的结束时刻，也无可驱动的 Lane。
    }
    this.#streamMeta.delete(streamId);
    const offsetUs = this.#options.runtimeOffsetUs?.() ?? null;
    const endRuntimeUs = this.#speechEndRuntimeUs(meta, finalSequence ?? null);
    this.#options.onStreamClosed?.({
      streamId,
      sceneId: meta.sceneId,
      finalSequence: finalSequence ?? null,
      endLocalUs: endRuntimeUs !== null && offsetUs !== null ? endRuntimeUs - offsetUs : null,
    });
  }

  /** 发言结束（Runtime 域）：优先首帧时刻 + 边界帧数 × 20ms。 */
  #speechEndRuntimeUs(meta: StreamMeta, finalSequence: bigint | null): bigint | null {
    if (meta.firstTargetUs !== null && finalSequence !== null) {
      return meta.firstTargetUs + (finalSequence + 1n) * PHASE_2_PCM_FRAME_DURATION_US;
    }
    if (meta.lastTargetUs !== null) {
      return meta.lastTargetUs + PHASE_2_PCM_FRAME_DURATION_US;
    }
    return null;
  }

  /**
   * 失效全部媒体 Stream（控制代际变化）：Runtime 已随断线取消全部帧
   * 任务（Stream 不跨连接复活）——Registry 槽位同步清空，不遗留。
   */
  invalidateStreams(): void {
    this.#registry.closeAll();
    this.#streamMeta.clear();
  }

  #onMessage(data: string | Uint8Array): void {
    this.#stats = { ...this.#stats, rawMessages: this.#stats.rawMessages + 1 };
    const parser = this.#parser;
    if (typeof data === "string" || parser === null) {
      // 媒体通道只承载二进制帧；文本帧按协议违例断开重连。
      this.#stats = { ...this.#stats, rejectedFrames: this.#stats.rejectedFrames + 1 };
      this.#socket?.close(1003, "media channel accepts binary frames only");
      return;
    }
    // browser-socket 以 arraybuffer 接收：统一收窄为 Uint8Array。
    const chunk = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
    let frames: readonly MediaFrame[];
    try {
      parser.push(chunk);
      frames = parser.endMessage();
    } catch (error) {
      // 字节流损坏无法续读：断开（重连后 Stream 重新 announce）。
      void error;
      this.#stats = { ...this.#stats, rejectedFrames: this.#stats.rejectedFrames + 1 };
      this.#socket?.close(1003, "media frame parse failed");
      return;
    }
    for (const frame of frames) {
      this.#acceptFrame(frame);
    }
  }

  #acceptFrame(frame: MediaFrame): void {
    const offsetUs = this.#options.runtimeOffsetUs?.() ?? null;
    const nowUs = offsetUs === null ? null : this.#options.clock.nowUs() + offsetUs;
    const result = this.#registry.accept(frame, nowUs);
    if (result.status === "rejected") {
      this.#stats = { ...this.#stats, rejectedFrames: this.#stats.rejectedFrames + 1 };
      // 帧级违规后该 Stream 状态不可信：关闭 Stream，连接保持。
      this.#registry.close(frame.header.streamId);
      this.#streamMeta.delete(frame.header.streamId);
      return;
    }
    this.#stats = { ...this.#stats, acceptedFrames: this.#stats.acceptedFrames + 1 };
    const targetUs =
      frame.header.targetTimeUs === undefined ? null : BigInt(frame.header.targetTimeUs);
    const meta = this.#streamMeta.get(frame.header.streamId) ?? {
      sceneId: null,
      firstTargetUs: null,
      lastTargetUs: null,
    };
    this.#streamMeta.set(frame.header.streamId, {
      sceneId: frame.header.sceneId ?? meta.sceneId,
      firstTargetUs: meta.firstTargetUs ?? targetUs,
      lastTargetUs: targetUs ?? meta.lastTargetUs,
    });
    this.#options.onFrame({
      streamId: frame.header.streamId,
      sceneId: frame.header.sceneId ?? null,
      sequence: result.lastSequence,
      targetTimeUs: targetUs,
      samples: decodeInt16Le(frame.payload),
    });
  }

  #handleClosed(reason: string): void {
    if (!this.#connected && this.#socket === null) {
      return;
    }
    this.#connected = false;
    const socket = this.#socket;
    this.#socket = null;
    if (socket !== null) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
    }
    this.#parser?.reset();
    this.#parser = null;
    // Stream 状态随连接丢弃（不跨连接复活）。
    this.#registry.closeAll();
    this.#streamMeta.clear();
    this.#options.onDisconnected?.(reason);
    if (this.#closedByUser) {
      return;
    }
    // 意外断线：有界退避重连。
    const backoffMs = Math.min(RECONNECT_BASE_MS * 2 ** this.#reconnectAttempt, RECONNECT_MAX_MS);
    this.#reconnectAttempt += 1;
    const timer = new AbortController();
    this.#reconnectTimer = timer;
    void this.#options.clock
      .sleepUntil(this.#options.clock.nowUs() + BigInt(backoffMs) * 1000n, timer.signal)
      .then(
        () => {
          if (!this.#closedByUser && !this.#connected) {
            this.connect();
          }
        },
        () => {},
      );
  }

  async #waitForConnected(): Promise<void> {
    if (this.#connected) {
      return;
    }
    await Promise.race([
      new Promise<void>((resolve) => {
        this.#connectWaiters.push(resolve);
      }),
      this.#options.clock
        .sleepUntil(this.#options.clock.nowUs() + BigInt(READY_WAIT_TIMEOUT_MS) * 1000n)
        .catch(() => {}),
    ]);
  }

  /** 统一关闭：停止重连并释放全部资源。 */
  close(): void {
    if (this.#closedByUser) {
      return;
    }
    this.#closedByUser = true;
    this.#reconnectTimer?.abort(new Error("closed"));
    this.#reconnectTimer = null;
    const socket = this.#socket;
    this.#socket = null;
    if (socket !== null) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.close(1000, "stage_media_close");
    }
    this.#parser?.reset();
    this.#parser = null;
    this.#registry.closeAll();
    this.#streamMeta.clear();
    for (const waiter of this.#connectWaiters.splice(0)) {
      waiter();
    }
  }
}

/** S16LE 字节解交织为 Int16Array（不依赖对齐的 byteOffset）。 */
function decodeInt16Le(payload: Uint8Array): Int16Array {
  const samples = new Int16Array(payload.length >> 1);
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = (payload[i * 2] ?? 0) | ((payload[i * 2 + 1] ?? 0) << 8);
  }
  return samples;
}

export { MediaFrameError };
