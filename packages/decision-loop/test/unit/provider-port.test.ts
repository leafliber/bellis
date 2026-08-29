import { describe, expect, it } from "vitest";
import type { ModelProvider, ModelRequest, ModelStreamEvent } from "../../src/index.js";

/**
 * P0 Port 草案的可编译性冒烟：脚本化 Provider 以最小事件序列实现 Port。
 * 行为语义（至多一个 final 等）由 P2 Stream Assembler 测试证明。
 */
function scriptedProvider(events: readonly ModelStreamEvent[]): ModelProvider {
  return {
    name: "scripted",
    async *streamDecision(request: ModelRequest, signal: AbortSignal) {
      expect(request.cycleId.length).toBeGreaterThan(0);
      expect(signal.aborted).toBe(false);
      for (const event of events) {
        yield event;
      }
    },
  };
}

describe("ModelProvider port draft", () => {
  it("streams a minimal valid event sequence", async () => {
    const provider = scriptedProvider([
      { type: "started" },
      { type: "speech", delta: "我查一下" },
      { type: "next", next: "finish" },
      { type: "final" },
    ]);
    const request: ModelRequest = {
      requestId: "req-1",
      cycleId: "33333333-3333-4333-8333-333333333333",
      provider: "scripted",
      model: "demo",
      instructions: "你是主播",
      prompt: "观众:你好",
      tools: [],
      metadata: { turnId: "22222222-2222-4222-8222-222222222222", cycleIndex: 0 },
    };
    const collected: string[] = [];
    for await (const event of provider.streamDecision(request, new AbortController().signal)) {
      collected.push(event.type);
    }
    expect(collected).toEqual(["started", "speech", "next", "final"]);
  });
});
