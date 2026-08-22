import { randomBytes, randomUUID } from "node:crypto";
import { MediaStreamRegistry } from "@bellis/transport";
import type { ControlLogicalState, MediaStreamRegistryOptions } from "@bellis/transport";

/**
 * 逻辑 Session 存储（P4 文档 §8/§9/§10）。
 *
 * Cookie 令牌 → 逻辑 Session 的进程内映射。逻辑 Session 拥有：
 * - P1 `MediaStreamRegistry`（Stream 必须经同 Session 的 Control 注册）；
 * - 同进程上一次 Control 连接导出的逻辑状态（重连 resume 用）；
 * - `restorable` 标记：经 resumeSessionId 重新挂载的 Session，Control
 *   连接应从 P2 latestServerSeq 恢复 Seq 水位（跨重启不复用 Seq）；
 * - 活跃 Control/Media 连接与媒体帧计数（仅聚合计数，不存帧内容）。
 *
 * Media Registry 的所有权与 Media 连接生命周期一致（P4 修复 7）：
 * 同一 Session 同时只允许一条 Media 连接；该连接关闭时 Registry 整体重建
 * （P1 closeAll 不重置 totalStreams，重连必须拿到全新 Registry）。
 */

/** Control 连接的最小结构契约（避免与适配器模块循环依赖）。 */
export interface ControlConnectionLike {
  beginDrain(reason: string): void;
  forceClose(): void;
}

/** Media 连接的最小结构契约。 */
export interface MediaConnectionLike {
  forceClose(reason: string): void;
}

export interface MediaFrameStats {
  accepted: number;
  rejected: number;
}

export interface LogicalSessionOptions {
  /** 经 resumeSessionId 挂载：从 P2 恢复 Seq 水位。 */
  readonly restorable?: boolean;
}

export class LogicalSession {
  readonly sessionId: string;
  readonly createdAtMs: number;
  readonly restorable: boolean;
  #mediaStreams: MediaStreamRegistry;
  /** 同进程内上一次 Control 连接导出的逻辑状态；跨重启为 null。 */
  exportedControlState: ControlLogicalState | null = null;
  control: ControlConnectionLike | null = null;
  readonly mediaConnections = new Set<MediaConnectionLike>();
  readonly mediaFrames: MediaFrameStats = { accepted: 0, rejected: 0 };
  readonly #registryDefaults: Omit<MediaStreamRegistryOptions, "sessionId">;

  constructor(
    sessionId: string,
    createdAtMs: number,
    registryDefaults: Omit<MediaStreamRegistryOptions, "sessionId">,
    options?: LogicalSessionOptions,
  ) {
    this.sessionId = sessionId;
    this.createdAtMs = createdAtMs;
    this.restorable = options?.restorable === true;
    this.#registryDefaults = registryDefaults;
    this.#mediaStreams = new MediaStreamRegistry({ ...registryDefaults, sessionId });
  }

  get mediaStreams(): MediaStreamRegistry {
    return this.#mediaStreams;
  }

  /**
   * 重建全新 Registry（关闭全部旧 Stream 且重置 totalStreams 计数）。
   * 仅在 Media 连接关闭/重连时调用——旧连接的总量配额不跨连接继承。
   */
  resetMediaRegistry(): void {
    this.#mediaStreams = new MediaStreamRegistry({
      ...this.#registryDefaults,
      sessionId: this.sessionId,
    });
  }
}

export class SessionStore {
  readonly #byCookie = new Map<string, LogicalSession>();
  readonly #byId = new Map<string, LogicalSession>();
  readonly #registryDefaults: Omit<MediaStreamRegistryOptions, "sessionId">;

  constructor(registryDefaults: Omit<MediaStreamRegistryOptions, "sessionId">) {
    this.#registryDefaults = registryDefaults;
  }

  /** 创建逻辑 Session 并登记 Cookie 令牌。 */
  create(
    cookieToken: string,
    sessionId: string,
    createdAtMs: number,
    options?: LogicalSessionOptions,
  ): LogicalSession {
    const session = new LogicalSession(sessionId, createdAtMs, this.#registryDefaults, options);
    this.#byCookie.set(cookieToken, session);
    this.#byId.set(sessionId, session);
    return session;
  }

  /** 按 Cookie 令牌解析逻辑 Session；未知/伪造返回 null。 */
  resolveByCookie(cookieToken: unknown): LogicalSession | null {
    if (typeof cookieToken !== "string" || cookieToken.length === 0 || cookieToken.length > 256) {
      return null;
    }
    return this.#byCookie.get(cookieToken) ?? null;
  }

  resolveById(sessionId: string): LogicalSession | null {
    return this.#byId.get(sessionId) ?? null;
  }

  get size(): number {
    return this.#byId.size;
  }

  /** 是否仍有活跃 Control/Media 连接（优雅关闭排空判定）。 */
  anyOpenConnections(): boolean {
    for (const session of this.#byId.values()) {
      if (session.control !== null || session.mediaConnections.size > 0) {
        return true;
      }
    }
    return false;
  }

  /** 通知全部 Control 连接 draining 并强关 Media 连接；返回 Control 连接数。 */
  drainAll(reason: string): number {
    let count = 0;
    for (const session of this.#byId.values()) {
      if (session.control !== null) {
        session.control.beginDrain(reason);
        count += 1;
      }
      for (const connection of session.mediaConnections) {
        connection.forceClose(reason);
      }
    }
    return count;
  }

  forceCloseAll(reason: string): void {
    for (const session of this.#byId.values()) {
      session.control?.forceClose();
      for (const connection of session.mediaConnections) {
        connection.forceClose(reason);
      }
    }
  }
}

/** 生成新的逻辑 Session ID 与 Cookie 令牌（256-bit 随机 base64url）。 */
export function newSessionIdentity(): { sessionId: string; cookieToken: string } {
  return {
    sessionId: randomUUID(),
    cookieToken: randomBytes(32).toString("base64url"),
  };
}
