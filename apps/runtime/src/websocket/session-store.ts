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
 *
 * 同一 sessionId 的重复挂载（二轮评审修复 1）：create() 复用**同一**逻辑
 * Session 对象并原子轮换 Cookie——撤销全部旧 Cookie、登记新 Cookie，
 * 绝不创建第二个对象（否则双对象竞争同一 P2 Seq，关闭流程只回收其一）。
 *
 * 失效与容量边界（二轮评审修复 9）：
 * - Session 自 createdAtMs 起 sessionTtlMs 后整体过期（全部 Cookie 一起
 *   失效）；过期 Session 在解析/创建时惰性回收，活跃连接被强制关闭。
 * - 超过 maxSessions 时按 createdAtMs 淘汰最旧（稳定 FIFO；被淘汰
 *   Session 的连接同样强制关闭）。
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
  /** 该 Session 当前有效的 Cookie 令牌（令牌 → 绑定时间）。 */
  readonly #cookies = new Map<string, number>();
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

  /** 登记一枚 Cookie 令牌。 */
  bindCookie(cookieToken: string, boundAtMs: number): void {
    this.#cookies.set(cookieToken, boundAtMs);
  }

  /** 撤销全部 Cookie 令牌（轮换时调用；返回被撤销的令牌列表）。 */
  revokeAllCookies(): string[] {
    const revoked = [...this.#cookies.keys()];
    this.#cookies.clear();
    return revoked;
  }

  /** 当前有效 Cookie 令牌数。 */
  get cookieCount(): number {
    return this.#cookies.size;
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

export interface SessionStoreOptions {
  /** 逻辑 Session 自创建起的存活时长（毫秒）。 */
  readonly ttlMs: number;
  /** 容量上限；超出按创建时间淘汰最旧。 */
  readonly maxSessions: number;
  readonly nowMs?: () => number;
}

export class SessionStore {
  readonly #byCookie = new Map<string, LogicalSession>();
  readonly #byId = new Map<string, LogicalSession>();
  readonly #registryDefaults: Omit<MediaStreamRegistryOptions, "sessionId">;
  readonly #ttlMs: number;
  readonly #maxSessions: number;
  readonly #nowMs: () => number;

  constructor(
    registryDefaults: Omit<MediaStreamRegistryOptions, "sessionId">,
    options: SessionStoreOptions,
  ) {
    this.#registryDefaults = registryDefaults;
    this.#ttlMs = options.ttlMs;
    this.#maxSessions = options.maxSessions;
    this.#nowMs = options.nowMs ?? Date.now;
  }

  /**
   * 创建逻辑 Session 并登记 Cookie 令牌；sessionId 已存在时**复用同一
   * 对象**并原子轮换 Cookie（撤销全部旧令牌，登记新令牌）。
   */
  create(
    cookieToken: string,
    sessionId: string,
    createdAtMs: number,
    options?: LogicalSessionOptions,
  ): LogicalSession {
    this.#sweepExpired();
    const existing = this.#byId.get(sessionId);
    if (existing !== undefined) {
      // 轮换：同一对象、新 Cookie；旧 Cookie 立即失效，不存在双 Cookie 并存。
      for (const revoked of existing.revokeAllCookies()) {
        this.#byCookie.delete(revoked);
      }
      existing.bindCookie(cookieToken, createdAtMs);
      this.#byCookie.set(cookieToken, existing);
      return existing;
    }
    const session = new LogicalSession(sessionId, createdAtMs, this.#registryDefaults, options);
    session.bindCookie(cookieToken, createdAtMs);
    this.#byCookie.set(cookieToken, session);
    this.#byId.set(sessionId, session);
    this.#enforceCapacity();
    return session;
  }

  /** 按 Cookie 令牌解析逻辑 Session；未知/伪造/所属 Session 已过期返回 null。 */
  resolveByCookie(cookieToken: unknown): LogicalSession | null {
    if (typeof cookieToken !== "string" || cookieToken.length === 0 || cookieToken.length > 256) {
      return null;
    }
    const session = this.#byCookie.get(cookieToken) ?? null;
    if (session === null) {
      return null;
    }
    if (this.#isExpired(session)) {
      this.#remove(session, "session_expired");
      return null;
    }
    return session;
  }

  resolveById(sessionId: string): LogicalSession | null {
    const session = this.#byId.get(sessionId) ?? null;
    if (session === null) {
      return null;
    }
    if (this.#isExpired(session)) {
      this.#remove(session, "session_expired");
      return null;
    }
    return session;
  }

  get size(): number {
    return this.#byId.size;
  }

  #isExpired(session: LogicalSession): boolean {
    return this.#nowMs() - session.createdAtMs >= this.#ttlMs;
  }

  /** 惰性回收全部过期 Session（含强关其连接）。 */
  #sweepExpired(): void {
    const nowMs = this.#nowMs();
    for (const session of this.#byId.values()) {
      if (nowMs - session.createdAtMs >= this.#ttlMs) {
        this.#remove(session, "session_expired");
      }
    }
  }

  /** 容量边界：按 createdAtMs 淘汰最旧，直至回到上限内（稳定 FIFO）。 */
  #enforceCapacity(): void {
    while (this.#byId.size > this.#maxSessions) {
      let oldest: LogicalSession | null = null;
      for (const session of this.#byId.values()) {
        if (oldest === null || session.createdAtMs < oldest.createdAtMs) {
          oldest = session;
        }
      }
      if (oldest === null) {
        return;
      }
      this.#remove(oldest, "session_capacity_evicted");
    }
  }

  /** 移除逻辑 Session：强关其连接并撤销全部 Cookie 映射。 */
  #remove(session: LogicalSession, reason: string): void {
    session.control?.forceClose();
    for (const connection of session.mediaConnections) {
      connection.forceClose(reason);
    }
    for (const revoked of session.revokeAllCookies()) {
      this.#byCookie.delete(revoked);
    }
    this.#byId.delete(session.sessionId);
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
