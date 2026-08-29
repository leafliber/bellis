import type { MonotonicClock } from "@bellis/contracts";
import type { ModelProvider, ModelRequest, ModelStreamEvent } from "@bellis/decision-loop";

/**
 * Demo 脚本化 Provider（开发/Demo 装配；不变量 12：只替换外部模型能力，
 * 不绕过 Batcher/Loop/Tool Runtime/Persistence/Scene Director）。
 *
 * - 脚本由宿主/Demo harness 按请求注入（setNextScript）；未注入时
 *   产生「noOp + finish」的合法最小流（不破坏一请求一包不变量）；
 * - paceUs：事件间隔用注入时钟 sleep（真实进程 = SystemMonotonicClock；
 *   测试 = VirtualClock），尊重 Abort——中断路径的真实证据；
 * - 记录收到的请求（Demo 断言 Tool Result 进入 Cycle 2 等）。
 */
export class DemoScriptedProvider implements ModelProvider {
  readonly name = "demo-scripted";
  readonly #scripts: ModelStreamEvent[][] = [];
  readonly #clock: MonotonicClock;
  readonly #paceUs: bigint;
  #requests: ModelRequest[] = [];
  #callCount = 0;

  constructor(options: { readonly clock: MonotonicClock; readonly paceUs?: bigint }) {
    this.#clock = options.clock;
    this.#paceUs = options.paceUs ?? 0n;
  }

  /** 为下一次模型请求注入事件脚本（Demo harness IPC 驱动）。 */
  setNextScript(events: readonly ModelStreamEvent[]): void {
    this.#scripts.push([...events]);
  }

  get requests(): readonly ModelRequest[] {
    return this.#requests;
  }

  get callCount(): number {
    return this.#callCount;
  }

  async *streamDecision(
    request: ModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelStreamEvent> {
    this.#requests.push(request);
    this.#callCount += 1;
    const script =
      this.#scripts.shift() ??
      ([{ type: "next", next: "finish" }, { type: "final" }] as ModelStreamEvent[]);
    for (const event of script) {
      if (signal.aborted) {
        throw signal.reason ?? new Error("demo model stream aborted");
      }
      if (this.#paceUs > 0n) {
        await this.#clock.sleepUntil(this.#clock.nowUs() + this.#paceUs, signal);
      }
      yield event;
    }
  }
}
