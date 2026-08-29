import type { AudienceBatch, DecisionPacket, ToolCall, ToolResult } from "@bellis/contracts";
import type { DagCompileResult, ToolExecutionContext, ToolRuntime } from "@bellis/tool-runtime";
import type {
  CycleAdoptionInput,
  CycleAdoptionPort,
  PerformancePort,
  PerformanceSubmitContext,
  PerformanceSubmitResult,
} from "../src/index.js";
import type { ModelProvider, ModelRequest, ModelStreamEvent } from "../src/index.js";

export function batchOf(from: number, to: number): AudienceBatch {
  return {
    schemaVersion: 1,
    id: `${from.toString(16).padStart(8, "0")}-bbbb-4bbb-8bbb-bbbbbbbbbbbb`,
    watermarkFrom: from.toString(10),
    watermarkTo: to.toString(10),
    highlights: [
      {
        schemaVersion: 1,
        signalId: `${from.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`,
        userId: "u1",
        text: `msg-${from}`,
      },
    ],
    topics: [],
    urgentSignals: [],
    tokenEstimate: 8,
  };
}

export class CapturingProvider implements ModelProvider {
  readonly name: string;
  readonly requests: ModelRequest[] = [];
  readonly scripts: { events: ModelStreamEvent[]; hangAfter: number }[] = [];
  callCount = 0;

  constructor(name = "capturing", scripts: ModelStreamEvent[][] = []) {
    this.name = name;
    this.scripts.push(...scripts.map((events) => ({ events, hangAfter: -1 })));
  }

  /** 脚本第 hangAfter 个事件后永久挂起（直到 Abort）——模拟慢模型流。 */
  hangScript(index: number, hangAfter: number): void {
    const entry = this.scripts[index];
    if (entry !== undefined) {
      entry.hangAfter = hangAfter;
    }
  }

  async *streamDecision(
    request: ModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    this.callCount += 1;
    const script = this.scripts.shift() ?? {
      events: [
        { type: "next", next: "finish" } as ModelStreamEvent,
        { type: "final" } as ModelStreamEvent,
      ],
      hangAfter: -1,
    };
    for (const [index, event] of script.events.entries()) {
      if (signal.aborted) {
        throw signal.reason ?? new Error("aborted");
      }
      yield event;
      if (script.hangAfter === index) {
        await new Promise<never>((_, reject) => {
          const onAbort = () => reject(signal.reason ?? new Error("aborted"));
          if (signal.aborted) {
            onAbort();
            return;
          }
          signal.addEventListener("abort", onAbort, { once: true });
        });
      }
    }
  }
}

export class FakeAdoption implements CycleAdoptionPort {
  readonly adoptions: CycleAdoptionInput[] = [];
  failNext = false;

  async adoptCycle(input: CycleAdoptionInput): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("adoption transaction failed");
    }
    this.adoptions.push(input);
  }
}

export class FakePerformance implements PerformancePort {
  readonly submissions: { packet: DecisionPacket; context: PerformanceSubmitContext }[] = [];
  readonly interrupts: string[] = [];
  nextResult: PerformanceSubmitResult | null = null;

  submitDecision(
    packet: DecisionPacket,
    context: PerformanceSubmitContext,
  ): PerformanceSubmitResult {
    this.submissions.push({ packet, context });
    return (
      this.nextResult ?? {
        kind: "scene_submitted",
        sceneId: "44444444-4444-4444-8444-444444444444",
        done: Promise.resolve("completed" as const),
      }
    );
  }

  async interruptActiveScenes(reason: string): Promise<void> {
    this.interrupts.push(reason);
  }
}

export class FakeToolRuntime implements ToolRuntime {
  readonly knownTools = new Set<string>(["lookup_quest", "read_stage"]);
  readonly executeCalls: { cycleId: string; toolNames: string[] }[] = [];
  executeResults: ToolResult[] | null = null;
  compileShouldFail = false;

  registerTool(): void {
    throw new Error("not needed in fake");
  }

  hasTool(name: string): boolean {
    return this.knownTools.has(name);
  }

  listDeclarations(): ReturnType<ToolRuntime["listDeclarations"]> {
    return [...this.knownTools].map((name) => ({
      name,
      version: 1,
      description: `fake ${name}`,
      inputSchema: { type: "object" },
      outputMaxBytes: 4096,
      sensitiveOutputFields: [],
      executionMode: "parallel_read" as const,
      semantic: "pure" as const,
      resource: null,
      keyArgument: null,
      timeoutMs: 5_000,
      cancellable: true,
      maxConcurrency: 4,
      requiredCapabilities: [],
      requiresConfirmation: false,
      cache: { l1: true, l2: false, ttlMs: 60_000, revision: "v1" },
    }));
  }

  validateArguments(
    toolName: string,
    args: Record<string, unknown>,
  ): { readonly ok: true } | { readonly ok: false; readonly error: string } {
    if (!this.knownTools.has(toolName)) {
      return { ok: false, error: `unknown tool ${toolName}` };
    }
    if (args.invalid === true) {
      return { ok: false, error: "arguments rejected by schema" };
    }
    return { ok: true };
  }

  compileDag(calls: readonly ToolCall[]): DagCompileResult {
    if (this.compileShouldFail) {
      return {
        ok: false,
        issues: [{ code: "dependency_cycle", toolRunId: calls[0]?.toolRunId ?? "?" }],
        layers: [],
        nodes: [],
      };
    }
    const nodes = calls.map((call) => ({
      call,
      declaration: this.listDeclarations().find((d) => d.name === call.toolName)!,
      lockKey: null,
      dependsOn: [],
    }));
    return { ok: true, issues: [], layers: [nodes], nodes };
  }

  async executeDag(dag: DagCompileResult, context: ToolExecutionContext) {
    this.executeCalls.push({
      cycleId: context.cycleId,
      toolNames: dag.nodes.map((node) => node.call.toolName),
    });
    const results: ToolResult[] =
      this.executeResults ??
      dag.nodes.map((node) => ({
        schemaVersion: 1 as const,
        toolRunId: node.call.toolRunId,
        toolName: node.call.toolName,
        outcome: "succeeded" as const,
        value: { echoed: node.call.toolName },
        truncated: false,
      }));
    return { results, background: [] };
  }

  async close(): Promise<void> {}
}

export const flush = async (ticks = 60): Promise<void> => {
  for (let tick = 0; tick < ticks; tick += 1) {
    await Promise.resolve();
  }
};

/** 条件等待：微任务循环直至谓词为真（虚拟时钟下全部是微任务链）。 */
export async function waitFor(predicate: () => boolean, ticks = 400): Promise<void> {
  for (let tick = 0; tick < ticks && !predicate(); tick += 1) {
    await Promise.resolve();
  }
  if (!predicate()) {
    throw new Error("waitFor condition not met");
  }
  await flush(20);
}
