import type { MonotonicClock } from "@bellis/contracts";
import type { LoggerPort } from "@bellis/observability";
import { MediaFrameParser } from "@bellis/transport";
import type { MediaFrame } from "@bellis/transport";
import { MediaFrameError } from "@bellis/transport";
import type { WebSocket } from "ws";
import type { ConnectionMetrics } from "./connection-metrics.js";
import type { LogicalSession } from "./session-store.js";

/**
 * Binary Media WebSocket 适配器（docs/phase-1-reference.md；binary-media-websocket.md §9）。
 *
 * - 只接受 Binary；Text Frame 明确拒绝（关闭 1003）。
 * - 二进制内容完全交给 P1 增量 Parser + Stream Registry，适配器不重写协议。
 * - Parser 错误（字节流损坏，无法续读）→ 关闭连接；Registry 帧级拒绝
 *   （session/sequence/contentType 等）→ 记账并关闭该 Stream，连接保持。
 * - 连接关闭释放全部 Parser Buffer 与 Stream（registry.closeAll），
 *   重连后重新注册。
 */

const MEDIA_CLOSE_TEXT_FRAME = 1003;

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
  #finished = false;

  constructor(options: MediaAdapterOptions) {
    this.#socket = options.socket;
    this.#logical = options.logical;
    this.#clock = options.clock;
    this.#logger = options.logger;
    this.#connections = options.connections;
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
