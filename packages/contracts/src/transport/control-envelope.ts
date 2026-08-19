import { z } from "zod";
import { DecimalStringSchema } from "../common/decimal-string.js";
import { SpanIdSchema, TraceIdSchema, UuidSchema } from "../common/ids.js";

/**
 * Control WebSocket 的 Wire Envelope 规范形态（ADR 0001 / phase-1-build-guide.md §6.5）。
 *
 * - 微秒时间、序号、ACK 与水位使用非负十进制字符串，进入 Runtime 后再无损转 bigint。
 * - direction 是判别字段：只有服务端 Envelope 包含 seq；只有客户端 Envelope
 *   可以包含累计 ack 与业务 idempotencyKey。禁止用 seq: "0" 伪装方向。
 * - messageId 用于去重，seq/ack 用于服务端消息排序与累计确认，三者不能互换。
 * - Envelope 层使用 passthrough + 显式跨字段校验，以便对「服务端携带幂等字段」
 *   「客户端伪造 seq」给出明确协议错误；Payload 层统一 strip 未知字段（§6.6）。
 */

export const CONTROL_PROTOCOL_VERSION = 1;

export const EnvelopeTraceSchema = z.object({
  traceId: TraceIdSchema,
  spanId: SpanIdSchema.optional(),
});

export const CONTROL_MESSAGE_TYPE_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/;

/** Envelope 基础字段：单一来源，供 server/client 两个方向共享。 */
const controlEnvelopeBaseShape = {
  version: z.literal(CONTROL_PROTOCOL_VERSION),
  type: z.string().regex(CONTROL_MESSAGE_TYPE_PATTERN, {
    message: 'message type must be dotted lowercase segments, e.g. "clock.ping"',
  }),
  messageId: UuidSchema,
  sessionId: UuidSchema,
  trace: EnvelopeTraceSchema,
  sentAtUs: DecimalStringSchema,
  deadlineUs: DecimalStringSchema.optional(),
  payload: z.unknown(),
} as const;

/** 只有客户端 Envelope 允许携带的字段。 */
const CLIENT_ONLY_FIELDS = ["ack", "idempotencyKey"] as const;

/** 只有服务端 Envelope 允许携带的字段。 */
const SERVER_ONLY_FIELDS = ["seq"] as const;

/** zod 原生 check 上下文的最小结构视图（只依赖公共形态，不引用内部类型）。 */
interface RawIssueLike {
  readonly code?: string | undefined;
  readonly message?: string | undefined;
  readonly path?: readonly PropertyKey[] | undefined;
}

interface CheckContextLike {
  readonly value: unknown;
  readonly issues: RawIssueLike[];
}

interface CustomIssue {
  code: "custom";
  message: string;
  path: PropertyKey[];
}

function findForbiddenField(
  value: Record<string, unknown>,
  fields: readonly string[],
  direction: "server" | "client",
): CustomIssue | null {
  for (const field of fields) {
    if (field in value) {
      return {
        code: "custom",
        message: `${direction} envelope must not carry "${field}"`,
        path: [field],
      };
    }
  }
  return null;
}

function serverRejectsClientFields(ctx: CheckContextLike): void {
  const issue = findForbiddenField(
    ctx.value as Record<string, unknown>,
    CLIENT_ONLY_FIELDS,
    "server",
  );
  if (issue !== null) {
    ctx.issues.push(issue);
  }
}

function clientRejectsServerFields(ctx: CheckContextLike): void {
  const issue = findForbiddenField(
    ctx.value as Record<string, unknown>,
    SERVER_ONLY_FIELDS,
    "client",
  );
  if (issue !== null) {
    ctx.issues.push(issue);
  }
}

export const ServerControlEnvelopeSchema = z
  .looseObject({
    ...controlEnvelopeBaseShape,
    direction: z.literal("server"),
    /** 服务端消息序号：每个逻辑 Session 严格递增的非负十进制字符串。 */
    seq: DecimalStringSchema,
  })
  .check(serverRejectsClientFields);

export const ClientControlEnvelopeSchema = z
  .looseObject({
    ...controlEnvelopeBaseShape,
    direction: z.literal("client"),
    /** 客户端已处理的最大连续服务端序号（累计确认）。 */
    ack: DecimalStringSchema.optional(),
    /** 会改变持久状态的请求必须携带的业务幂等键。 */
    idempotencyKey: z.string().min(1).max(128).optional(),
  })
  .check(clientRejectsServerFields);

export const ControlEnvelopeSchema = z.discriminatedUnion("direction", [
  ServerControlEnvelopeSchema,
  ClientControlEnvelopeSchema,
]);

/** 用具体 Payload Schema 组装服务端 Envelope（供 P1 Transport 使用）。 */
export function createServerControlEnvelopeSchema<P extends z.ZodType>(payloadSchema: P) {
  return z
    .looseObject({
      ...controlEnvelopeBaseShape,
      direction: z.literal("server"),
      seq: DecimalStringSchema,
      payload: payloadSchema,
    })
    .check(serverRejectsClientFields);
}

/** 用具体 Payload Schema 组装客户端 Envelope（供 P1 Transport 使用）。 */
export function createClientControlEnvelopeSchema<P extends z.ZodType>(payloadSchema: P) {
  return z
    .looseObject({
      ...controlEnvelopeBaseShape,
      direction: z.literal("client"),
      ack: DecimalStringSchema.optional(),
      idempotencyKey: z.string().min(1).max(128).optional(),
      payload: payloadSchema,
    })
    .check(clientRejectsServerFields);
}

export type EnvelopeTrace = z.infer<typeof EnvelopeTraceSchema>;
export type ServerControlEnvelope = z.infer<typeof ServerControlEnvelopeSchema>;
export type ClientControlEnvelope = z.infer<typeof ClientControlEnvelopeSchema>;
export type ControlEnvelope = z.infer<typeof ControlEnvelopeSchema>;
