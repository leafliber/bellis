import type { FastifyInstance } from "fastify";
import { generateJsonSchemaFiles } from "@bellis/contracts";
import { z } from "zod";
import type { RouteContext } from "./context.js";
import {
  AuthExchangeRequestSchema,
  AuthExchangeResponseSchema,
  HealthLiveResponseSchema,
  HealthReadyResponseSchema,
  VersionResponseSchema,
} from "./schemas.js";

/**
 * OpenAPI 3.1 路由（docs/reference/phase-1.md）。
 *
 * - 请求/响应 Schema 与 Route Handler 共用 schemas.ts / @bellis/contracts
 *   生成物（ErrorEnvelope），不在文档中维护重复定义。
 * - 文档只包含实际注册的 Phase 1 REST 接口；WebSocket 与持久化协议通过
 *   `x-bellis-websocket` / `x-bellis-protocols` 扩展指向三份协议文档，
 *   不伪装成普通 REST。
 * - 文档确定性生成：不含时间戳，同一构建输入得到同一输出。
 */

function contractSchema(key: string): Record<string, unknown> {
  const path = `json-schema-2020-12/${key}.json`;
  const file = generateJsonSchemaFiles().find((entry) => entry.path === path);
  return file === undefined ? {} : (JSON.parse(file.content) as Record<string, unknown>);
}

function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema) as Record<string, unknown>;
}

const ERROR_REF: Record<string, unknown> = { $ref: "#/components/schemas/ErrorEnvelope" };

function jsonResponse(schema: Record<string, unknown>): Record<string, unknown> {
  return {
    description: "",
    content: { "application/json": { schema } },
  };
}

export function buildOpenApiDocument(options: {
  readonly runtimeVersion: string;
  readonly serverOrigin: string;
}): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: "Bellis Runtime API",
      version: options.runtimeVersion,
      summary: "Bellis 本地 Runtime 的 Phase 1 REST 边界",
      description:
        "Health/Version/Auth Exchange。Control 与 Binary Media WebSocket 不在 REST 文档内伪装，见 x-bellis-websocket；持久化协议见 x-bellis-protocols。",
    },
    servers: [{ url: options.serverOrigin }],
    paths: {
      "/api/v1/health/live": {
        get: {
          operationId: "healthLive",
          summary: "进程存活探针（不检查下游依赖）",
          responses: {
            200: jsonResponse(jsonSchemaOf(HealthLiveResponseSchema)),
          },
        },
      },
      "/api/v1/health/ready": {
        get: {
          operationId: "healthReady",
          summary: "就绪探针（Migration/DB Worker/恢复/协议注册完成后为 200）",
          responses: {
            200: jsonResponse(jsonSchemaOf(HealthReadyResponseSchema)),
            503: jsonResponse(ERROR_REF),
          },
        },
      },
      "/api/v1/version": {
        get: {
          operationId: "getVersion",
          summary: "应用版本、协议版本、构建信息与 Runtime Instance ID",
          responses: {
            200: jsonResponse(jsonSchemaOf(VersionResponseSchema)),
          },
        },
      },
      "/api/v1/auth/exchange": {
        post: {
          operationId: "authExchange",
          summary: "一次性启动 Token 换取本地 Session Cookie",
          description:
            "Token 从请求 Body 或 Authorization 头接收，绝不放 URL Query；成功设置 HttpOnly、SameSite=Strict Cookie。可选 resumeSessionId 跨重启重新挂载已存在的逻辑 Session（从持久化 Server Seq 水位恢复）。凭据来源见 x-bellis-auth（不存在无凭据的合法请求）。",
          security: [{ startupToken: [] }],
          "x-bellis-auth": {
            credentialSources: [
              {
                scheme: "startupToken",
                description:
                  "Authorization: Bearer <startupToken>——标准 HTTP Bearer，OpenAPI 安全方案客户端可直接使用",
              },
              {
                scheme: "x-bellis-startup-token-prefix",
                description:
                  "Authorization: StartupToken <startupToken>（扩展前缀，等价于 Bearer）",
              },
              {
                source: "requestBody",
                description: "JSON Body 的 startupToken 字段（与 Header 提供其一即可）",
              },
            ],
            note: "三种来源提供其一即可；缺失 Token 返回 400 invalid_message。无凭据请求不合法。",
          },
          requestBody: {
            required: false,
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/AuthExchangeRequest" } },
            },
          },
          responses: {
            200: {
              description: "交换成功；Set-Cookie 设置 HttpOnly 会话 Cookie",
              headers: {
                "set-cookie": {
                  description: "HttpOnly、SameSite=Strict 的会话 Cookie（浏览器自动处理）",
                  schema: { type: "string" },
                },
              },
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/AuthExchangeResponse" },
                },
              },
            },
            400: jsonResponse(ERROR_REF),
            401: jsonResponse(ERROR_REF),
            503: jsonResponse(ERROR_REF),
            504: jsonResponse(ERROR_REF),
            500: jsonResponse(ERROR_REF),
          },
        },
      },
      "/api/v1/openapi.json": {
        get: {
          operationId: "getOpenapi",
          summary: "本文档（OpenAPI 3.1）",
          responses: { 200: jsonResponse({ type: "object" }) },
        },
      },
    },
    components: {
      securitySchemes: {
        startupToken: {
          type: "http",
          scheme: "bearer",
          description:
            "一次性启动 Token：Authorization: Bearer <startupToken>（StartupToken 前缀与 Body 来源见 x-bellis-auth）",
        },
      },
      schemas: {
        ErrorEnvelope: contractSchema("error-envelope"),
        AuthExchangeRequest: jsonSchemaOf(AuthExchangeRequestSchema),
        AuthExchangeResponse: jsonSchemaOf(AuthExchangeResponseSchema),
      },
    },
    "x-bellis-websocket": [
      {
        path: "/ws/v1/control",
        protocol: "control-websocket",
        protocolVersion: 1,
        authentication: "session cookie from POST /api/v1/auth/exchange",
        documentation: "docs/protocols/control-websocket.md",
      },
      {
        path: "/ws/v1/media",
        protocol: "binary-media-websocket",
        protocolVersion: 1,
        authentication: "session cookie; streams registered via control channel",
        documentation: "docs/protocols/binary-media-websocket.md",
      },
    ],
    "x-bellis-protocols": [
      "docs/protocols/control-websocket.md",
      "docs/protocols/binary-media-websocket.md",
      "docs/protocols/persistence-and-recovery.md",
    ],
  };
}

export function registerOpenApiRoute(app: FastifyInstance, ctx: RouteContext): void {
  app.get("/api/v1/openapi.json", () => {
    const host =
      ctx.config.host === "::1"
        ? `[::1]:${ctx.status.port}`
        : `${ctx.config.host}:${ctx.status.port}`;
    return buildOpenApiDocument({
      runtimeVersion: ctx.config.runtimeVersion,
      serverOrigin: `http://${host}`,
    });
  });
}
