import { randomBytes, randomUUID } from "node:crypto";
import { MediaStreamRegistry } from "@bellis/transport";
import type { ControlLogicalState, MediaStreamRegistryOptions } from "@bellis/transport";

/**
 * 逻辑 Session 存储（docs/reference/phase-1.md）。
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
 * 失效与容量边界（二轮评审修复 9 + 三轮评审修复 2）：
 * - Session 自 createdAtMs 起 sessionTtlMs 后整体过期（全部 Cookie 一起
 *   失效）；过期 Session 在解析/创建时惰性回收，且由**最近到期调度器**
 *   主动回收——已建立的 Control/Media 连接即使不再触发任何 Store 查询，
 *   也会在到期时被强制关闭，不能无限越过 TTL。
 * - 超过 maxSessions 时按 createdAtMs 淘汰最旧（稳定 FIFO；被淘汰
 *   Session 的连接同样强制关闭）。
 *
 * 导出状态的事务式消费（三轮评审修复 1）：`claimExportedControlState()`
 * 独占预留（并发初始化至多一个获得状态），恢复读取/对账/构造全部成功
 * 才 commit 永久消费，任何失败由持有者 rollback 原样归还。
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

/** 导出 Control 状态的事务式消费句柄：commit 永久消费；rollback 原样归还。 */
export interface ExportedControlClaim {
  /** 被预留的导出状态；无可消费状态时为 null（commit/rollback 为空操作）。 */
  readonly state: ControlLogicalState | null;
  commit(): void;
  rollback(): void;
}

export class LogicalSession {
  readonly sessionId: string;
  readonly createdAtMs: number;
  readonly restorable: boolean;
  #mediaStreams: MediaStreamRegistry;
  /** 同进程内上一次 Control 连接导出的逻辑状态；跨重启为 null。 */
  exportedControlState: ControlLogicalState | null = null;
  /** 进行中的导出状态预留：初始化连接独占持有，settle 前其它 claim 等待。 */
  #exportClaim: ControlLogicalState | null = null;
  #exportClaimWaiters: Array<() => void> = [];
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

  /**
   * 事务式预留导出的 Control 状态（三轮评审修复 1）：claim → commit/rollback。
   *
   * - 有进行中的 claim 时等待其 settle——并发初始化至多一个连接获得
   *   状态（不能只把"读取即清空"后移，否则两个并发初始化重复消费）；
   * - 取出即独占；恢复读取、水位对账与 ControlSession 构造全部成功后
   *   commit 永久消费；任何失败或初始化期间连接关闭由持有者 rollback
   *   原样归还，后续重连仍可恢复；
   * - 没有导出状态时返回空 claim（不设独占点——全新 Session 的并发
   *   初始化无共享状态可争用，连接槽位本身已保证同时只有一条活跃连接）。
   */
  async claimExportedControlState(): Promise<ExportedControlClaim> {
    while (this.#exportClaim !== null) {
      await new Promise<void>((resolve) => {
        this.#exportClaimWaiters.push(resolve);
      });
    }
    const state = this.exportedControlState;
    if (state === null) {
      return { state: null, commit: () => {}, rollback: () => {} };
    }
    this.exportedControlState = null;
    this.#exportClaim = state;
    let settled = false;
    const settle =
      (restore: boolean): (() => void) =>
      () => {
        if (settled) {
          return;
        }
        settled = true;
        if (restore) {
          this.exportedControlState = state;
        }
        this.#exportClaim = null;
        const waiters = this.#exportClaimWaiters.splice(0, this.#exportClaimWaiters.length);
        for (const waiter of waiters) {
          waiter();
        }
      };
    return { state, commit: settle(false), rollback: settle(true) };
  }
}

export interface SessionStoreOptions {
  /** 逻辑 Session 自创建起的存活时长（毫秒）。 */
  readonly ttlMs: number;
  /** 容量上限；超出按创建时间淘汰最旧。 */
  readonly maxSessions: number;
  readonly nowMs?: () => number;
  /**
   * 到期调度注入：与生产 setTimeout 同语义（按延迟触发、返回取消函数）。
   * 测试注入手动时钟以保持确定性；生产默认 unref 的 setTimeout。
   */
  readonly scheduleTimer?: (delayMs: number, onFire: () => void) => () => void;
}

/** 生产默认调度：unref 的 setTimeout（不阻止进程退出）。 */
function defaultScheduleTimer(delayMs: number, onFire: () => void): () => void {
  const timer = setTimeout(onFire, delayMs);
  timer.unref();
  return () => clearTimeout(timer);
}

export class SessionStore {
  readonly #byCookie = new Map<string, LogicalSession>();
  readonly #byId = new Map<string, LogicalSession>();
  readonly #registryDefaults: Omit<MediaStreamRegistryOptions, "sessionId">;
  readonly #ttlMs: number;
  readonly #maxSessions: number;
  readonly #nowMs: () => number;
  readonly #scheduleTimer: (delayMs: number, onFire: () => void) => () => void;
  /** 当前到期调度点与取消函数（最近到期时间调度，三轮评审修复 2）。 */
  #expiryTimerAtMs: number | null = null;
  #expiryTimerCancel: (() => void) | null = null;
  #closed = false;

  constructor(
    registryDefaults: Omit<MediaStreamRegistryOptions, "sessionId">,
    options: SessionStoreOptions,
  ) {
    this.#registryDefaults = registryDefaults;
    this.#ttlMs = options.ttlMs;
    this.#maxSessions = options.maxSessions;
    this.#nowMs = options.nowMs ?? Date.now;
    this.#scheduleTimer = options.scheduleTimer ?? defaultScheduleTimer;
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
    this.#rescheduleExpiry();
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
    this.#rescheduleExpiry();
  }

  /**
   * 最近到期时间调度（三轮评审修复 2）：TTL 不能只依赖 create/resolve 的
   * 惰性检查——已建立的连接若不再触发 Store 查询，可以无限越过 TTL。
   * 调度点始终取全部 Session 的最近到期时间；到期时主动执行统一移除
   * 逻辑（强关 Control/Media + 撤销 Cookie），再为剩余 Session 重排。
   */
  #rescheduleExpiry(): void {
    if (this.#closed) {
      return;
    }
    let nearest: number | null = null;
    for (const session of this.#byId.values()) {
      const deadline = session.createdAtMs + this.#ttlMs;
      if (nearest === null || deadline < nearest) {
        nearest = deadline;
      }
    }
    if (nearest === null) {
      this.#cancelExpiryTimer();
      return;
    }
    // 已有相同或更早的调度点：保持（fire 时重扫并重排到更晚的时间）。
    if (this.#expiryTimerAtMs !== null && this.#expiryTimerAtMs <= nearest) {
      return;
    }
    this.#cancelExpiryTimer();
    this.#expiryTimerAtMs = nearest;
    this.#expiryTimerCancel = this.#scheduleTimer(Math.max(0, nearest - this.#nowMs()), () => {
      this.#expiryTimerCancel = null;
      this.#expiryTimerAtMs = null;
      this.#sweepExpired();
      this.#rescheduleExpiry();
    });
  }

  #cancelExpiryTimer(): void {
    this.#expiryTimerCancel?.();
    this.#expiryTimerCancel = null;
    this.#expiryTimerAtMs = null;
  }

  /**
   * 关闭调度器（Runtime 关闭步骤调用）：取消在途定时器且不再重排，
   * 不遗留任何 TTL 调度句柄。
   */
  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#cancelExpiryTimer();
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

/** 生成新的 Cookie 令牌（256-bit 随机 base64url）；不属于持久化身份。 */
export function newCookieToken(): string {
  return randomBytes(32).toString("base64url");
}

/** 生成新的逻辑 Session ID 与 Cookie 令牌（256-bit 随机 base64url）。 */
export function newSessionIdentity(): { sessionId: string; cookieToken: string } {
  return {
    sessionId: randomUUID(),
    cookieToken: newCookieToken(),
  };
}
