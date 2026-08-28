import type { MonotonicClock } from "@bellis/contracts";
import type { LoggerPort } from "@bellis/observability";
import { MediaFrameParser } from "@bellis/transport";
import type { MediaFrame } from "@bellis/transport";
import { encodeMediaFrame, MediaFrameError } from "@bellis/transport";
import type { WebSocket } from "ws";
import type { ConnectionMetrics } from "./connection-metrics.js";
import type { LogicalSession } from "./session-store.js";

/**
 * Binary Media WebSocket 适配器（docs/phase-1-reference.md；binary-media-websocket.md §9/§10）。
 *
 * - 只接受 Binary；Text Frame 明确拒绝（关闭 1003）。
 * - 二进制内容完全交给 P1 增量 Parser + Stream Registry，适配器不重写协议。
 * - Parser 错误（字节流损坏，无法续读）→ 关闭连接；Registry 帧级拒绝
 *   （session/sequence/contentType 等）→ 记账并关闭该 Stream，连接保持。
 * - Phase 2 出站（Runtime → Stage 音频流）：sendFrame 编码 BELL v1 帧并
 *   写出；socket 缓冲超限（慢消费者背压）时丢弃并计数，绝不无限堆积。
 * - 连接关闭释放全部 Parser Buffer 与 Stream（registry.closeAll），
 *   重连后重新注册。
 */

const MEDIA_CLOSE_TEXT_FRAME = 1003;
/** 出站 socket 缓冲字节上限：超过即丢帧（发送端另有 maxBufferedUs 预算）。 */
const MAX_SEND_BUFFERED_BYTES = 4 * 1024 * 1024;

export interface MediaAdapterOptions {
  readonly socket: WebSocket;
  readonly logical: LogicalSession;
  readonly clock: MonotonicClock;
  readonly logger: LoggerPort;
  readonly connections: ConnectionMetrics;
  readonly limits: {
    readonly maxHeaderBytes: number;
    readonly maxPayloadBytes: number;
  };
}

export class MediaConnection {
  readonly #socket: WebSocket;
  readonly #logical: LogicalSession;
  readonly #clock: MonotonicClock;
  readonly #logger: LoggerPort;
  readonly #connections: ConnectionMetrics;
  readonly #parser: MediaFrameParser;
  readonly #limits: MediaAdapterOptions["limits"];
  #finished = false;
  #sentFrames = 0;
  #droppedFrames = 0;

  constructor(options: MediaAdapterOptions) {
    this.#socket = options.socket;
    this.#logical = options.logical;
    this.#clock = options.clock;
    this.#logger = options.logger;
    this.#connections = options.connections;
    this.#limits = options.limits;
    this.#parser = new MediaFrameParser({
      maxHeaderBytes: options.limits.maxHeaderBytes,
      maxPayloadBytes: options.limits.maxPayloadBytes,
    });
    options.logical.mediaConnections.add(this);
  }

  start(): void {
    this.#connections.acquire("media");
    this.#socket.on("message", (data: unknown, isBinary: boolean) => {
      if (this.#finished) {
        return;
      }
      if (!isBinary) {
        this.#logical.mediaFrames.rejected += 1;
        this.#close(MEDIA_CLOSE_TEXT_FRAME, "media channel accepts binary frames only");
        return;
      }
      const chunk = data instanceof Buffer ? data : Buffer.from(data as ArrayBufferLike);
      let frames: readonly MediaFrame[];
      try {
        this.#parser.push(chunk);
        frames = this.#parser.endMessage();
      } catch (error) {
        const code = error instanceof MediaFrameError ? error.code : "invalid_header";
        this.#logical.mediaFrames.rejected += 1;
        this.#logger.log("info", "runtime_media_frame_rejected", {
          sessionId: this.#logical.sessionId,
          code,
        });
        // Parser 进入 failed 状态，无法安全续读：关闭连接（客户端重连重注册）。
        this.#close(MEDIA_CLOSE_TEXT_FRAME, `media frame rejected (${code})`);
        return;
      }
      for (const frame of frames) {
        this.#acceptFrame(frame);
      }
    });
    this.#socket.on("close", () => this.#handleClosed());
    this.#socket.on("error", (error: Error) => {
      this.#logger.log("warn", "runtime_media_socket_error", {
        sessionId: this.#logical.sessionId,
        error: error.message,
      });
      this.#handleClosed();
    });
  }

  #acceptFrame(frame: MediaFrame): void {
    const result = this.#logical.mediaStreams.accept(frame, this.#clock.nowUs());
    if (result.status === "accepted") {
      this.#logical.mediaFrames.accepted += 1;
      return;
    }
    this.#logical.mediaFrames.rejected += 1;
    this.#logger.log("info", "runtime_media_frame_rejected", {
      sessionId: this.#logical.sessionId,
      code: result.code,
      streamId: frame.header.streamId,
    });
    // 帧级违规（乱序/重复/超时等）后该 Stream 状态不可信：关闭 Stream，
    // 连接保持——客户端可关闭后注册新 Stream。
    this.#logical.mediaStreams.close(frame.header.streamId);
  }

  /** 出站统计（仅聚合计数，不含帧内容）。 */
  get outboundStats(): { sent: number; dropped: number } {
    return { sent: this.#sentFrames, dropped: this.#droppedFrames };
  }

  /**
   * Phase 2 出站帧（Runtime → Stage，binary-media-websocket.md §10）：
   * 编码 BELL v1 并写出。连接非 OPEN 或 socket 缓冲超限时丢弃并返回
   * false（调用方计数；慢消费由发送端 maxBufferedUs 预算共同约束）。
   */
  sendFrame(frame: MediaFrame): boolean {
    if (this.#finished || this.#socket.readyState !== 1) {
      this.#droppedFrames += 1;
      return false;
    }
    if (this.#socket.bufferedAmount > MAX_SEND_BUFFERED_BYTES) {
      this.#droppedFrames += 1;
      return false;
    }
    let bytes: Uint8Array;
    try {
      bytes = encodeMediaFrame(frame, {
        maxHeaderBytes: this.#limits.maxHeaderBytes,
        maxPayloadBytes: this.#limits.maxPayloadBytes,
      });
    } catch (error) {
      this.#droppedFrames += 1;
      this.#logger.log("warn", "runtime_media_outbound_encode_failed", {
        sessionId: this.#logical.sessionId,
        error: error instanceof MediaFrameError ? error.code : "invalid_header",
      });
      return false;
    }
    // ws 的发送类型收窄为 Buffer；编码产物是同布局的 Uint8Array。
    this.#socket.send(bytes as unknown as Buffer);
    this.#sentFrames += 1;
    return true;
  }

  forceClose(reason: string): void {
    if (this.#finished) {
      return;
    }
    this.#close(1000, reason);
  }

  #close(code: number, reason: string): void {
    if (this.#finished) {
      return;
    }
    this.#socket.close(code, reason.length > 120 ? reason.slice(0, 120) : reason);
    this.#handleClosed();
  }

  #handleClosed(): void {
    if (this.#finished) {
      return;
    }
    this.#finished = true;
    this.#logical.mediaConnections.delete(this);
    this.#parser.reset();
    // Registry 所有权与本连接绑定（P4 修复 7）：关闭全部 Stream 并整体重建
    // ——P1 closeAll 不重置 totalStreams，重连必须拿到全新 Registry，
    // 旧连接的总量配额不跨连接继承；重连后重新注册 Stream。
    this.#logical.mediaStreams.closeAll();
    this.#logical.resetMediaRegistry();
    this.#connections.release("media");
  }
}
