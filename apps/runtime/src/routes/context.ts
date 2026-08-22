import type { FastifyRequest } from "fastify";
import type { TraceContext } from "@bellis/contracts";
import type { LoggerPort } from "@bellis/observability";
import { createTraceContext, parseTraceparent } from "@bellis/observability";
import type { LocalSessionService } from "../auth/local-session.js";
import type { RuntimeConfig } from "../bootstrap/config.js";
import type { RuntimeStatus } from "../bootstrap/lifecycle.js";

/**
 * Route 层共享上下文：Route Handler 只做边界校验、调用 Application
 * Service 和响应映射，业务事务顺序全部在 application/**。
 */
export interface RouteContext {
  readonly config: RuntimeConfig;
  readonly logger: LoggerPort;
  readonly status: RuntimeStatus;
  readonly instanceId: string;
  readonly origins: OriginAllowlist;
  readonly requestTraces: RequestTraceStore;
}

/** 需要 Session 服务的路由（Auth Exchange）。 */
export type AuthRouteContext = RouteContext & { readonly sessions: LocalSessionService };

/**
 * Origin 允许列表：监听端口确定后（port=0 时为实际端口）才填充；
 * 未填充前拒绝一切 Origin（安全默认）。
 */
export interface OriginAllowlist {
  allows(origin: string): boolean;
  replaceAll(origins: readonly string[]): void;
}

export function createOriginAllowlist(): OriginAllowlist {
  let allowed = new Set<string>();
  return {
    allows: (origin: string) => allowed.has(origin.trim().toLowerCase()),
    replaceAll: (origins: readonly string[]) => {
      allowed = new Set(origins.map((value) => value.trim().toLowerCase()));
    },
  };
}

/** 每请求 Trace：HTTP 边界接受合法 W3C traceparent，非法值忽略并新建。 */
export class RequestTraceStore {
  readonly #traces = new WeakMap<FastifyRequest, TraceContext>();

  capture(request: FastifyRequest): TraceContext {
    const header = request.headers.traceparent;
    const parsed = typeof header === "string" ? parseTraceparent(header) : null;
    const trace =
      parsed === null
        ? createTraceContext()
        : createTraceContext({ traceId: parsed.traceId, spanId: parsed.spanId });
    this.#traces.set(request, trace);
    return trace;
  }

  get(request: FastifyRequest): TraceContext {
    return this.#traces.get(request) ?? createTraceContext();
  }
}
