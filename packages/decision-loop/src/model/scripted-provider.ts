import type { MonotonicClock } from "@bellis/contracts";
import type { ModelProvider, ModelRequest, ModelStreamEvent } from "./provider.js";

/**
 * 脚本化 Provider：测试与 Demo 的确定性模型替身（不变量 12：只替换
 * 外部能力，不绕过 Batcher/Loop/Scheduler/Persistence/Scene Director）。
 *
 * - 事件序列原样产出（含非法序列——用于证明 Assembler/降级行为）；
 * - 可选 paceUs：事件之间用注入时钟 sleep（虚拟时钟下可精确编排
 *   TTFT/超时/中断窗口），并尊重 Abort；
 * - 与 OpenAI-compatible Adapter 走同一 Assembler 规范化测试套件。
 */
export class ScriptedModelProvider implements ModelProvider {
  readonly name = "scripted";
  readonly #events: readonly ModelStreamEvent[];
  readonly #clock: MonotonicClock | null;
  readonly #paceUs: bigint;

  constructor(options: {
    readonly events: readonly ModelStreamEvent[];
    readonly clock?: MonotonicClock;
    readonly paceUs?: bigint;
  }) {
    this.#events = options.events;
    this.#clock = options.clock ?? null;
    this.#paceUs = options.paceUs ?? 0n;
  }

  async *streamDecision(
    request: ModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelStreamEvent> {
    void request;
    for (const event of this.#events) {
      if (signal.aborted) {
        throw signal.reason ?? new Error("scripted model stream aborted");
      }
      if (this.#paceUs > 0n && this.#clock !== null) {
        await this.#clock.sleepUntil(this.#clock.nowUs() + this.#paceUs, signal);
      }
      yield event;
    }
  }
}
