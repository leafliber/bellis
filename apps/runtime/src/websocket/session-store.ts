import { randomBytes, randomUUID } from "node:crypto";
import { MediaStreamRegistry } from "@bellis/transport";
import type { ControlLogicalState, MediaStreamRegistryOptions } from "@bellis/transport";

/**
 * 逻辑 Session 存储（P4 文档 §8/§9/§10）。
 *
 * Cookie 令牌 → 逻辑 Session 的进程内映射。逻辑 Session 拥有：
 * - P1 `MediaStreamRegistry`（Stream 必须经同 Session 的 Control 注册）；
 * - 同进程上一次 Control 连接导出的逻辑状态（重连 resume 用）；
 * - 活跃 Control/Media 连接与媒体帧计数（仅聚合计数，不存帧内容）。
 *
 * Cookie 令牌是 256-bit 随机值，进程内有效；重启后客户端重新交换 Token
 * 建立新 Session（Phase 1 不跨重启恢复 Cookie，也不恢复旧 Stream）。
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

export class LogicalSession {
  readonly sessionId: string;
  readonly createdAtMs: number;
  readonly mediaStreams: MediaStreamRegistry;
  /** 同进程内上一次 Control 连接导出的逻辑状态；跨重启为 null。 */
  exportedControlState: ControlLogicalState | null = null;
  control: ControlConnectionLike | null = null;
  readonly mediaConnections = new Set<MediaConnectionLike>();
  readonly mediaFrames: MediaFrameStats = { accepted: 0, rejected: 0 };

  constructor(sessionId: string, createdAtMs: number, registryOptions: MediaStreamRegistryOptions) {
    this.sessionId = sessionId;
    this.createdAtMs = createdAtMs;
    this.mediaStreams = new MediaStreamRegistry(registryOptions);
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
  create(cookieToken: string, sessionId: string, createdAtMs: number): LogicalSession {
    const session = new LogicalSession(sessionId, createdAtMs, {
      ...this.#registryDefaults,
      sessionId,
    });
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

  /** 关闭全部连接（优雅关闭序列用）。返回被要求排空的连接数。 */
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
