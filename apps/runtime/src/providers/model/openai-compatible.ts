import { randomUUID } from "node:crypto";
import type { ModelProvider, ModelRequest, ModelStreamEvent } from "@bellis/decision-loop";

/**
 * OpenAI-compatible Chat Completions 适配器
 * （phase-3-development-guide.md §7.1 / ADR 0004 §5）。
 *
 * - Node 26 原生 fetch + AbortController（SSE 流式读取），不引入第三方
 *   LLM SDK——SDK 事件类型不得进入核心契约；
 * - 只做传输与规范化：delta.content → speech；delta.tool_calls →
 *   tool_call_start/args/end（toolRunId 本地生成）；usage chunk → usage；
 *   流正常结束 → next（有工具调用 → after_tools，否则 finish）+ final；
 * - Provider 错误 → 单个 error 事件（随后流结束 → Assembler 判失败 →
 *   Loop 确定性降级）；绝不自行发起第二次请求；
 * - API Key 只经 Credential 注入，不进入日志/Prompt/错误正文。
 */
export interface OpenAICompatibleOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  /** 有界请求体（字节）；默认 256 KiB。 */
  readonly maxBodyBytes?: number;
  readonly fetchImpl?: typeof fetch;
}

interface ChatStreamDelta {
  readonly content?: string;
  readonly tool_calls?: readonly {
    readonly index?: number;
    readonly id?: string;
    readonly function?: { readonly name?: string; readonly arguments?: string };
  }[];
}

interface ChatChunk {
  readonly choices?: readonly {
    readonly delta?: ChatStreamDelta;
    readonly finish_reason?: string | null;
  }[];
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
    readonly prompt_tokens_details?: { readonly cached_tokens?: number };
  } | null;
}

export class OpenAICompatibleAdapter implements ModelProvider {
  readonly name: string;
  readonly #options: OpenAICompatibleOptions;

  constructor(name: string, options: OpenAICompatibleOptions) {
    this.name = name;
    this.#options = options;
  }

  async *streamDecision(
    request: ModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelStreamEvent> {
    const doFetch = this.#options.fetchImpl ?? fetch;
    const body = JSON.stringify({
      model: this.#options.model,
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        { role: "system", content: request.instructions },
        { role: "user", content: request.prompt },
      ],
      ...(request.tools.length === 0
        ? {}
        : {
            tools: request.tools.map((tool) => ({
              type: "function" as const,
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parametersSchema,
              },
            })),
          }),
      ...(request.maxOutputTokens === undefined ? {} : { max_tokens: request.maxOutputTokens }),
    });
    if (body.length > (this.#options.maxBodyBytes ?? 262_144)) {
      yield {
        type: "error",
        code: "request_too_large",
        message: "assembled model request exceeds bounded body size",
        retryable: false,
      };
      return;
    }
    let response: Response;
    try {
      response = await doFetch(`${this.#options.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.#options.apiKey}`,
          accept: "text/event-stream",
        },
        body,
        signal,
      });
    } catch (error) {
      yield {
        type: "error",
        code: signal.aborted ? "aborted" : "network_error",
        message: error instanceof Error ? error.constructor.name : "network error",
        retryable: !signal.aborted,
      };
      return;
    }
    if (!response.ok || response.body === null) {
      yield {
        type: "error",
        code: `http_${response.status}`,
        message:
          response.status === 403 || response.status === 451
            ? "content_policy"
            : "provider_rejected",
        retryable: response.status >= 500,
      };
      return;
    }
    yield { type: "started" };
    const startedToolRuns = new Map<number, string>();
    const completed = new Set<string>();
    let sawToolCall = false;
    let speechClosed = false;
    let usage: ModelStreamEvent | null = null;
    const decoder = new TextDecoder();
    let buffer = "";
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex !== -1) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          newlineIndex = buffer.indexOf("\n");
          if (!line.startsWith("data:")) {
            continue;
          }
          const data = line.slice(5).trim();
          if (data === "[DONE]") {
            continue;
          }
          let chunk: ChatChunk;
          try {
            chunk = JSON.parse(data) as ChatChunk;
          } catch {
            continue;
          }
          const choice = chunk.choices?.[0];
          const delta = choice?.delta;
          if (delta?.content !== undefined && delta.content !== "") {
            if (!speechClosed) {
              yield { type: "speech", delta: delta.content };
            }
          }
          if (delta?.tool_calls !== undefined) {
            sawToolCall = true;
            speechClosed = true;
            for (const toolCall of delta.tool_calls) {
              const slot = toolCall.index ?? 0;
              let toolRunId = startedToolRuns.get(slot);
              if (toolRunId === undefined) {
                toolRunId = randomUUID();
                startedToolRuns.set(slot, toolRunId);
                yield {
                  type: "tool_call_start",
                  toolRunId,
                  toolName: toolCall.function?.name ?? "",
                };
              }
              const argsDelta = toolCall.function?.arguments;
              if (argsDelta !== undefined && argsDelta !== "") {
                yield { type: "tool_args", toolRunId, delta: argsDelta };
              }
            }
          }
          if (chunk.usage !== null && chunk.usage !== undefined && usage === null) {
            usage = {
              type: "usage",
              ...(chunk.usage.prompt_tokens === undefined
                ? {}
                : { inputTokens: chunk.usage.prompt_tokens }),
              ...(chunk.usage.completion_tokens === undefined
                ? {}
                : { outputTokens: chunk.usage.completion_tokens }),
              ...(chunk.usage.prompt_tokens_details?.cached_tokens === undefined
                ? {}
                : { cachedInputTokens: chunk.usage.prompt_tokens_details.cached_tokens }),
            };
          }
        }
      }
    } catch (error) {
      if (signal.aborted) {
        throw signal.reason ?? new Error("aborted");
      }
      yield {
        type: "error",
        code: "stream_broken",
        message: error instanceof Error ? error.constructor.name : "stream error",
        retryable: true,
      };
      return;
    }
    for (const toolRunId of startedToolRuns.values()) {
      if (!completed.has(toolRunId)) {
        completed.add(toolRunId);
        yield { type: "tool_call_end", toolRunId };
      }
    }
    if (usage !== null) {
      yield usage;
    }
    yield { type: "next", next: sawToolCall ? "after_tools" : "finish" };
    yield { type: "final" };
  }
}
