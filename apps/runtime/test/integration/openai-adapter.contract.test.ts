import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OpenAICompatibleAdapter } from "../../src/providers/model/openai-compatible.js";
import { StreamAssembler } from "@bellis/decision-loop";

/**
 * OpenAI-compatible Adapter 本地契约测试（phase-3-development-guide.md
 * §5.5/§10.1）：本地 SSE 流服务器验证传输与规范化——不依赖公网或真实
 * 账号。脚本化 Provider 与本 Adapter 共享同一 Assembler 规范化语义。
 */

interface RecordedRequest {
  readonly body: Record<string, unknown>;
  readonly authorization: string | undefined;
}

class LocalOpenAIServer {
  readonly server: Server;
  requests: RecordedRequest[] = [];
  #script: readonly string[] = [];
  #status = 200;

  constructor() {
    this.server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        this.requests.push({ body, authorization: request.headers.authorization });
        response.writeHead(this.#status, { "content-type": "text/event-stream" });
        if (this.#status !== 200) {
          response.end();
          return;
        }
        for (const event of this.#script) {
          response.write(`data: ${event}\n\n`);
        }
        response.write("data: [DONE]\n\n");
        response.end();
      });
    });
  }

  script(events: readonly unknown[], status = 200): void {
    this.#script = events.map((event) => JSON.stringify(event));
    this.#status = status;
  }

  listen(): Promise<number> {
    return new Promise((resolve) => {
      this.server.listen(0, "127.0.0.1", () => {
        resolve((this.server.address() as { port: number }).port);
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

let local: LocalOpenAIServer;
let port: number;
let adapter: OpenAICompatibleAdapter;

const TOOLS = [
  {
    name: "lookup_quest",
    description: "查询",
    parametersSchema: { type: "object", properties: { quest: { type: "string" } } },
  },
];

function collect(
  provider: OpenAICompatibleAdapter,
  signal = new AbortController().signal,
): Promise<{ events: unknown[]; error: unknown }> {
  const events: unknown[] = [];
  let error: unknown = null;
  const iterator = provider.streamDecision(
    {
      requestId: randomUUID(),
      cycleId: randomUUID(),
      provider: "openai-compatible",
      model: "test-model",
      instructions: "system",
      prompt: "user",
      tools: TOOLS,
      metadata: { turnId: randomUUID(), cycleIndex: 0 },
    },
    signal,
  );
  return (async () => {
    try {
      for await (const event of iterator) {
        events.push(event);
      }
    } catch (cause) {
      error = cause;
    }
    return { events, error };
  })();
}

beforeAll(async () => {
  local = new LocalOpenAIServer();
  port = await local.listen();
  adapter = new OpenAICompatibleAdapter("openai-test", {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: "sk-test-only",
    model: "test-model",
  });
});

afterAll(async () => {
  await local.close();
});

describe("OpenAICompatibleAdapter contract", () => {
  it("normalizes speech deltas, usage and derives next=finish", async () => {
    local.script([
      { choices: [{ delta: { content: "任务进度" } }] },
      { choices: [{ delta: { content: "已经过半" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      {
        usage: {
          prompt_tokens: 100,
          completion_tokens: 12,
          prompt_tokens_details: { cached_tokens: 8 },
        },
      },
    ]);
    const { events, error } = await collect(adapter);
    expect(error).toBeNull();
    const types = (events as { type: string }[]).map((event) => event.type);
    expect(types[0]).toBe("started");
    expect(types.filter((type) => type === "speech")).toHaveLength(2);
    expect(types.at(-2)).toBe("next");
    expect(types.at(-1)).toBe("final");
    const next = (events as { type: string; next?: string }[]).find(
      (event) => event.type === "next",
    );
    expect(next?.next).toBe("finish");
    const usage = (
      events as { type: string; inputTokens?: number; cachedInputTokens?: number }[]
    ).find((event) => event.type === "usage");
    expect(usage).toMatchObject({ inputTokens: 100, cachedInputTokens: 8 });
    // 请求映射：system/user 消息与 Draft 7 工具定义；密钥只经头注入。
    const request = local.requests.at(-1)!;
    expect(request.authorization).toBe("Bearer sk-test-only");
    expect(request.body.model).toBe("test-model");
    expect(request.body.stream).toBe(true);
    const messages = request.body.messages as { role: string; content: string }[];
    expect(messages).toEqual([
      { role: "system", content: "system" },
      { role: "user", content: "user" },
    ]);
    const tools = request.body.tools as { type: string; function: { name: string } }[];
    expect(tools[0]?.function.name).toBe("lookup_quest");
  });

  it("maps streamed tool_calls to start/args/end and derives next=after_tools", async () => {
    local.script([
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { name: "lookup_quest", arguments: '{"quest"' } }],
            },
          },
        ],
      },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"main"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ]);
    const { events } = await collect(adapter);
    const types = (events as { type: string }[]).map((event) => event.type);
    expect(types).toContain("tool_call_start");
    expect(types.filter((type) => type === "tool_args")).toHaveLength(2);
    expect(types).toContain("tool_call_end");
    const next = (events as { type: string; next?: string }[]).find(
      (event) => event.type === "next",
    );
    expect(next?.next).toBe("after_tools");
    // 端到端：Adapter 事件流直接进入 StreamAssembler 并组装为合法包。
    const assembler = new StreamAssembler({ cycleId: randomUUID(), tools: TOOLS, maxToolCalls: 8 });
    for (const event of events as never[]) {
      assembler.push(event as never);
    }
    const outcome = assembler.finish();
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.packet.toolCalls[0]?.arguments).toEqual({ quest: "main" });
      expect(outcome.packet.next).toBe("after_tools");
    }
  });

  it("maps provider HTTP rejection to a single error event (no retry)", async () => {
    local.script([], 429);
    const { events } = await collect(adapter);
    const errors = (events as { type: string; code?: string }[]).filter(
      (event) => event.type === "error",
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("http_429");
    const types = (events as { type: string }[]).map((event) => event.type);
    expect(types).not.toContain("final");
    expect(local.requests).toHaveLength(3);
  });
});
