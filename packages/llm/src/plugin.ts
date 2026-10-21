import { type Llm, LlmError, LlmService } from '@bellis/director';
import {
  ClockService,
  DeadlineError,
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
  type ChatRequest,
  type ChatSettings,
  OUTPUT_MODES,
  REASONING_EFFORTS,
  THINKING,
} from './client.ts';
import { type FailureFacts, LlmHealth } from './health.ts';

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
  /**
   * 连续失败达到这么多次就报告未就绪（直到下一次成功）；缺省与决策插件的 `alarmAfter` 缺省相同。
   * 鉴权失败一次就未就绪。
   */
  unreadyAfter: Type.Integer({ minimum: 1, default: 3 }),
  /**
   * 开播预检时发一个最小的探测请求（固定的极短提示词），确认能拿到合法响应。会外发、会计费；缺省不发，
   * 预检只按最近的调用判定就绪。
   */
  probeOnPreflight: Type.Boolean({ default: false }),
  /** 探测的截止时间（含思考与全部输出）；上限低于操作员命令行等预检结果的时限。 */
  probeTimeoutMs: Type.Integer({ minimum: 1, maximum: 20_000, default: 10_000 }),
});
export type LlmOpenAiConfig = Static<typeof LlmOpenAiConfig>;

/**
 * 开播预检的探测请求：固定的极短提示词，不含人设、上下文与任何观众输入。应答须正常结束、正文是一个 JSON 对象。
 */
export const PROBE_REQUEST: ChatRequest = {
  messages: [
    {
      role: 'system',
      content: '这是连通性检查。只输出 JSON 对象 {"ok":true}，不要输出任何别的内容。',
    },
    { role: 'user', content: '检查' },
  ],
  output: {
    name: 'probe',
    description: '连通性检查的应答',
    schema: {
      type: 'object',
      properties: { ok: { type: 'boolean' } },
      required: ['ok'],
      additionalProperties: false,
    },
  },
};

function isJsonObject(text: string): boolean {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}

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
 * - 就绪报告（见 health.ts）只看最近的调用，不为它发请求；`probeOnPreflight` 打开时另提供开播预检的探测
 *   （固定的极短请求，会外发、会计费）。
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
    const clock = ctx.service(ClockService);
    const client = new ChatClient({
      settings: chatSettings(config),
      limits: chatLimits(config),
      apiKey,
      clock,
    });
    const health = new LlmHealth(config.unreadyAfter);
    /** 只记类别、HTTP 状态与错误码。 */
    const facts = (failure: FailureFacts) => ({
      kind: failure.kind,
      ...(failure.status === undefined ? {} : { status: failure.status }),
      ...(failure.code === undefined ? {} : { code: failure.code }),
    });

    /** 开播预检的探测：固定的极短请求，带截止时间；结果计入就绪判定。 */
    const probe = async (): Promise<void> => {
      const deadline = new AbortController();
      const timer = clock.setTimeout(() => deadline.abort(), config.probeTimeoutMs);
      try {
        const result = await client.complete(
          PROBE_REQUEST,
          AbortSignal.any([deadline.signal, ctx.signal]),
        );
        if (!isJsonObject(result.output))
          throw new LlmError('protocol', '探测的应答不是 JSON 对象');
        health.succeeded();
        ctx.log('llm.probe', { ok: true });
      } catch (error) {
        let failure = error instanceof LlmError ? error : new LlmError('protocol', '探测失败');
        if (failure.kind === 'aborted' && deadline.signal.aborted && !ctx.signal.aborted) {
          failure = new LlmError('timeout', `探测未在 ${config.probeTimeoutMs}ms 内完成`);
        }
        health.failed(failure);
        ctx.log('llm.probe', { ok: false, ...facts(failure) });
        throw failure;
      } finally {
        clock.clearTimeout(timer);
      }
    };

    const llm: Llm = {
      model: { provider: config.provider, name: config.model },
      async complete(request, signal, options) {
        try {
          const result = await client.complete(
            { messages: request.messages, output: request.output },
            AbortSignal.any([signal, ctx.signal]),
            options ?? {},
          );
          health.succeeded();
          return result.output;
        } catch (error) {
          if (error instanceof LlmError && error.kind !== 'aborted') {
            ctx.log('llm.failed', facts(error));
            health.failed(error);
          } else if (signal.reason instanceof DeadlineError && !ctx.signal.aborted) {
            // 调用方的截止时间到点：对调用方是超时，计入就绪判定。
            ctx.log('llm.failed', { kind: 'timeout', deadline: true });
            health.failed({ kind: 'timeout' });
          }
          // 其余取消是调用方的决定，不算失败。
          throw error;
        }
      },
      get ready() {
        return health.ready && !ctx.signal.aborted;
      },
      get status() {
        return health.status;
      },
      get failures() {
        return health.failures;
      },
      ...(config.probeOnPreflight ? { probe } : {}),
    };
    ctx.provide(LlmService, llm);
  },
});
