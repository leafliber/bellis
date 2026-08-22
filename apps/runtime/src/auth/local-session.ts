import type { TraceContext } from "@bellis/contracts";
import { TraceContextSchema } from "@bellis/contracts";
import { PersistenceError } from "@bellis/persistence";
import type { PersistenceClient } from "@bellis/persistence";
import type { LoggerPort } from "@bellis/observability";
import { ApplicationError } from "../errors/mapping.js";
import { newSessionIdentity, SessionStore } from "../websocket/session-store.js";
import type { StartupTokenService } from "./startup-token.js";

/**
 * 本地 Session 服务（P4 文档 §7.4/§8）。
 *
 * 一次性 Startup Token 交换成功 → 创建逻辑 Session（P2 ensureSession
 * 落库）→ 签发 HttpOnly / SameSite=Strict / 限定 Path 的 Cookie。
 * Token 原值、Cookie 令牌不进入日志、Session Record 或 Outbox。
 *
 * 跨重启重新挂载（P4 修复 1）：请求体携带 `resumeSessionId` 时，交换
 * 绑定该**已存在**的逻辑 Session（P2 行必须存在），Control 连接可从
 * 持久化的 latestServerSeq 恢复 Seq 水位；不存在时统一 unauthorized。
 *
 * Token 消费与失败语义（二轮评审修复 5）：
 * - Token 先独占预留，持久化成功后 commit（永久消费）；
 * - 持久化**可重试**失败（database_busy/unavailable/deadline_exceeded/
 *   not_migrated/closed）释放预留，同 Token 重试有效——HTTP 已声明的
 *   retryable 必须真实可重试；
 * - resume 目标不存在（session_not_found）折叠为统一 unauthorized 并
 *   commit（客户端错误，Token 不被探测重放）；
 * - resume 分支的其它持久化错误原样上抛，由集中错误映射返回
 *   503/504，而不是吞成 unauthorized。
 */

/** 持久化层瞬态错误码：释放 Token 预留，允许同 Token 重试。 */
const TRANSIENT_PERSISTENCE_CODES = new Set([
  "database_busy",
  "unavailable",
  "deadline_exceeded",
  "not_migrated",
  "closed",
]);

export interface ExchangeSuccess {
  readonly sessionId: string;
  readonly cookieToken: string;
  readonly createdAtMs: number;
  readonly resumed: boolean;
}

export class LocalSessionService {
  readonly #tokens: StartupTokenService;
  readonly #store: SessionStore;
  readonly #persistence: PersistenceClient;
  readonly #logger: LoggerPort;

  constructor(options: {
    tokens: StartupTokenService;
    store: SessionStore;
    persistence: PersistenceClient;
    logger: LoggerPort;
  }) {
    this.#tokens = options.tokens;
    this.#store = options.store;
    this.#persistence = options.persistence;
    this.#logger = options.logger;
  }

  get store(): SessionStore {
    return this.#store;
  }

  /**
   * 执行 Token 交换。Token 失败统一 `unauthorized`（不区分过期/未知/
   * 已使用/resume 目标不存在），成功后 Token 即失效。
   */
  async exchange(
    startupToken: unknown,
    trace: TraceContext,
    resumeSessionId?: string,
  ): Promise<ExchangeSuccess> {
    const reservation = this.#tokens.reserve(startupToken);
    if (reservation === null) {
      throw new ApplicationError("unauthorized", "startup token exchange rejected");
    }
    try {
      const result = await this.#exchangeReserved(trace, resumeSessionId);
      reservation.commit();
      return result;
    } catch (error) {
      // 释放语义：PersistenceError 仅瞬态码释放；ApplicationError（统一
      // unauthorized 等）是确定性客户端错误，Token 已花掉；未知异常
      // fail-open 释放，允许同 Token 重试。
      const releaseForRetry =
        error instanceof PersistenceError
          ? TRANSIENT_PERSISTENCE_CODES.has(error.code)
          : !(error instanceof ApplicationError);
      if (releaseForRetry) {
        reservation.release();
      } else {
        reservation.commit();
      }
      throw error;
    }
  }

  async #exchangeReserved(
    trace: TraceContext,
    resumeSessionId: string | undefined,
  ): Promise<ExchangeSuccess> {
    if (resumeSessionId !== undefined) {
      // 重新挂载：Session 必须已存在于 P2；不重新 ensureSession（行已存在）。
      try {
        await this.#persistence.readRecoveryState(resumeSessionId);
      } catch (error) {
        if (error instanceof PersistenceError && error.code === "session_not_found") {
          throw new ApplicationError("unauthorized", "startup token exchange rejected");
        }
        // 其它持久化错误原样上抛（503/504 可重试），不吞成 unauthorized。
        throw error;
      }
      const { cookieToken } = newSessionIdentity();
      const boundAtMs = Date.now();
      // 同进程重复挂载：store 复用同一逻辑对象并原子轮换 Cookie。
      this.#store.create(cookieToken, resumeSessionId, boundAtMs, { restorable: true });
      this.#logger.log("info", "runtime_session_resumed", {
        sessionId: resumeSessionId,
        traceId: trace.traceId,
      });
      return { sessionId: resumeSessionId, cookieToken, createdAtMs: boundAtMs, resumed: true };
    }
    const { sessionId, cookieToken } = newSessionIdentity();
    const createdAtMs = Date.now();
    await this.#persistence.ensureSession({
      sessionId,
      createdAtMs,
      trace: TraceContextSchema.parse({ ...trace, sessionId }),
    });
    this.#store.create(cookieToken, sessionId, createdAtMs);
    this.#logger.log("info", "runtime_session_created", {
      sessionId,
      traceId: trace.traceId,
    });
    return { sessionId, cookieToken, createdAtMs, resumed: false };
  }
}
