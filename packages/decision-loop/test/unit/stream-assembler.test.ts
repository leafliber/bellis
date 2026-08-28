import { describe, expect, it } from "vitest";
import type { ModelStreamEvent, ToolArgumentValidator } from "../../src/index.js";
import { StreamAssembler } from "../../src/index.js";

const TOOLS = [{ name: "lookup_quest", description: "查询", parametersSchema: { type: "object" } }];

function assemble(events: readonly ModelStreamEvent[], validate?: ToolArgumentValidator) {
  const assembler = new StreamAssembler({
    cycleId: "33333333-3333-4333-8333-333333333333",
    tools: TOOLS,
    ...(validate === undefined ? {} : { validateArguments: validate }),
    maxToolCalls: 8,
  });
  for (const event of events) {
    if (!assembler.push(event)) {
      break;
    }
  }
  return assembler.finish();
}

const speechDelta: ModelStreamEvent = { type: "speech", delta: "我查一下任务" };
const nextFinish: ModelStreamEvent = { type: "next", next: "finish" };
const final: ModelStreamEvent = { type: "final" };

describe("StreamAssembler", () => {
  it("assembles speech + next + final into a valid packet", () => {
    const outcome = assemble([
      { type: "started" },
      speechDelta,
      { type: "speech_meta", purpose: "tool_notice", interruptible: true },
      { type: "usage", inputTokens: 100, outputTokens: 20 },
      nextFinish,
      final,
    ]);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.packet.action).toMatchObject({
        speech: { text: "我查一下任务", purpose: "tool_notice", interruptible: true },
      });
      expect(outcome.packet.next).toBe("finish");
      expect(outcome.usage.inputTokens).toBe(100);
    }
  });

  it("emits explicit noOp frame when model produces no speech/avatar", () => {
    const outcome = assemble([nextFinish, final]);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.packet.action).toMatchObject({ noOp: true });
    }
  });

  it("joins tool arg deltas into a candidate call after complete JSON", () => {
    const outcome = assemble([
      {
        type: "tool_call_start",
        toolRunId: "88888888-8888-4888-8888-888888888888",
        toolName: "lookup_quest",
      },
      { type: "tool_args", toolRunId: "88888888-8888-4888-8888-888888888888", delta: '{"quest' },
      { type: "tool_args", toolRunId: "88888888-8888-4888-8888-888888888888", delta: '":"main"}' },
      { type: "tool_call_end", toolRunId: "88888888-8888-4888-8888-888888888888" },
      { type: "next", next: "after_tools" },
      final,
    ]);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.packet.toolCalls).toHaveLength(1);
      expect(outcome.packet.toolCalls[0]?.arguments).toEqual({ quest: "main" });
    }
  });

  const invalidCases: readonly [string, readonly ModelStreamEvent[]][] = [
    ["duplicate final", [nextFinish, final, final]],
    ["event after final", [final, nextFinish]],
    ["missing final", [nextFinish]],
    ["missing next", [speechDelta, final]],
    ["error event", [{ type: "error", code: "provider_down", message: "boom", retryable: false }]],
    ["duplicate started", [{ type: "started" }, { type: "started" }, nextFinish, final]],
    [
      "duplicate speech_meta",
      [
        { type: "speech_meta", purpose: "answer", interruptible: true },
        { type: "speech_meta", purpose: "aside", interruptible: true },
        nextFinish,
        final,
      ],
    ],
    ["duplicate next", [nextFinish, { type: "next", next: "continue" }, final]],
    [
      "unknown tool",
      [
        {
          type: "tool_call_start",
          toolRunId: "88888888-8888-4888-8888-888888888888",
          toolName: "not_registered",
        },
        nextFinish,
        final,
      ],
    ],
    [
      "args without start",
      [
        { type: "tool_args", toolRunId: "88888888-8888-4888-8888-888888888888", delta: "{}" },
        nextFinish,
        final,
      ],
    ],
    [
      "incomplete JSON args",
      [
        {
          type: "tool_call_start",
          toolRunId: "88888888-8888-4888-8888-888888888888",
          toolName: "lookup_quest",
        },
        {
          type: "tool_args",
          toolRunId: "88888888-8888-4888-8888-888888888888",
          delta: '{"quest": ',
        },
        { type: "tool_call_end", toolRunId: "88888888-8888-4888-8888-888888888888" },
        nextFinish,
        final,
      ],
    ],
    [
      "tool call without end",
      [
        {
          type: "tool_call_start",
          toolRunId: "88888888-8888-4888-8888-888888888888",
          toolName: "lookup_quest",
        },
        nextFinish,
        final,
      ],
    ],
    [
      "duplicate toolRunId",
      [
        {
          type: "tool_call_start",
          toolRunId: "88888888-8888-4888-8888-888888888888",
          toolName: "lookup_quest",
        },
        {
          type: "tool_call_start",
          toolRunId: "88888888-8888-4888-8888-888888888888",
          toolName: "lookup_quest",
        },
        nextFinish,
        final,
      ],
    ],
  ];

  it.each(invalidCases)("rejects: %s", (_label, events) => {
    const outcome = assemble(events);
    expect(outcome.ok).toBe(false);
  });

  it("rejects args via injected Draft 7 validator", () => {
    const outcome = assemble(
      [
        {
          type: "tool_call_start",
          toolRunId: "88888888-8888-4888-8888-888888888888",
          toolName: "lookup_quest",
        },
        {
          type: "tool_args",
          toolRunId: "88888888-8888-4888-8888-888888888888",
          delta: '{"invalid":true}',
        },
        { type: "tool_call_end", toolRunId: "88888888-8888-4888-8888-888888888888" },
        nextFinish,
        final,
      ],
      (_name, args) =>
        args.invalid === true ? { ok: false, error: "invalid field" } : { ok: true },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("tool_args_schema_rejected");
    }
  });

  it("discards events after a rule violation without crashing", () => {
    const assembler = new StreamAssembler({
      cycleId: "33333333-3333-4333-8333-333333333333",
      tools: TOOLS,
      maxToolCalls: 8,
    });
    expect(assembler.push(final)).toBe(true);
    expect(assembler.push(speechDelta)).toBe(false);
    expect(assembler.push(nextFinish)).toBe(false);
    const outcome = assembler.finish();
    // final 后 delta：整体失败（final 时还没有 next）。
    expect(outcome.ok).toBe(false);
  });
});
