import { defineService } from '@bellis/kernel';
import type { DirectorContext } from './prompt.ts';

/**
 * 模型服务 `llm@1` 的契约：决策插件组装好消息与意图格式交给模型客户端，客户端只负责收发（见决策模型“模型接入”）。
 * 真实模型由 `llm-openai` 提供（`packages/llm`），仿真与测试用回放模型 `llm-replay`。
 */

/** 交给模型的一条消息：系统部分（人设、规则、意图格式）与数据部分（含不可信数据区），都由确定性代码组装。 */
export interface LlmMessage {
  role: 'system' | 'user';
  content: string;
}

/**
 * 意图的输出格式。模型客户端按自己配置的输出方式使用：严格的 JSON Schema 输出、JSON 对象输出、
 * 以它为参数的单个函数，或只靠提示词（这时只用不到这里）。
 */
export interface LlmOutputFormat {
  /** schema 名兼函数名：字母、数字、下划线与连字符，至多 64 个字符。 */
  name: string;
  description: string;
  /** 严格兼容的 JSON Schema：所有字段必填、可选字段可为 null、`additionalProperties: false`。 */
  schema: Readonly<Record<string, unknown>>;
}

export interface LlmRequest {
  /** 发给模型服务的消息。 */
  messages: readonly LlmMessage[];
  /** 意图的输出格式。 */
  output: LlmOutputFormat;
  /**
   * 组装消息用的结构化上下文：`messages` 数据部分的原形。模型客户端不发送它，回放模型记下它以便测试核对
   * 上下文里有什么、没有什么。
   */
  context: DirectorContext;
  /**
   * 这次模型调用的 span（W3C traceparent），模型客户端可以在它下面记自己的 span。只用于本机遥测，
   * 不发给模型服务；不放进 `messages`（那是交给模型的内容）。没有遥测时不出现。
   */
  traceparent?: string;
}

/** 模型的标识，写进 GenAI 语义约定的属性（`gen_ai.provider.name`、`gen_ai.request.model`）。 */
export interface LlmModel {
  provider: string;
  name: string;
}

/** 一次调用用掉的 token 数与实际应答的型号（能拿到多少填多少）。 */
export interface LlmUsage {
  inputTokens?: number;
  outputTokens?: number;
  /** 输出里用于推理（思考）的 token 数。 */
  reasoningOutputTokens?: number;
  responseModel?: string;
}

/** 模型客户端在调用过程中报给决策插件的信息，只用于遥测；都可以不调用。取消之后不再调用。 */
export interface LlmCallOptions {
  /** 拿到用量（以及实际应答的型号）时调用。 */
  onUsage?(usage: LlmUsage): void;
  /** 流式调用收到第一块时调用（含只有思考内容或只有角色的块）；不流式的客户端不调用。 */
  onFirstChunk?(): void;
  /** 流式调用收到第一个正文块时调用：第一段非空的正文，或函数调用方式下第一段非空的函数参数；思考内容不算。 */
  onFirstOutput?(): void;
}

export interface Llm {
  /** 模型标识（遥测用）；不提供时按 `unknown` 记。 */
  readonly model?: LlmModel;
  /**
   * 调用一次模型，返回正文（函数调用方式下是函数参数）的字符串，由决策插件解析。不做隐式重试；
   * `signal` 中止即断开连接，以 {@link LlmError}（`aborted`）结束。
   */
  complete(request: LlmRequest, signal: AbortSignal, options?: LlmCallOptions): Promise<string>;
}

export const LlmService = defineService<Llm>('llm', 1);

/**
 * 模型调用失败的类别，也写进遥测的 `error.type`：
 * - `auth`：鉴权失败（HTTP 401、403，或流中途的鉴权错误）；
 * - `rate_limit`：限流（HTTP 429，或流中途的限流、额度错误）；
 * - `server`：服务端出错（HTTP 5xx，或流中途的其它错误）；
 * - `request`：请求被拒（其余 4xx，例如参数或输出方式不受支持）；
 * - `timeout`：连接、首块或块间停顿超时；
 * - `network`：连接失败或读取中断（拒绝连接、DNS、连接被重置）；
 * - `protocol`：返回不合约定（不是 SSE、数据块不是 JSON、超过上限、没有结束原因、没有调用指定的函数）；
 * - `incomplete`：输出没有正常结束（`finish_reason` 为 `length`、`content_filter` 等）；
 * - `aborted`：调用方取消。
 */
export type LlmErrorKind =
  | 'auth'
  | 'rate_limit'
  | 'server'
  | 'request'
  | 'timeout'
  | 'network'
  | 'protocol'
  | 'incomplete'
  | 'aborted';

/** 模型调用失败。说明里不含凭据与模型输出；服务端给的说明只留截短的摘录。 */
export class LlmError extends Error {
  readonly kind: LlmErrorKind;
  /** HTTP 状态；流中途的错误与本地判定的错误没有。 */
  readonly status: number | undefined;
  /** 服务端给的错误码（只留可打印 ASCII，至多 64 个字符）。 */
  readonly code: string | undefined;

  constructor(
    kind: LlmErrorKind,
    message: string,
    details: { status?: number; code?: string } = {},
  ) {
    super(message);
    this.name = 'LlmError';
    this.kind = kind;
    this.status = details.status;
    this.code = details.code;
  }
}
