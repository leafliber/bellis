import { LlmError, LlmService } from '@bellis/director';
import {
  ClockService,
  definePlugin,
  egressAllowed,
  egressPermission,
  SecretsService,
  secretPermission,
} from '@bellis/kernel';
import Type, { type Static } from 'typebox';
import {
  ChatClient,
  type ChatLimits,
  type ChatSettings,
  OUTPUT_MODES,
  REASONING_EFFORTS,
  THINKING,
} from './client.ts';

/** 火山方舟（中国大陆，北京）的 Chat Completions 端点。清单按这个主机申请外发；改用别的端点须另行授予该主机。 */
export const ARK_CHAT_ENDPOINT = 'https://ark.cn-beijing.volces.com/api/v3/chat/completions';
/** 凭据条目：方舟的 API Key。 */
export const ARK_SECRET = 'ark';
/**
 * 遥测的 `gen_ai.provider.name`：GenAI 约定的已知取值里没有火山方舟，按约定用自定义值，
 * 取“厂商.服务”的写法。
 */
export const ARK_PROVIDER = 'volcengine.ark';

/** 本机回环地址：只有这些主机可以不加密（本机测试用）。 */
const LOOPBACK = new Set(['127.0.0.1', '[::1]', 'localhost']);

const literals = <T extends string>(values: readonly T[]) =>
  Type.Union(values.map((value) => Type.Literal(value)));

export const LlmOpenAiConfig = Type.Object({
  /** Chat Completions 的完整地址；须为 https://（本机回环除外），主机须已授予外发。 */
  endpoint: Type.String({ default: ARK_CHAT_ENDPOINT }),
  /** 型号（方舟上为 Model ID），不是机密；空串表示未配置。 */
  model: Type.String({ default: '' }),
  /** 遥测的 `gen_ai.provider.name`（可打印 ASCII）。 */
  provider: Type.String({
    minLength: 1,
    maxLength: 64,
    pattern: '^[!-~]+$',
    default: ARK_PROVIDER,
  }),
  /**
   * 意图的输出方式：`json_schema`（严格的结构化输出）、`json_object`、`tool`（单个函数，`tool_choice` 指定它）、
   * `prompt`（只在提示词里要求 JSON）。没有缺省值：S-11 之后再定。
   */
  outputMode: literals(OUTPUT_MODES),
  /** 思考开关 `thinking.type`；不配置就不发。 */
  thinking: Type.Optional(literals(THINKING)),
  /** 思考档位 `reasoning_effort`；不配置就不发。 */
  reasoningEffort: Type.Optional(literals(REASONING_EFFORTS)),
  /** 不配置就不发。 */
  temperature: Type.Optional(Type.Number({ minimum: 0, maximum: 2 })),
  /** `max_tokens`；不配置就不发。 */
  maxTokens: Type.Optional(Type.Integer({ minimum: 1 })),
  connectTimeoutMs: Type.Integer({ minimum: 1, default: 5_000 }),
  firstChunkTimeoutMs: Type.Integer({ minimum: 1, default: 8_000 }),
  stallTimeoutMs: Type.Integer({ minimum: 1, default: 5_000 }),
  maxEventChars: Type.Integer({ minimum: 1024, default: 65_536 }),
  maxOutputChars: Type.Integer({ minimum: 256, default: 8_192 }),
});
export type LlmOpenAiConfig = Static<typeof LlmOpenAiConfig>;

/** 端点为什么不能连；能连时返回 undefined。须为 https://（本机回环除外），主机已授予外发。 */
export function endpointBlocker(
  endpoint: string,
  permissions: ReadonlySet<string>,
): string | undefined {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return '端点地址不合法';
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) {
    return '端点须为 https://（本机测试除外）';
  }
  if (url.username !== '' || url.password !== '') return '端点地址不能带用户名与密码';
  if (!egressAllowed(url.hostname, permissions)) {
    return `未授予权限 ${egressPermission(url.hostname)}`;
  }
  return undefined;
}

/** 配置为什么不能用（不连接任何端点就能判断的部分）；能用时返回 undefined。 */
export function configBlocker(
  config: LlmOpenAiConfig,
  permissions: ReadonlySet<string>,
): string | undefined {
  if (config.model.trim() === '') return '未配置型号（model）';
  return endpointBlocker(config.endpoint, permissions);
}

export function chatSettings(config: LlmOpenAiConfig): ChatSettings {
  return {
    endpoint: config.endpoint,
    model: config.model,
    outputMode: config.outputMode,
    thinking: config.thinking,
    reasoningEffort: config.reasoningEffort,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
  };
}

export function chatLimits(config: LlmOpenAiConfig): ChatLimits {
  return {
    connectTimeoutMs: config.connectTimeoutMs,
    firstChunkTimeoutMs: config.firstChunkTimeoutMs,
    stallTimeoutMs: config.stallTimeoutMs,
    maxEventChars: config.maxEventChars,
    maxOutputChars: config.maxOutputChars,
  };
}

const HINT = '维护者用 pnpm secret set ark 录入方舟的 API Key';

/**
 * 模型客户端（R-17），提供 `llm@1`：OpenAI 兼容的 Chat Completions，流式读取（见 client.ts）。
 * 只负责收发的接入插件：只持有 `secret:ark` 与外发许可 `net.egress:ark.cn-beijing.volces.com`；
 * 收发的内容只当数据转交，不解析成指令，意图的解析与校验在决策插件里。
 *
 * - 激活时核对配置（型号、端点是 https 且主机已授予外发）与凭据，缺了就以说明原因的错误失败，不连任何端点。
 * - 端点、型号、思考开关与档位、输出方式、温度与 `max_tokens` 都来自配置，没有配置的字段不发；换型号只改配置。
 * - 不做隐式重试；调用方的中止信号或本插件停用即中止 fetch。
 * - API Key 只用于请求头，不写日志、不进事件与错误说明；思考内容一律丢弃。失败只记类别、HTTP 状态与错误码。
 */
export const llmOpenAi = definePlugin({
  manifest: {
    id: 'llm-openai',
    version: '0.1.0',
    tier: 'ordinary',
    provides: [LlmService.ref],
    inject: [ClockService.ref, SecretsService.ref],
    permissions: [
      egressPermission(new URL(ARK_CHAT_ENDPOINT).hostname),
      secretPermission(ARK_SECRET),
    ],
    process: 'in-process',
    config: LlmOpenAiConfig,
  },
  async activate(ctx) {
    const config = ctx.config;
    const blocker = configBlocker(config, ctx.permissions);
    if (blocker) {
      ctx.log('llm.unavailable', { reason: blocker });
      throw new Error(`模型客户端不可用：${blocker}`);
    }
    const secrets = ctx.service(SecretsService);
    let apiKey: string | undefined;
    try {
      apiKey = (await secrets.read(ARK_SECRET))?.trim();
    } catch (error) {
      const reason = `读取凭据 ${ARK_SECRET} 失败：${error instanceof Error ? error.message : error}`;
      ctx.log('llm.unavailable', { reason });
      throw new Error(`模型客户端不可用：${reason}`);
    }
    if (!apiKey) {
      const reason = `缺少凭据 ${ARK_SECRET}（${HINT}）`;
      ctx.log('llm.unavailable', { reason });
      throw new Error(`模型客户端不可用：${reason}`);
    }
    const client = new ChatClient({
      settings: chatSettings(config),
      limits: chatLimits(config),
      apiKey,
      clock: ctx.service(ClockService),
    });
    ctx.provide(LlmService, {
      model: { provider: config.provider, name: config.model },
      async complete(request, signal, options) {
        try {
          const result = await client.complete(
            { messages: request.messages, output: request.output },
            AbortSignal.any([signal, ctx.signal]),
            options ?? {},
          );
          return result.output;
        } catch (error) {
          // 取消是调用方的决定，不算失败；其余只记类别、HTTP 状态与错误码。
          if (error instanceof LlmError && error.kind !== 'aborted') {
            ctx.log('llm.failed', {
              kind: error.kind,
              ...(error.status === undefined ? {} : { status: error.status }),
              ...(error.code === undefined ? {} : { code: error.code }),
            });
          }
          throw error;
        }
      },
    });
  },
});
