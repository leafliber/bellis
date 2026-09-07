import { createHash, randomUUID } from "node:crypto";
import { CueLaneSchema, TraceContextSchema, UuidSchema } from "@bellis/contracts";
import type {
  CueLane,
  MonotonicClock,
  OutboxMessage,
  Scene,
  TraceContext,
} from "@bellis/contracts";
import { PersistenceError } from "@bellis/persistence";
import type { CommitSceneResult, PersistenceClient } from "@bellis/persistence";
import { createTraceContext } from "@bellis/observability";
import type { LoggerPort, MetricsPort } from "@bellis/observability";
import { z } from "zod";
import { ApplicationError, stableRequestFingerprint } from "../errors/mapping.js";

/**
 * Fake Scene Commit 应用服务（docs/reference/phase-1.md）。
 *
 * 仅用于 Phase 1 协议验证的最小用例：不建立真实模型循环，不产生
 * TTS/Avatar/Game 副作用。输入来自受认证的内部 Application Port
 * （测试装配 / Demo 调用），不进入生产 Control 协议。
 *
 * 不可破坏的不变量：
 * - `scene.prepared` 在数据库事务**之前**发布（仅协议事件）；
 * - `scene.committed` 绝不早于数据库 Commit——仅在 commitScene 成功
 *   返回**之后**发布；
 * - 同一幂等键重试返回第一次结果（duplicate），不发布第二条 committed；
 * - 同 Key 不同摘要返回 `idempotency_conflict`，不覆盖旧结果；
 * - Trace ID 贯穿 Control 发布、commitScene RPC 与 Outbox Payload。
 */

const HARD_LANES: readonly CueLane[] = ["audio", "subtitle"];
const SOFT_LANES: readonly CueLane[] = ["avatar", "game", "overlay"];

/**
 * commitScene 失败中的"冲突族"稳定码（Gate 3 重开评审修复 4）：
 * `bellis_scene_commit_total` 声明了 conflict/error 两种失败结果，
 * 冲突族记 conflict，其余（校验失败、瞬态错误、未知异常）记 error。
 */
const SCENE_CONFLICT_CODES: ReadonlySet<string> = new Set([
  "session_conflict",
  "record_conflict",
  "watermark_regression",
  "seq_regression",
  "idempotency_conflict",
  "scene_conflict",
]);

export const FakeSceneCommitInputSchema = z.object({
  sessionId: UuidSchema,
  sceneId: UuidSchema,
  cycleId: UuidSchema,
  idempotencyKey: z.string().min(1).max(256),
  cues: z
    .array(z.object({ cueId: UuidSchema, lane: CueLaneSchema }))
    .max(64)
    .default([]),
  watermarks: z
    .array(z.object({ source: z.string().min(1).max(64), watermark: z.bigint().nonnegative() }))
    .max(64)
    .default([]),
  trace: TraceContextSchema.optional(),
});

export type FakeSceneCommitInput = z.output<typeof FakeSceneCommitInputSchema>;

export interface FakeSceneCommitResult {
  readonly sceneId: string;
  readonly cycleId: string;
  readonly committedAtMs: number;
  readonly duplicate: boolean;
  readonly traceId: string;
}

export type BroadcastOutcome = "sent" | "no_connection" | "unsent";

/** 广播回执：写出结果 + 承接连接的代际标识（二轮评审修复 4）。 */
export interface BroadcastReceipt {
  readonly outcome: BroadcastOutcome;
  readonly connectionId: string | null;
}

/**
 * Control 广播 Port：向逻辑 Session 的活跃 Control 连接发布服务端消息。
 * `awaitSent` 时等到消息实际写入 Socket（或超时/丢弃）再返回，保证
 * prepared 在数据库事务开始前已上线（否则高优先级 committed 可能
 * 在线上反超 prepared 的因果顺序）。`onlyConnectionId` 限制只发布到
 * 指定代际的连接——prepared 与 committed 必须送达同一连接代际。
 */
export type ControlBroadcast = (
  sessionId: string,
  message: {
    readonly type: string;
    readonly payload: unknown;
    readonly traceId: string;
    readonly spanId?: string;
  },
  options?: { readonly awaitSent?: boolean; readonly onlyConnectionId?: string },
) => Promise<BroadcastReceipt>;

/** 从 Cue Lane 集合确定性推导满足 SceneSchema 的同步组。 */
function buildSceneGroups(sceneId: string, lanes: readonly CueLane[]): Scene["groups"] {
  const groups: Scene["groups"] = [];
  const hard = HARD_LANES.filter((lane) => lanes.includes(lane));
  const soft = SOFT_LANES.filter((lane) => lanes.includes(lane));
  if (hard.length > 0) {
    groups.push({
      schemaVersion: 1,
      groupId: deriveUuid(sceneId, "hard"),
      lanes: hard,
      level: "hard",
    });
  }
  if (soft.length > 0) {
    groups.push({
      schemaVersion: 1,
      groupId: deriveUuid(sceneId, "soft"),
      lanes: soft,
      level: "soft",
    });
  }
  if (groups.length === 0) {
    groups.push({
      schemaVersion: 1,
      groupId: deriveUuid(sceneId, "default"),
      lanes: ["audio"],
      level: "hard",
    });
  }
  return groups;
}

/** 确定性 UUID（版本/变位位置位），重放同一输入得到同一 Scene Payload。 */
function deriveUuid(seed: string, scope: string): string {
  const hex = createHash("sha256").update(`${seed}:${scope}`).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export class FakeSceneCommitService {
  readonly #client: PersistenceClient;
  readonly #broadcast: ControlBroadcast;
  readonly #logger: LoggerPort;
  readonly #metrics: MetricsPort;
  readonly #clock: MonotonicClock;

  constructor(options: {
    client: PersistenceClient;
    broadcast: ControlBroadcast;
    logger: LoggerPort;
    metrics: MetricsPort;
    clock: MonotonicClock;
  }) {
    this.#client = options.client;
    this.#broadcast = options.broadcast;
    this.#logger = options.logger;
    this.#metrics = options.metrics;
    this.#clock = options.clock;
  }

  async commit(input: FakeSceneCommitInput, signal?: AbortSignal): Promise<FakeSceneCommitResult> {
    const parsed = FakeSceneCommitInputSchema.parse(input);
    const trace: TraceContext =
      parsed.trace === undefined
        ? createTraceContext({
            sessionId: parsed.sessionId,
            sceneId: parsed.sceneId,
            cycleId: parsed.cycleId,
          })
        : TraceContextSchema.parse({
            ...parsed.trace,
            sessionId: parsed.sessionId,
            sceneId: parsed.sceneId,
            cycleId: parsed.cycleId,
          });
    this.#throwIfAborted(signal);

    const lanes = [...new Set(parsed.cues.map((cue) => cue.lane))];
    const scene: Scene = {
      schemaVersion: 1,
      sceneId: parsed.sceneId,
      cycleId: parsed.cycleId,
      groups: buildSceneGroups(parsed.sceneId, lanes),
      deadlineMs: 5_000,
      interruptPolicy: "finish",
    };
    const outbox: OutboxMessage[] = [
      {
        schemaVersion: 1,
        outboxId: randomUUID(),
        topic: "scene.committed",
        partitionKey: parsed.sessionId,
        payload: {
          schemaVersion: 1,
          kind: "scene.committed",
          sceneId: parsed.sceneId,
          cycleId: parsed.cycleId,
          sessionId: parsed.sessionId,
          traceId: trace.traceId,
        },
        createdAtMs: Date.now(),
      },
    ];
    // 指纹只覆盖稳定请求部分：不含 outboxId 等每次调用新生成的 ID，
    // 同一幂等键 + 同一请求语义在重放时得到相同摘要。
    const requestFingerprint = stableRequestFingerprint([
      parsed.sessionId,
      parsed.sceneId,
      parsed.cycleId,
      parsed.idempotencyKey,
      parsed.cues,
      parsed.watermarks,
    ]);

    // 1. scene.prepared：仅协议事件，先于数据库事务上线（等待写出，
    //    防止 P1 优先级队列让 committed 在线上反超 prepared）。
    //    写出结果必须检查（二轮评审修复 4）：只有 prepared 确认送达的
    //    那个连接代际才允许收到 committed。
    const preparedReceipt = await this.#broadcast(
      parsed.sessionId,
      {
        type: "scene.prepared",
        payload: { sceneId: parsed.sceneId, cycleId: parsed.cycleId, cues: parsed.cues },
        traceId: trace.traceId,
        ...(trace.spanId === undefined ? {} : { spanId: trace.spanId }),
      },
      { awaitSent: true },
    );
    this.#throwIfAborted(signal);

    // 2. 数据库原子提交：scene_committed Record + scenes + Watermark + Outbox。
    const startedUs = this.#clock.nowUs();
    let result: CommitSceneResult;
    try {
      result = await this.#client.commitScene({
        sceneId: parsed.sceneId,
        cycleId: parsed.cycleId,
        sessionId: parsed.sessionId,
        scene,
        idempotencyKey: parsed.idempotencyKey,
        requestFingerprint,
        watermarks: parsed.watermarks.map((entry) => ({
          source: entry.source,
          watermark: entry.watermark,
        })),
        outbox,
        trace,
      });
    } catch (error) {
      // 失败结果同样计数：指标定义声明了 conflict/error，运行时不记录
      // 则冲突/失败监控实际不存在；错误原样上抛，行为不变。
      this.#metrics
        .counter("bellis_scene_commit_total", {
          result:
            error instanceof PersistenceError && SCENE_CONFLICT_CODES.has(error.code)
              ? "conflict"
              : "error",
        })
        .inc();
      throw error;
    } finally {
      this.#metrics
        .histogram("bellis_scene_commit_duration_ms")
        .observe(Number((this.#clock.nowUs() - startedUs) / 1000n));
    }
    this.#metrics
      .counter("bellis_scene_commit_total", {
        result: result.duplicate ? "duplicate" : "committed",
      })
      .inc();
    this.#logger.log("info", "runtime_scene_committed", {
      sessionId: parsed.sessionId,
      sceneId: parsed.sceneId,
      cycleId: parsed.cycleId,
      duplicate: result.duplicate,
      traceId: trace.traceId,
    });

    // 3. 数据库 Commit 成功后才发布 scene.committed；幂等重放（duplicate）
    //    不发布第二条 committed——重连客户端经 session.snapshot 获取事实。
    //    发布目标只能是**确认收到 prepared 的同一连接代际**（二轮评审
    //    修复 4）：prepared 送达失败（无连接/写出失败/超时）时跳过
    //    committed——内部提交照常完成，后续连接经 Snapshot 获得事实，
    //    不能只收到无 prepared 因果的孤立 committed。
    if (!result.duplicate) {
      if (preparedReceipt.outcome === "sent" && preparedReceipt.connectionId !== null) {
        await this.#broadcast(
          parsed.sessionId,
          {
            type: "scene.committed",
            payload: {
              sceneId: parsed.sceneId,
              cycleId: parsed.cycleId,
              committedAtMs: result.committedAtMs,
            },
            traceId: trace.traceId,
            ...(trace.spanId === undefined ? {} : { spanId: trace.spanId }),
          },
          { awaitSent: false, onlyConnectionId: preparedReceipt.connectionId },
        );
      } else {
        this.#logger.log("info", "runtime_scene_committed_broadcast_skipped", {
          sessionId: parsed.sessionId,
          sceneId: parsed.sceneId,
          preparedOutcome: preparedReceipt.outcome,
        });
      }
    }
    return {
      sceneId: result.sceneId,
      cycleId: parsed.cycleId,
      committedAtMs: result.committedAtMs,
      duplicate: result.duplicate,
      traceId: trace.traceId,
    };
  }

  #throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) {
      throw new ApplicationError("deadline_exceeded", "scene commit aborted before transaction");
    }
  }
}
