import type { AvatarIntent } from "@bellis/contracts";
import type { ToolModelSpec } from "@bellis/tool-runtime";

/**
 * ModelProvider Port（phase-3-development-guide.md §7.1 / P0 冻结语义 4）。
 *
 * 核心只依赖异步事件流与 Abort：
 * - Provider 只做模型传输与规范化，不拥有 Cycle、重试或 Tool 调度；
 * - Provider 私有 delta、reasoning、cache metadata 与 raw body 不进入
 *   本 Port 事件——它们只能进入有界/脱敏遥测；
 * - Provider 不得启动下一 Cycle、执行 Tool、提交 Scene、修改水位，
 *   也不得在失败时偷偷发起第二次模型请求。
 *
 * 事件契约（Stream Assembler 强制）：
 * - started 至多一次；final 恰好一次且必须是最后一个事件；
 * - speech 增量只累积发言文本；speech_meta 至多一次（缺省
 *   purpose="answer"、interruptible=true）；
 * - tool 参数以字符串增量累积，tool_call_end 后才成为候选调用
 *  （完整 JSON + 名称存在 + Schema 校验）；
 * - error 是 Provider 失败信号（随后流必须结束，无 final）；
 * - next 声明模型的延续选择，缺失时最终包校验失败 → 确定性降级。
 */

/** 组装后进入模型的 Tool 规格（来自 Tool Registry）。 */
export type ModelToolSpec = ToolModelSpec;

export interface ModelRequest {
  /** 模型请求唯一身份（进入 Trace 与审计，不进入 Prompt）。 */
  readonly requestId: string;
  /** 必须与最终 DecisionPacket.cycleId 一致；不匹配即 Provider 失败。 */
  readonly cycleId: string;
  readonly provider: string;
  readonly model: string;
  /** 系统指令（Loop 拥有；Provider 原样传输）。 */
  readonly instructions: string;
  /** 有界输入块：Batch 摘要、Tool Results（标明来源与预算）等。 */
  readonly prompt: string;
  readonly tools: readonly ModelToolSpec[];
  readonly maxOutputTokens?: number;
  readonly metadata: {
    readonly turnId: string;
    readonly cycleIndex: number;
    readonly promptEpoch?: string;
    readonly contextManifestId?: string;
  };
}

export type ModelSpeechPurpose = "answer" | "tool_notice" | "aside" | "reaction";

export type ModelStreamEvent =
  | { readonly type: "started" }
  | { readonly type: "speech"; readonly delta: string }
  | {
      readonly type: "speech_meta";
      readonly purpose: ModelSpeechPurpose;
      readonly interruptible: boolean;
      readonly emotion?: string;
    }
  | { readonly type: "avatar"; readonly intent: AvatarIntent }
  | {
      readonly type: "tool_call_start";
      readonly toolRunId: string;
      readonly toolName: string;
      readonly idempotencyKey?: string;
    }
  | { readonly type: "tool_args"; readonly toolRunId: string; readonly delta: string }
  | { readonly type: "tool_call_end"; readonly toolRunId: string }
  | {
      readonly type: "usage";
      readonly inputTokens?: number;
      readonly outputTokens?: number;
      readonly cachedInputTokens?: number;
    }
  | { readonly type: "next"; readonly next: "finish" | "after_tools" | "continue" }
  | {
      readonly type: "error";
      readonly code: string;
      readonly message: string;
      readonly retryable: boolean;
    }
  | { readonly type: "final" };

/**
 * 模型传输 Port。实现（脚本化 Provider、OpenAI-compatible Adapter、
 * 本地测试服务器客户端）共享同一规范化测试套件。
 */
export interface ModelProvider {
  readonly name: string;
  streamDecision(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent>;
}
