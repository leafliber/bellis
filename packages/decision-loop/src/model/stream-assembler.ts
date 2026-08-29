import { DecisionPacketSchema } from "@bellis/contracts";
import type { AvatarIntent, DecisionPacket, ToolCall } from "@bellis/contracts";
import type { ModelStreamEvent, ModelToolSpec } from "./provider.js";

/**
 * Stream Assembler（phase-3-development-guide.md §7.2 / ADR 0004 §5）。
 *
 * 每个模型请求一个 Assembler：把 Port 事件流组装为唯一规范
 * DecisionPacket，或产生确定性失败（→ 本地降级，不发起修复请求）。
 *
 * 强制规则：
 * - started/speech_meta/usage/next 各至多一次；next 必须出现；
 * - final 恰好一次且为最后一个事件（final 后 delta、重复 final 失败）；
 * - error 事件后流必须结束（无 final）→ Provider 失败；
 * - 工具参数在完整 JSON、名称存在、Schema 校验通过后才成为候选调用；
 * - 组装结果再次通过 DecisionPacketSchema（运行期 Schema + 交叉规则
 *   的第一道）；cycleId 来自请求（不匹配即失败）；
 * - 无 speech/avatar → 显式 noOp 帧（模型的「不行动」选择）。
 */
export type AssemblerErrorCode =
  | "duplicate_started"
  | "duplicate_speech_meta"
  | "duplicate_usage"
  | "duplicate_next"
  | "duplicate_final"
  | "event_after_final"
  | "missing_final"
  | "error_event"
  | "missing_next"
  | "unknown_tool"
  | "duplicate_tool_run_id"
  | "tool_args_without_start"
  | "tool_call_end_without_start"
  | "invalid_tool_args_json"
  | "tool_args_schema_rejected"
  | "tool_call_incomplete"
  | "too_many_tool_calls"
  | "invalid_packet"
  | "unknown_event";

export interface AssemblerError {
  readonly code: AssemblerErrorCode;
  readonly detail: string;
}

export interface ModelUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedInputTokens?: number;
}

export type AssemblerOutcome =
  | {
      readonly ok: true;
      readonly packet: DecisionPacket;
      readonly usage: ModelUsage;
      /** Provider 已给出但被丢弃的无效片段计数（脱敏遥测）。 */
      readonly discardedFragments: number;
    }
  | { readonly ok: false; readonly error: AssemblerError };

export type ToolArgumentValidator = (
  toolName: string,
  args: Record<string, unknown>,
) => { readonly ok: true } | { readonly ok: false; readonly error: string };

export interface AssemblerOptions {
  readonly cycleId: string;
  readonly tools: readonly ModelToolSpec[];
  readonly validateArguments?: ToolArgumentValidator;
  readonly maxToolCalls: number;
}

interface PendingToolCall {
  readonly toolRunId: string;
  readonly toolName: string;
  readonly idempotencyKey?: string;
  args: string;
  ended: boolean;
}

export class StreamAssembler {
  readonly #cycleId: string;
  readonly #toolNames: ReadonlySet<string>;
  readonly #validate: ToolArgumentValidator | null;
  readonly #maxToolCalls: number;
  #started = false;
  #final = false;
  #error: AssemblerError | null = null;
  #speechText = "";
  #speechMeta: {
    purpose: "answer" | "tool_notice" | "aside" | "reaction";
    interruptible: boolean;
    emotion?: string;
  } | null = null;
  #avatars: AvatarIntent[] = [];
  #toolCalls: PendingToolCall[] = [];
  readonly #toolCallIds = new Set<string>();
  #usage: ModelUsage = EMPTY_USAGE_MARKER;
  #next: "finish" | "after_tools" | "continue" | null = null;
  #discardedFragments = 0;

  constructor(options: AssemblerOptions) {
    this.#cycleId = options.cycleId;
    this.#toolNames = new Set(options.tools.map((tool) => tool.name));
    this.#validate = options.validateArguments === undefined ? null : options.validateArguments;
    this.#maxToolCalls = options.maxToolCalls;
  }

  /** 逐事件投递；返回 false 表示已失败（调用方应停止但继续耗尽流）。 */
  push(event: ModelStreamEvent): boolean {
    if (this.#error !== null) {
      this.#discardedFragments += 1;
      return false;
    }
    if (this.#final) {
      this.#fail("event_after_final", `event ${event.type} after final`);
      return false;
    }
    switch (event.type) {
      case "started":
        if (this.#started) {
          this.#fail("duplicate_started", "started emitted twice");
          return false;
        }
        this.#started = true;
        return true;
      case "speech":
        this.#speechText += event.delta;
        return true;
      case "speech_meta": {
        if (this.#speechMeta !== null) {
          this.#fail("duplicate_speech_meta", "speech_meta emitted twice");
          return false;
        }
        this.#speechMeta = {
          purpose: event.purpose,
          interruptible: event.interruptible,
          ...(event.emotion === undefined ? {} : { emotion: event.emotion }),
        };
        return true;
      }
      case "avatar":
        this.#avatars.push(event.intent);
        return true;
      case "tool_call_start": {
        if (this.#toolCallIds.has(event.toolRunId)) {
          this.#fail("duplicate_tool_run_id", `toolRunId ${event.toolRunId} reused`);
          return false;
        }
        if (!this.#toolNames.has(event.toolName)) {
          this.#fail("unknown_tool", `tool ${event.toolName} not in request`);
          return false;
        }
        if (this.#toolCalls.length >= this.#maxToolCalls) {
          this.#fail("too_many_tool_calls", `more than ${this.#maxToolCalls} tool calls`);
          return false;
        }
        this.#toolCallIds.add(event.toolRunId);
        this.#toolCalls.push({
          toolRunId: event.toolRunId,
          toolName: event.toolName,
          ...(event.idempotencyKey === undefined ? {} : { idempotencyKey: event.idempotencyKey }),
          args: "",
          ended: false,
        });
        return true;
      }
      case "tool_args": {
        const pending = this.#findPending(event.toolRunId);
        if (pending === null) {
          this.#fail("tool_args_without_start", `args for unknown ${event.toolRunId}`);
          return false;
        }
        if (pending.ended) {
          this.#fail("tool_args_without_start", `args after tool_call_end ${event.toolRunId}`);
          return false;
        }
        pending.args += event.delta;
        return true;
      }
      case "tool_call_end": {
        const pending = this.#findPending(event.toolRunId);
        if (pending === null) {
          this.#fail("tool_call_end_without_start", `end for unknown ${event.toolRunId}`);
          return false;
        }
        if (pending.ended) {
          this.#fail("tool_call_end_without_start", `double end ${event.toolRunId}`);
          return false;
        }
        pending.ended = true;
        return true;
      }
      case "usage": {
        if (this.#usage !== EMPTY_USAGE_MARKER) {
          this.#fail("duplicate_usage", "usage emitted twice");
          return false;
        }
        this.#usage = {
          ...(event.inputTokens === undefined ? {} : { inputTokens: event.inputTokens }),
          ...(event.outputTokens === undefined ? {} : { outputTokens: event.outputTokens }),
          ...(event.cachedInputTokens === undefined
            ? {}
            : { cachedInputTokens: event.cachedInputTokens }),
        };
        return true;
      }
      case "next": {
        if (this.#next !== null) {
          this.#fail("duplicate_next", "next emitted twice");
          return false;
        }
        this.#next = event.next;
        return true;
      }
      case "error":
        this.#error = { code: "error_event", detail: `${event.code}: ${event.message}` };
        return false;
      case "final":
        this.#final = true;
        return true;
      default:
        this.#fail("unknown_event", `unrecognized event type`);
        return false;
    }
  }

  /** 流结束后组装最终包；未收到 final 或规则违例 → 失败。 */
  finish(): AssemblerOutcome {
    if (this.#error !== null) {
      return { ok: false, error: this.#error };
    }
    if (!this.#final) {
      return { ok: false, error: { code: "missing_final", detail: "stream ended without final" } };
    }
    if (this.#next === null) {
      return {
        ok: false,
        error: { code: "missing_next", detail: "model did not declare next" },
      };
    }
    const toolCalls: ToolCall[] = [];
    for (const pending of this.#toolCalls) {
      if (!pending.ended) {
        return {
          ok: false,
          error: {
            code: "tool_call_incomplete",
            detail: `tool ${pending.toolRunId} has no tool_call_end`,
          },
        };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(pending.args === "" ? "{}" : pending.args) as unknown;
      } catch (cause) {
        return {
          ok: false,
          error: {
            code: "invalid_tool_args_json",
            detail: `tool ${pending.toolRunId} args are not complete JSON: ${cause instanceof Error ? cause.message : "parse error"}`,
          },
        };
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return {
          ok: false,
          error: {
            code: "invalid_tool_args_json",
            detail: `tool ${pending.toolRunId} args must be a JSON object`,
          },
        };
      }
      const record = parsed as Record<string, unknown>;
      if (this.#validate !== null) {
        const check = this.#validate(pending.toolName, record);
        if (!check.ok) {
          return {
            ok: false,
            error: {
              code: "tool_args_schema_rejected",
              detail: `tool ${pending.toolRunId}: ${check.error}`,
            },
          };
        }
      }
      toolCalls.push({
        schemaVersion: 1,
        toolRunId: pending.toolRunId,
        toolName: pending.toolName,
        // JSON.parse 产物即 JSON 值;DecisionPacketSchema 在 finish 末尾整体复核。
        arguments: record as Record<string, import("@bellis/contracts").JsonValue>,
        ...(pending.idempotencyKey === undefined ? {} : { idempotencyKey: pending.idempotencyKey }),
      });
    }
    const hasSpeech = this.#speechText.length > 0;
    const action = hasSpeech
      ? {
          schemaVersion: 1 as const,
          speech: {
            schemaVersion: 1 as const,
            text: this.#speechText,
            purpose: this.#speechMeta?.purpose ?? ("answer" as const),
            interruptible: this.#speechMeta?.interruptible ?? true,
            ...(this.#speechMeta?.emotion === undefined
              ? {}
              : { emotion: this.#speechMeta.emotion }),
          },
          ...(this.#avatars.length === 0 ? {} : { avatar: this.#avatars }),
          sync: { schemaVersion: 1 as const, hardLanes: [], softTimeoutMs: 0 },
        }
      : this.#avatars.length > 0
        ? {
            schemaVersion: 1 as const,
            avatar: this.#avatars,
            sync: { schemaVersion: 1 as const, hardLanes: [], softTimeoutMs: 0 },
          }
        : {
            schemaVersion: 1 as const,
            sync: { schemaVersion: 1 as const, hardLanes: [], softTimeoutMs: 0 },
            noOp: true as const,
          };
    const draft: DecisionPacket = {
      schemaVersion: 1,
      cycleId: this.#cycleId,
      toolCalls,
      action,
      next: this.#next,
    };
    const check = DecisionPacketSchema.safeParse(draft);
    if (!check.success) {
      return {
        ok: false,
        error: {
          code: "invalid_packet",
          detail: check.error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; "),
        },
      };
    }
    return {
      ok: true,
      packet: check.data,
      usage: this.#usage,
      discardedFragments: this.#discardedFragments,
    };
  }

  #findPending(toolRunId: string): PendingToolCall | null {
    return this.#toolCalls.find((pending) => pending.toolRunId === toolRunId) ?? null;
  }

  #fail(code: AssemblerErrorCode, detail: string): void {
    if (this.#error === null) {
      this.#error = { code, detail };
    }
  }
}

/** usage 未出现时的内部哨兵（区分「未出现」与空对象）。 */
const EMPTY_USAGE_MARKER: ModelUsage = Object.freeze({}) as ModelUsage;
