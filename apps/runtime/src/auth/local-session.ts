import type { TraceContext } from "@bellis/contracts";
import { TraceContextSchema } from "@bellis/contracts";
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
 */

export interface ExchangeSuccess {
  readonly sessionId: string;
  readonly cookieToken: string;
  readonly createdAtMs: number;
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
   * 执行 Token 交换。失败统一 `unauthorized`（不区分过期/未知/已使用），
   * 成功后 Token 即失效。Session 创建失败（DB 不可用等）向上抛映射错误。
   */
  async exchange(startupToken: unknown, trace: TraceContext): Promise<ExchangeSuccess> {
    if (!this.#tokens.exchange(startupToken).ok) {
      throw new ApplicationError("unauthorized", "startup token exchange rejected");
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
    return { sessionId, cookieToken, createdAtMs };
  }
}
