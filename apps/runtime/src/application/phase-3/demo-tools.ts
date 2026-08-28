import type { MonotonicClock } from "@bellis/contracts";
import type {
  StandardToolRuntime,
  ToolDeclaration,
  ToolExecutionContext,
} from "@bellis/tool-runtime";

/**
 * Phase 3 开发/Demo 工具集（phase-3-development-guide.md §2.2/§10.2）：
 * 一方注册的确定性工具，覆盖验收场景需要的执行模式矩阵——
 * 并行只读（overlap 证据）、缓存（L1/L2 命中证据）、权限（denied 证据）、
 * 独占非幂等（幂等键 + uncertain 恢复证据）、后台任务。
 * 生产平台插件不在本阶段范围。
 */

export interface DemoToolState {
  /** lookup_quest 的固定结果（第 1 次执行后缓存）。 */
  questResult: { quest: string; chapter: number; progress: number } | null;
  giftCalls: { key: string | null }[];
  auditLog: string[];
}

export function createDemoToolState(): DemoToolState {
  return { questResult: null, giftCalls: [], auditLog: [] };
}

const QUEST_DECLARATION: ToolDeclaration = {
  name: "lookup_quest",
  version: 1,
  description: "查询当前游戏任务进度（只读）。",
  inputSchema: {
    type: "object",
    properties: { quest: { type: "string" } },
    additionalProperties: false,
  },
  outputMaxBytes: 2_048,
  sensitiveOutputFields: [],
  executionMode: "parallel_read",
  semantic: "pure",
  resource: null,
  keyArgument: null,
  timeoutMs: 2_000,
  cancellable: true,
  maxConcurrency: 4,
  requiredCapabilities: [],
  requiresConfirmation: false,
  cache: { l1: true, l2: true, ttlMs: 120_000, revision: "demo-v1" },
};

const STAGE_DECLARATION: ToolDeclaration = {
  name: "read_stage",
  version: 1,
  description: "读取当前舞台状态摘要（只读）。",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  outputMaxBytes: 2_048,
  sensitiveOutputFields: [],
  executionMode: "parallel_read",
  semantic: "pure",
  resource: null,
  keyArgument: null,
  timeoutMs: 2_000,
  cancellable: true,
  maxConcurrency: 4,
  requiredCapabilities: [],
  requiresConfirmation: false,
  cache: { l1: true, l2: false, ttlMs: 60_000, revision: "demo-v1" },
};

const PLAYER_DECLARATION: ToolDeclaration = {
  name: "read_player",
  version: 1,
  description: "按键读取指定玩家资料（同键串行）。",
  inputSchema: {
    type: "object",
    properties: { playerId: { type: "string", minLength: 1 } },
    required: ["playerId"],
    additionalProperties: false,
  },
  outputMaxBytes: 2_048,
  sensitiveOutputFields: ["token"],
  executionMode: "keyed",
  semantic: "pure",
  resource: null,
  keyArgument: "playerId",
  timeoutMs: 2_000,
  cancellable: true,
  maxConcurrency: 4,
  requiredCapabilities: [],
  requiresConfirmation: false,
  cache: { l1: true, l2: false, ttlMs: 60_000, revision: "demo-v1" },
};

const GIFT_DECLARATION: ToolDeclaration = {
  name: "send_gift",
  version: 1,
  description: "发送礼物（非幂等外部副作用；需要 gift.send 能力与幂等键）。",
  inputSchema: {
    type: "object",
    properties: { gift: { type: "string", minLength: 1 } },
    required: ["gift"],
    additionalProperties: false,
  },
  outputMaxBytes: 1_024,
  sensitiveOutputFields: [],
  executionMode: "exclusive",
  semantic: "non_idempotent",
  resource: "gift-api",
  keyArgument: null,
  timeoutMs: 3_000,
  cancellable: false,
  maxConcurrency: 1,
  requiredCapabilities: ["gift.send"],
  requiresConfirmation: false,
  cache: null,
};

const MEMORY_DECLARATION: ToolDeclaration = {
  name: "log_memory",
  version: 1,
  description: "后台记录审计事实（不阻塞回答）。",
  inputSchema: {
    type: "object",
    properties: { note: { type: "string" } },
    additionalProperties: false,
  },
  outputMaxBytes: 512,
  sensitiveOutputFields: [],
  executionMode: "background",
  semantic: "idempotent",
  resource: null,
  keyArgument: null,
  timeoutMs: 5_000,
  cancellable: true,
  maxConcurrency: 2,
  requiredCapabilities: [],
  requiresConfirmation: false,
  cache: null,
};

/** 需要确认的工具：Phase 3 无交互装配 → fail closed 证据。 */
const CONFIRM_DECLARATION: ToolDeclaration = {
  name: "reset_stage",
  version: 1,
  description: "重置舞台布局（高风险，需要人工确认）。",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  outputMaxBytes: 512,
  sensitiveOutputFields: [],
  executionMode: "exclusive",
  semantic: "idempotent",
  resource: "stage-layout",
  keyArgument: null,
  timeoutMs: 3_000,
  cancellable: true,
  maxConcurrency: 1,
  requiredCapabilities: [],
  requiresConfirmation: true,
  cache: null,
};

export function registerDemoTools(
  runtime: StandardToolRuntime,
  options: {
    readonly state: DemoToolState;
    readonly clock: MonotonicClock;
    readonly durationUs?: bigint;
  },
): void {
  const durationUs = options.durationUs ?? 120_000n;
  const delay = async (input: { context: ToolExecutionContext }) => {
    await options.clock.sleepUntil(options.clock.nowUs() + durationUs, input.context.signal);
  };
  runtime.registerTool(QUEST_DECLARATION, async (input) => {
    await delay(input);
    options.state.questResult = { quest: "main", chapter: 3, progress: 55 };
    return { value: options.state.questResult };
  });
  runtime.registerTool(STAGE_DECLARATION, async (input) => {
    await delay(input);
    return { value: { lanes: ["audio", "subtitle", "avatar"], activeCues: 3 } };
  });
  runtime.registerTool(PLAYER_DECLARATION, async (input) => {
    await delay(input);
    return {
      value: {
        playerId: String(input.arguments.playerId),
        level: 42,
        token: "sk-secret-must-be-redacted",
      },
    };
  });
  runtime.registerTool(GIFT_DECLARATION, async (input) => {
    options.state.giftCalls.push({ key: input.idempotencyKey });
    return { value: { delivered: true, gift: String(input.arguments.gift) } };
  });
  runtime.registerTool(MEMORY_DECLARATION, async (input) => {
    options.state.auditLog.push(String(input.arguments.note ?? ""));
    return { value: { logged: true } };
  });
  runtime.registerTool(CONFIRM_DECLARATION, async () => {
    // 无确认 Port 时永远到不了这里（fail closed 在权限门拒绝）。
    return { value: { reset: true } };
  });
}
