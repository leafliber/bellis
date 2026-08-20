import { z } from "zod";
import { DecimalStringSchema } from "../common/decimal-string.js";
import { SpanIdSchema, TraceIdSchema, UuidSchema } from "../common/ids.js";
import { JsonValueSchema, extensibleJsonObject } from "../common/json-value.js";

/**
 * Control WebSocket 的 Wire Envelope 规范形态（ADR 0001 / phase-1-build-guide.md §6.5）。
 *
 * - 微秒时间、序号、ACK 与水位使用非负十进制字符串，进入 Runtime 后再无损转 bigint。
 * - direction 是判别字段：只有服务端 Envelope 包含 seq；只有客户端 Envelope
 *   可以包含累计 ack 与业务 idempotencyKey。禁止用 seq: "0" 伪装方向。
 * - messageId 用于消息去重，seq/ack 用于服务端消息排序与累计确认，三者不能互换。
 * - payload 必须是 JSON 值（JsonValueSchema），保证校验通过即可 JSON 序列化。
 *
 * 语义等价策略（与 ADR 0001 §4 的双 dialect Fixture 一致性要求配套）：
 * - 本 Schema 是严格闭合对象（strictObject）。Zod 4 的 toJSONSchema 会把
 *   plain z.object 与 strictObject 都输出为 additionalProperties:false，
 *   因此只有 strictObject 的「拒绝未知字段」语义能与生成的 JSON Schema 对齐；
 *   Envelope 的方向约束（服务端不得携带幂等字段、客户端不得伪造 seq）正是
 *   依靠闭合结构在 Zod 与 JSON Schema 两种校验器下同时成立，不使用
 *   无法映射到 JSON Schema 的跨字段 refine。
 * - 可前向扩展的消息 Payload 与领域对象使用 extensibleJsonObject：未知
 *   扩展键以 JsonValueSchema 作为 catch-all（common/json-value.ts），
 *   在 Zod 与生成的 JSON Schema 两种校验器下同样保证
 *   「校验通过 ⇔ 可无损 JSON 序列化」。
 */

export const CONTROL_PROTOCOL_VERSION = 1;

export const EnvelopeTraceSchema = extensibleJsonObject({
  traceId: TraceIdSchema,
  spanId: SpanIdSchema.optional(),
});

/**
 * 消息 type 允许小写点分segments，也允许单段（如 "error"）。
 * P1 期间发现的缺陷修正：原模式 `(?:\.[a-z][a-z0-9]*)+` 要求至少一个点号，
 * 导致 KNOWN_CONTROL_MESSAGE_TYPES 中已冻结的 "error" 类型永远无法通过
 * Envelope 校验（ControlPayloadSchema 与 Fixture 均已把 type: "error"
 * 视为合法）。放宽为 `*` 是纯扩展（原合法值全部保持合法），
 * 变更已同步双 dialect 生成物、Fixture 与 ADR 0001 修订记录。
 */
export const CONTROL_MESSAGE_TYPE_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)*$/;

/** Envelope 基础字段：单一来源，供 server/client 两个方向共享。 */
const controlEnvelopeBaseShape = {
  version: z.literal(CONTROL_PROTOCOL_VERSION),
  type: z.string().regex(CONTROL_MESSAGE_TYPE_PATTERN, {
    message: 'message type must be lowercase dot-separated segments, e.g. "clock.ping" or "error"',
  }),
  messageId: UuidSchema,
  sessionId: UuidSchema,
  trace: EnvelopeTraceSchema,
  sentAtUs: DecimalStringSchema,
  deadlineUs: DecimalStringSchema.optional(),
  payload: JsonValueSchema,
} as const;

export const ServerControlEnvelopeSchema = z.strictObject({
  ...controlEnvelopeBaseShape,
  direction: z.literal("server"),
  /** 服务端消息序号：每个逻辑 Session 严格递增的非负十进制字符串。 */
  seq: DecimalStringSchema,
});

export const ClientControlEnvelopeSchema = z.strictObject({
  ...controlEnvelopeBaseShape,
  direction: z.literal("client"),
  /** 客户端已处理的最大连续服务端序号（累计确认）。 */
  ack: DecimalStringSchema.optional(),
  /** 会改变持久状态的请求必须携带的业务幂等键。 */
  idempotencyKey: z.string().min(1).max(128).optional(),
});

export const ControlEnvelopeSchema = z.discriminatedUnion("direction", [
  ServerControlEnvelopeSchema,
  ClientControlEnvelopeSchema,
]);

/** 用具体 Payload Schema 组装服务端 Envelope（供 P1 Transport 使用）。 */
export function createServerControlEnvelopeSchema<P extends z.ZodType>(payloadSchema: P) {
  return z.strictObject({
    ...controlEnvelopeBaseShape,
    direction: z.literal("server"),
    seq: DecimalStringSchema,
    payload: payloadSchema,
  });
}

/** 用具体 Payload Schema 组装客户端 Envelope（供 P1 Transport 使用）。 */
export function createClientControlEnvelopeSchema<P extends z.ZodType>(payloadSchema: P) {
  return z.strictObject({
    ...controlEnvelopeBaseShape,
    direction: z.literal("client"),
    ack: DecimalStringSchema.optional(),
    idempotencyKey: z.string().min(1).max(128).optional(),
    payload: payloadSchema,
  });
}

export type EnvelopeTrace = z.infer<typeof EnvelopeTraceSchema>;
export type ServerControlEnvelope = z.infer<typeof ServerControlEnvelopeSchema>;
export type ClientControlEnvelope = z.infer<typeof ClientControlEnvelopeSchema>;
export type ControlEnvelope = z.infer<typeof ControlEnvelopeSchema>;
