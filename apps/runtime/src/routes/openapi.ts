import type { FastifyInstance } from "fastify";
import { generateJsonSchemaFiles } from "@bellis/contracts";
import { z } from "zod";
import type { RouteContext } from "./context.js";

/**
 * OpenAPI 3.1 路由（P4 文档 §7.5）。
 *
 * - 请求/响应 Schema 来源于同一 Zod 源（Auth Exchange 属 Runtime 边界，
 *   在此定义；ErrorEnvelope 直接复用 @bellis/contracts 生成物），
 *   不复制手写 JSON Schema。
 * - 文档只包含实际注册的 Phase 1 REST 接口；WebSocket 协议通过
 *   `x-bellis-websocket` 扩展指向三份协议文档，不伪装成普通 REST。
 * - 文档确定性生成：不含时间戳，同一构建输入得到同一输出。
 */

const AuthExchangeRequestSchema = z.object({
  startupToken: z.string().min(1).max(256).optional(),
});

const AuthExchangeResponseSchema = z.object({
  sessionId: z.string().uuid(),
  createdAtMs: z.number().int().nonnegative(),
});

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
  const errorRef = ERROR_REF;
  return {
    openapi: "3.1.0",
    info: {
      title: "Bellis Runtime API",
      version: options.runtimeVersion,
      summary: "Bellis 本地 Runtime 的 Phase 1 REST 边界",
      description:
        "Health/Version/Auth Exchange。Control 与 Binary Media WebSocket 不在 REST 文档内伪装，见 x-bellis-websocket。",
    },
    servers: [{ url: options.serverOrigin }],
    paths: {
      "/api/v1/health/live": {
        get: {
          operationId: "healthLive",
          summary: "进程存活探针（不检查下游依赖）",
          responses: {
            200: jsonResponse({
              type: "object",
              properties: { status: { const: "live" } },
              required: ["status"],
            }),
          },
        },
      },
      "/api/v1/health/ready": {
        get: {
          operationId: "healthReady",
          summary: "就绪探针（Migration/DB Worker/恢复/协议注册完成后为 200）",
          responses: {
            200: jsonResponse({
              type: "object",
              properties: { status: { const: "ready" } },
              required: ["status"],
            }),
            503: jsonResponse(errorRef),
          },
        },
      },
      "/api/v1/version": {
        get: {
          operationId: "getVersion",
          summary: "应用版本、协议版本、构建信息与 Runtime Instance ID",
          responses: {
            200: jsonResponse({
              type: "object",
              properties: {
                version: { type: "string" },
                protocol: {
                  type: "object",
                  properties: {
                    control: { const: 1 },
                    media: { const: 1 },
                  },
                  required: ["control", "media"],
                },
                buildInfo: { type: "object", additionalProperties: true },
                runtimeInstanceId: { type: "string" },
              },
              required: ["version", "protocol", "buildInfo", "runtimeInstanceId"],
            }),
          },
        },
      },
      "/api/v1/auth/exchange": {
        post: {
          operationId: "authExchange",
          summary: "一次性启动 Token 换取本地 Session Cookie",
          description:
            "Token 从请求 Body 或 Authorization: Bearer 头接收，绝不放 URL Query。成功设置 HttpOnly、SameSite=Strict Cookie。",
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: jsonSchemaOf(AuthExchangeRequestSchema) },
            },
          },
          responses: {
            200: jsonResponse({ $ref: "#/components/schemas/AuthExchangeResponse" }),
            400: jsonResponse(errorRef),
            401: jsonResponse(errorRef),
            503: jsonResponse(errorRef),
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
