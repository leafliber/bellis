import {
  CLIENT_TO_SERVER_MESSAGE_TYPES,
  CONTROL_PROTOCOL_VERSION,
  ControlEnvelopeSchema,
  ControlPayloadSchema,
  EITHER_DIRECTION_MESSAGE_TYPES,
  SERVER_TO_CLIENT_MESSAGE_TYPES,
  parseDecimalString,
} from "@bellis/contracts";
import type { ControlEnvelope } from "@bellis/contracts";
import { TransportProtocolViolationError } from "../errors.js";
import type { TransportFailure, TransportResult } from "../errors.js";

/**
 * Control 消息编解码（docs/phase-1-reference.md；ADR 0001 §2）。
 *
 * 入站解码顺序（docs/phase-1-reference.md）：
 *
 * ```text
 * 字节/文本大小限制 → JSON 解析 → ControlEnvelopeSchema
 *   → direction/type 白名单 → Payload Schema → 十进制字符串可转换性
 * ```
 *
 * - 入站输入类型是 unknown；任何失败以值返回稳定 TransportFailure，
 *   不抛出含原始 Payload、Cookie、Token 或堆栈的错误。
 * - 版本不匹配（JSON 对象携带数值 version ≠ 1）分类为 unsupported_version；
 *   其余结构失败一律 invalid_message。
 * - 出站编码对入参做同一套校验，失败抛 TransportProtocolViolationError
 *   （服务端装配缺陷，允许抛出）。
 */

/** 单条 Control 文本消息的默认字节上限（UTF-8）。 */
export const DEFAULT_MAX_CONTROL_TEXT_BYTES = 1_048_576;

export interface ControlDecodeOptions {
  readonly maxTextBytes?: number;
}

type Direction = "server" | "client";

function failure(
  code: TransportFailure["code"],
  message: string,
): TransportResult<ControlEnvelope> {
  return { ok: false, failure: { code, message } };
}

/** type 与 direction 的白名单校验（以 Contracts 导出的方向表为准）。 */
export function isDirectionAllowed(type: string, direction: Direction): boolean {
  if ((EITHER_DIRECTION_MESSAGE_TYPES as readonly string[]).includes(type)) {
    return true;
  }
  if ((SERVER_TO_CLIENT_MESSAGE_TYPES as readonly string[]).includes(type)) {
    return direction === "server";
  }
  if ((CLIENT_TO_SERVER_MESSAGE_TYPES as readonly string[]).includes(type)) {
    return direction === "client";
  }
  return false;
}

function isKnownType(type: string): boolean {
  return (
    (SERVER_TO_CLIENT_MESSAGE_TYPES as readonly string[]).includes(type) ||
    (CLIENT_TO_SERVER_MESSAGE_TYPES as readonly string[]).includes(type) ||
    (EITHER_DIRECTION_MESSAGE_TYPES as readonly string[]).includes(type)
  );
}

/** 校验已通过 Envelope Schema 的对象（解码与编码共用）。 */
function validateEnvelope(envelope: ControlEnvelope): TransportFailure | null {
  if (!isKnownType(envelope.type)) {
    return { code: "invalid_message", message: `unknown message type: ${envelope.type}` };
  }
  if (!isDirectionAllowed(envelope.type, envelope.direction)) {
    return {
      code: "invalid_message",
      message: `message type ${envelope.type} is not allowed in ${envelope.direction} direction`,
    };
  }
  // Hello 类消息的主版本不匹配优先分类为 unsupported_version
  // （docs/phase-1-reference.md：主版本不兼容时拒绝连接）。
  if (envelope.type === "client.hello" || envelope.type === "server.hello") {
    const declared = (envelope.payload as { protocolVersion?: unknown }).protocolVersion;
    if (typeof declared === "number" && declared !== CONTROL_PROTOCOL_VERSION) {
      return {
        code: "unsupported_version",
        message: `hello protocolVersion ${declared} is not supported`,
      };
    }
  }
  const payloadCheck = ControlPayloadSchema.safeParse({
    type: envelope.type,
    payload: envelope.payload,
  });
  if (!payloadCheck.success) {
    return {
      code: "invalid_message",
      message: `payload does not match schema for type ${envelope.type}`,
    };
  }
  try {
    if (envelope.direction === "server") {
      parseDecimalString(envelope.seq);
    } else if (envelope.ack !== undefined) {
      parseDecimalString(envelope.ack);
    }
    parseDecimalString(envelope.sentAtUs);
    if (envelope.deadlineUs !== undefined) {
      parseDecimalString(envelope.deadlineUs);
    }
  } catch {
    return { code: "invalid_message", message: "decimal string field is not canonical" };
  }
  return null;
}

/** 入站 Control 消息解码：unknown → 校验后的 Envelope 或稳定失败。 */
export function decodeControlMessage(
  input: unknown,
  options: ControlDecodeOptions = {},
): TransportResult<ControlEnvelope> {
  const maxTextBytes = options.maxTextBytes ?? DEFAULT_MAX_CONTROL_TEXT_BYTES;
  if (typeof input !== "string") {
    return failure("invalid_message", "control message must be UTF-8 text");
  }
  if (Buffer.byteLength(input, "utf8") > maxTextBytes) {
    return failure("invalid_message", "control message exceeds the text size limit");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return failure("invalid_message", "control message is not valid JSON");
  }
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "version" in parsed &&
    typeof (parsed as { version: unknown }).version === "number" &&
    (parsed as { version: unknown }).version !== CONTROL_PROTOCOL_VERSION
  ) {
    return failure(
      "unsupported_version",
      `unsupported control protocol version ${(parsed as { version: unknown }).version}`,
    );
  }
  const envelopeCheck = ControlEnvelopeSchema.safeParse(parsed);
  if (!envelopeCheck.success) {
    return failure("invalid_message", "control envelope does not match schema");
  }
  const envelope = envelopeCheck.data;
  const violation = validateEnvelope(envelope);
  if (violation !== null) {
    return { ok: false, failure: violation };
  }
  return { ok: true, value: envelope };
}

/** 出站 Control 消息编码：同一套校验后序列化为 JSON 文本。 */
export function encodeControlMessage(envelope: ControlEnvelope): string {
  const envelopeCheck = ControlEnvelopeSchema.safeParse(envelope);
  if (!envelopeCheck.success) {
    throw new TransportProtocolViolationError(
      "invalid_message",
      "outbound control envelope does not match schema",
    );
  }
  const violation = validateEnvelope(envelopeCheck.data);
  if (violation !== null) {
    throw new TransportProtocolViolationError(violation.code, violation.message);
  }
  return JSON.stringify(envelopeCheck.data);
}
