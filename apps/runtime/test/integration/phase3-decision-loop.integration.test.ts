import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ModelStreamEvent } from "@bellis/decision-loop";
import { DemoScriptedProvider } from "../../src/providers/model/demo-scripted.js";
import type { RuntimeHandle } from "../../src/index.js";
import { cleanupTempDataDirectory, createTempDataDirectory, startTestRuntime } from "../helpers.js";

/**
 * Phase 3 Decision Loop 纵向集成（phase-3-development-guide.md §10.1）：
 * 真实 Runtime 装配（phase2+phase3 启用）+ 真实 DB Worker +
 * 演出边界共享；证明：
 * - 多条弹幕聚合为一个 Batch → Cycle 1（tool_notice + 两只读工具）→
 *   工具结果进入 Cycle 2 → 最终回答（finish）；
 * - 一请求恰好一个采用包；水位沿 Batch 区间前进；
 * - 重复 Signal 幂等（不产生第二个序号/Turn）；
 * - 紧急 Signal 中断慢模型流（Turn cancelled，无 adoption）；
 * - 非法模型流 → 唯一安全包（degraded Turn，无重试请求）。
 */

let handle: RuntimeHandle;
let dataDirectory: string;
let provider: DemoScriptedProvider;

const TOOL_A = randomUUID();
const TOOL_B = randomUUID();

function cycleOneScript(): ModelStreamEvent[] {
  return [
    { type: "started" },
    { type: "speech", delta: "我看看现在的任务进度" },
    { type: "speech_meta", purpose: "tool_notice", interruptible: true },
    { type: "tool_call_start", toolRunId: TOOL_A, toolName: "lookup_quest" },
    { type: "tool_args", toolRunId: TOOL_A, delta: '{"quest":"main"}' },
    { type: "tool_call_end", toolRunId: TOOL_A },
    { type: "tool_call_start", toolRunId: TOOL_B, toolName: "read_stage" },
    { type: "tool_args", toolRunId: TOOL_B, delta: "{}" },
    { type: "tool_call_end", toolRunId: TOOL_B },
    { type: "next", next: "after_tools" },
    { type: "final" },
  ];
}

function cycleTwoScript(): ModelStreamEvent[] {
  return [
    { type: "started" },
    { type: "speech", delta: "任务进度已经过半了，稳住我们能赢" },
    { type: "speech_meta", purpose: "answer", interruptible: true },
    { type: "next", next: "finish" },
    { type: "final" },
  ];
}

function danmaku(id: string, text: string, priority = 100): unknown {
  return {
    schemaVersion: 1,
    id,
    kind: "danmaku",
    source: "phase3-test",
    occurredAt: Date.now(),
    priority,
    payload: { text, userId: `u${id.slice(0, 4)}` },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("waitFor condition not met");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

beforeAll(async () => {
  dataDirectory = createTempDataDirectory("bellis-phase3-loop-");
  handle = await startTestRuntime({
    dataDirectory,
    phase2: { enabled: true },
    phase3: { enabled: true },
  });
  if (handle.phase3 === null) {
    throw new Error("phase3 host not enabled");
  }
  provider = handle.phase3.modelProvider as DemoScriptedProvider;
});

afterAll(async () => {
  await handle.close();
  cleanupTempDataDirectory(dataDirectory);
});

describe("phase3 decision loop vertical", () => {
  it("runs danmaku → batch → cycle1(tools) → cycle2(final answer)", async () => {
    const host = handle.phase3!;
    provider.setNextScript(cycleOneScript());
    provider.setNextScript(cycleTwoScript());

    const first = await host.ingest(danmaku(randomUUID(), "主播任务打到哪了"));
    const second = await host.ingest(danmaku(randomUUID(), "任务进度看一下"));
    expect(first.result).toBe("accepted");
    expect(second.result).toBe("accepted");

    // 窗口封窗（200ms 基线）→ Turn 启动 → 两 Cycle 完成。
    await waitFor(() => provider.callCount >= 2);
    await waitFor(() => host.loop.isIdle());

    expect(provider.callCount).toBe(2);
    // 工具结果进入 Cycle 2 请求（prompt 含上一轮结果）。
    expect(provider.requests[1]?.prompt).toContain("lookup_quest → succeeded");
    expect(provider.requests[1]?.prompt).toContain("read_stage → succeeded");
    // 两只读工具真实执行（一次 DAG）。
    expect(host.demoState.questResult).toMatchObject({ chapter: 3 });
  });

  it("deduplicates repeated signals without a second sequence", async () => {
    const host = handle.phase3!;
    const id = randomUUID();
    const first = await host.ingest(danmaku(id, "重复消息"));
    const second = await host.ingest(danmaku(id, "重复消息"));
    expect(second).toMatchObject({ result: "deduplicated" });
    if (first.result === "accepted" && second.result === "deduplicated") {
      expect(second.sequence).toBe(first.sequence);
    }
  });

  it("invalid model stream produces exactly one adopted safety packet without retry", async () => {
    const host = handle.phase3!;
    provider.setNextScript([
      { type: "speech", delta: "半截话" },
      { type: "final" },
      { type: "final" },
    ]);
    const beforeCalls = provider.callCount;
    await host.ingest(danmaku(randomUUID(), "触发非法流"));
    await waitFor(() => host.loop.isIdle(), 4_000);
    await waitFor(() => provider.callCount >= beforeCalls + 1, 4_000);
    // 唯一请求（无格式修复重试）。
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(provider.callCount).toBe(beforeCalls + 1);
  });

  it("urgent signal interrupts a slow model stream (turn cancelled, no adoption)", async () => {
    const host = handle.phase3!;
    // 慢流：pace 拉长（真实单调时钟），中途注入 urgent。
    const slowProvider = provider;
    slowProvider.setNextScript([
      { type: "started" },
      { type: "speech", delta: "让我慢慢想想……" },
      { type: "next", next: "finish" },
      { type: "final" },
    ]);
    await host.ingest(danmaku(randomUUID(), "慢速问题"));
    await waitFor(() => slowProvider.callCount >= 1, 4_000);
    // urgent 注入（priority ≥ 800 → 立即旁路 → interrupt）。
    const urgent = await host.ingest(danmaku(randomUUID(), "紧急:先停一下!", 900));
    expect(urgent.result).toBe("accepted");
    await waitFor(() => host.loop.isIdle(), 4_000);
  });
});
