import { describe, expect, it } from "vitest";
import { VirtualClock } from "@bellis/testkit";
import {
  DecisionLoop,
  type DecisionLoopConfig,
  type ModelStreamEvent,
  type TurnResult,
} from "../../src/index.js";
import {
  batchOf,
  CapturingProvider,
  FakeAdoption,
  FakePerformance,
  FakeToolRuntime,
  waitFor,
} from "../fakes.js";

const TOOL_RUN_A = "88888888-8888-4888-8888-888888888888";
const TOOL_RUN_B = "99999999-9999-4999-8999-999999999999";

function makeLoop(options?: {
  scripts?: ModelStreamEvent[][];
  config?: Partial<DecisionLoopConfig>;
  adoption?: FakeAdoption;
  performance?: FakePerformance;
  tools?: FakeToolRuntime;
}) {
  const clock = new VirtualClock();
  const provider = new CapturingProvider("capturing", options?.scripts ?? []);
  const adoption = options?.adoption ?? new FakeAdoption();
  const performance = options?.performance ?? new FakePerformance();
  const tools = options?.tools ?? new FakeToolRuntime();
  let counter = 0;
  const id = (): string => {
    counter += 1;
    return `${counter.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
  };
  const consumed: bigint[] = [];
  const settled: { turnId: string; result: TurnResult }[] = [];
  const loop = new DecisionLoop({
    sessionId: "11111111-1111-4111-8111-111111111111",
    provider,
    tools,
    adoption,
    performance,
    clock,
    ids: {
      turnId: () => id(),
      cycleId: () => id(),
      requestId: () => `req-${(counter += 1)}`,
      batchId: () => id(),
      traceId: () => `${counter.toString(16).padStart(32, "0")}`,
    },
    instructions: "你是主播",
    model: "demo-model",
    ...(options?.config === undefined ? {} : { config: options.config }),
    onWatermarkConsumed: (to) => consumed.push(to),
    onTurnSettled: (turnId, result) => settled.push({ turnId, result }),
  });
  return { clock, provider, adoption, performance, tools, loop, consumed, settled };
}

/** Cycle 1：tool_notice 发言 + 两个只读工具（after_tools）。 */
const cycleOneScript: ModelStreamEvent[] = [
  { type: "started" },
  { type: "speech", delta: "我看看现在的任务进度" },
  { type: "speech_meta", purpose: "tool_notice", interruptible: true },
  { type: "tool_call_start", toolRunId: TOOL_RUN_A, toolName: "lookup_quest" },
  { type: "tool_args", toolRunId: TOOL_RUN_A, delta: '{"quest":"main"}' },
  { type: "tool_call_end", toolRunId: TOOL_RUN_A },
  { type: "tool_call_start", toolRunId: TOOL_RUN_B, toolName: "read_stage" },
  { type: "tool_args", toolRunId: TOOL_RUN_B, delta: "{}" },
  { type: "tool_call_end", toolRunId: TOOL_RUN_B },
  { type: "usage", inputTokens: 900, outputTokens: 40 },
  { type: "next", next: "after_tools" },
  { type: "final" },
];

/** Cycle 2：基于工具结果的最终回答（finish）。 */
const cycleTwoScript: ModelStreamEvent[] = [
  { type: "started" },
  { type: "speech", delta: "任务进度已经过半了" },
  { type: "speech_meta", purpose: "answer", interruptible: true },
  { type: "next", next: "finish" },
  { type: "final" },
];

describe("DecisionLoop", () => {
  it("runs a two-cycle turn: tools in cycle 1 feed cycle 2, then finish", async () => {
    const ctx = makeLoop({ scripts: [cycleOneScript, cycleTwoScript] });
    expect(ctx.loop.startTurn(batchOf(1, 3), "normal_batch")).toBe(true);
    await waitFor(() => ctx.settled.length > 0);

    // 恰好 2 次模型请求 / 2 个采用包 / 2 个 ActionFrame。
    expect(ctx.provider.callCount).toBe(2);
    expect(ctx.adoption.adoptions).toHaveLength(2);
    expect(ctx.performance.submissions).toHaveLength(2);
    // 水位只沿批次区间前进。
    expect(ctx.consumed).toEqual([3n, 3n]);
    // 工具结果进入 Cycle 2 请求。
    const secondRequest = ctx.provider.requests[1]!;
    expect(secondRequest.prompt).toContain("lookup_quest → succeeded");
    expect(secondRequest.prompt).toContain("read_stage → succeeded");
    // Cycle 1 提示语 + Cycle 2 最终回答。
    expect(ctx.performance.submissions[0]?.packet.action).toHaveProperty(
      "speech.purpose",
      "tool_notice",
    );
    expect(ctx.performance.submissions[1]?.packet.action).toHaveProperty(
      "speech.purpose",
      "answer",
    );
    expect(ctx.tools.executeCalls).toHaveLength(1);
    expect(ctx.tools.executeCalls[0]?.toolNames).toEqual(["lookup_quest", "read_stage"]);
    expect(ctx.settled).toHaveLength(1);
    expect(ctx.settled[0]?.result).toBe("completed");
  });

  it("invalid stream produces exactly one adopted safety packet and no retry", async () => {
    const invalid: ModelStreamEvent[] = [
      { type: "speech", delta: "半截话" },
      { type: "next", next: "finish" },
      { type: "final" },
      { type: "final" }, // 重复 final → 非法
    ];
    const ctx = makeLoop({ scripts: [invalid] });
    ctx.loop.startTurn(batchOf(1, 2), "normal_batch");
    await waitFor(() => ctx.settled.length > 0);

    expect(ctx.provider.callCount).toBe(1);
    expect(ctx.adoption.adoptions).toHaveLength(1);
    const adopted = ctx.adoption.adoptions[0]!;
    expect(adopted.degraded).toBe(true);
    expect(adopted.packet.next).toBe("finish");
    expect(adopted.packet.action).toMatchObject({ noOp: true });
    // 降级包同样推进水位（不变量 8）。
    expect(ctx.consumed).toEqual([2n]);
    expect(ctx.settled[0]?.result).toBe("degraded");
  });

  it("after_tools without tool calls degrades to a safety packet", async () => {
    const ctx = makeLoop({
      scripts: [
        [
          { type: "speech", delta: "我想调工具" },
          { type: "next", next: "after_tools" },
          { type: "final" },
        ] as ModelStreamEvent[],
      ],
    });
    ctx.loop.startTurn(batchOf(1, 1), "normal_batch");
    await waitFor(() => ctx.settled.length > 0);
    expect(ctx.adoption.adoptions[0]?.degraded).toBe(true);
    expect(ctx.tools.executeCalls).toHaveLength(0);
  });

  it("adoption failure fails the turn: no watermark, no tools, no scene", async () => {
    const adoption = new FakeAdoption();
    adoption.failNext = true;
    const ctx = makeLoop({ scripts: [cycleOneScript], adoption });
    ctx.loop.startTurn(batchOf(1, 4), "normal_batch");
    await waitFor(() => ctx.settled.length > 0);

    expect(ctx.adoption.adoptions).toHaveLength(0);
    expect(ctx.consumed).toEqual([]);
    expect(ctx.tools.executeCalls).toHaveLength(0);
    expect(ctx.performance.submissions).toHaveLength(0);
    expect(ctx.settled[0]?.result).toBe("failed");
  });

  it("interrupt cancels the model stream, returns the unadopted batch and interrupts scenes", async () => {
    // 慢流：provider 在第一个事件后永久等待（虚拟时钟不推进）。
    const slowScript: ModelStreamEvent[] = [
      { type: "started" },
      { type: "speech", delta: "正在思考…" },
    ];
    const ctx = makeLoop({ scripts: [slowScript] });
    ctx.provider.hangScript(0, 1);
    ctx.loop.startTurn(batchOf(1, 5), "normal_batch");
    await waitFor(() => ctx.provider.callCount === 1);

    const unadopted = ctx.loop.cancelActiveTurn();
    expect(unadopted.map((batch) => batch.watermarkTo)).toEqual(["5"]);
    await waitFor(() => ctx.settled.length > 0);

    expect(ctx.adoption.adoptions).toHaveLength(0);
    expect(ctx.performance.interrupts).toHaveLength(1);
    expect(ctx.consumed).toEqual([]);
    expect(ctx.settled[0]?.result).toBe("cancelled");
  });

  it("cycle budget exhaustion finishes with an adopted safety packet", async () => {
    const ctx = makeLoop({
      scripts: [
        // Cycle 1 有新输入（continue，spin 归零）；Cycle 2 空转（spin=1
        // 达阈值）→ 采信 continue 后以安全帧结束。
        [{ type: "next", next: "continue" }, { type: "final" }],
        [{ type: "next", next: "continue" }, { type: "final" }],
      ],
      config: { idleSpinLimit: 1 },
    });
    ctx.loop.startTurn(batchOf(1, 1), "normal_batch");
    await waitFor(() => ctx.settled.length > 0);

    // 两个 continue Cycle（各自采用）+ 1 个安全帧 = 3 次采用。
    expect(ctx.adoption.adoptions).toHaveLength(3);
    expect(ctx.adoption.adoptions[2]?.degraded).toBe(true);
    expect(ctx.settled[0]?.result).toBe("degraded");
  });

  it("close cancels active turn and waits for background tasks", async () => {
    const ctx = makeLoop({ scripts: [[{ type: "started" }, { type: "speech", delta: "思考中" }]] });
    ctx.provider.hangScript(0, 0);
    ctx.loop.startTurn(batchOf(1, 1), "normal_batch");
    await waitFor(() => ctx.provider.callCount === 1);
    await ctx.loop.close("session_close");
    await waitFor(() => ctx.settled.length > 0);
    expect(ctx.loop.isClosed).toBe(true);
    expect(ctx.settled[0]?.result).toBe("cancelled");
  });
});
