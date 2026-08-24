import type { MonotonicClock, StageCapabilities } from "@bellis/contracts";
import type { CompileIdSource, SceneRepositoryPort } from "@bellis/scene-runtime";
import type { ControlConnection } from "../../websocket/control-adapter.js";
import type { ControlChannel } from "./stage-port-adapter.js";
import { Phase2PerformanceService, type SubmissionOutcome } from "./performance-service.js";
import type { FakeModelFixture } from "./fake-model.js";

/**
 * Phase 2 Runtime Host（开发/Demo 装配，docs/phase-2-development-guide.md §9.1）。
 *
 * - 把 Phase2PerformanceService 绑定到当前 Stage 类型的 ControlConnection：
 *   出站走 sendPhase2Message（协议优先级入队），入站经 onStageMessage 钩子；
 * - 只在显式启用（development/test 配置）时由 startRuntime 装配；生产
 *   默认路径不创建本对象；
 * - 同一时刻只绑定一条 Stage 连接：新连接取代旧连接（旧连接关闭即解绑）。
 */

export interface Phase2HostOptions {
  readonly sessionId: string;
  readonly capabilities: StageCapabilities;
  readonly clock: MonotonicClock;
  readonly wallClockMs: () => number;
  readonly compileIds: CompileIdSource;
  readonly recordId: () => string;
  readonly repository: SceneRepositoryPort;
}

export class Phase2RuntimeHost {
  readonly #service: Phase2PerformanceService;
  #connection: ControlConnection | null = null;
  readonly #disconnectHandlers: (() => void)[] = [];
  #closed = false;

  constructor(options: Phase2HostOptions) {
    const channel: ControlChannel = {
      enqueueServerMessage: (input) =>
        this.#connection?.sendPhase2Message({
          type: input.type,
          payload: input.payload,
          traceId: input.trace.traceId,
        }) ?? false,
      hasStageConnection: () => this.#connection !== null && !this.#closed,
      onDisconnected: (handler) => {
        this.#disconnectHandlers.push(handler);
      },
    };
    this.#service = new Phase2PerformanceService({
      sessionId: options.sessionId,
      capabilities: options.capabilities,
      clock: options.clock,
      wallClockMs: options.wallClockMs,
      compileIds: options.compileIds,
      recordId: options.recordId,
      channel,
      repository: options.repository,
    });
  }

  get service(): Phase2PerformanceService {
    return this.#service;
  }

  /** Stage 连接建立（server 装配在 ControlConnection 创建后调用）。 */
  attachConnection(connection: ControlConnection, sessionId?: string): void {
    this.#connection = connection;
    this.#service.markStageConnected(sessionId);
  }

  /** 连接关闭（server 装配注册的 close 钩子调用）。 */
  detachConnection(connection: ControlConnection): void {
    if (this.#connection === connection) {
      this.#connection = null;
      for (const handler of Array.from(this.#disconnectHandlers)) {
        handler();
      }
    }
  }

  /** ControlConnection.onStageMessage 入口。 */
  handleStageMessage(envelope: { type: string; payload: unknown }, nowUs: bigint): void {
    this.#service.handleStageMessage(envelope.type, envelope.payload, nowUs);
  }

  submit(input: { signal: unknown; fixture: FakeModelFixture }): SubmissionOutcome {
    return this.#service.submit(input);
  }

  async interruptAll(reason: string): Promise<void> {
    await this.#service.interruptAll(reason);
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#service.close();
  }
}
