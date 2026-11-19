import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { ChannelError, type Connection, RpcError, RpcPeer } from '@bellis/channel';
import {
  type Clock,
  type PluginContext,
  sleepUnlessAborted,
  type TimerHandle,
  withDeadline,
} from '@bellis/kernel';
import {
  checkGameBridgeMessage,
  checkGameBridgeParams,
  checkGameBridgeResult,
  GAME_BRIDGE_MAJOR,
  GAME_BRIDGE_SEMANTIC_V2,
  type GameActionResolveOutcomeParams,
  type GameBridgeMajor,
  type GameCoreDescription,
  type GameCoreHealth,
  type GameDecisionPointOpened,
  type GameDecisionResolveParams,
  type GameGoalSubmitParams,
  type GameInputReleased,
  type GameMainDescription,
  type GameMainDescriptionV2,
  type GameMainHealth,
  type GameMainHealthV2,
  type GamePacingHoldParams,
  type GamePacingReleaseParams,
  type GameSituationObserved,
  type GameTaskOpenParams,
  GameBridgeMethod as Method,
  type OperatorGameOutcomeResolveParams,
  type OperatorGameTaskOpenParams,
  GameBridgeRole as Role,
  RpcCancel,
  RpcErrorCode,
  RpcFailure,
  RpcNotification,
  type RpcParams,
  RpcSuccess,
  readGameBridgeMajor,
} from '@bellis/protocol';
import {
  GAME_RESOLVE_OUTCOME,
  GAME_TASK_OPEN,
  isLocalGameMode,
  isRealOutput,
  type Lease,
  NAMED_CHOICE_INVALID_PARAMS,
  type SafetyFacade,
} from '@bellis/safety';
import { IntentOutcomeUnknown, type IntentSource, type Outcome } from '@bellis/store';
import { useTracer } from '@bellis/telemetry';
import { Compile } from 'typebox/compile';
import {
  type AuthoritySlot,
  type AuthorityTask,
  authoritySlotKey,
  GameAuthorityFact,
  gameAuthorityLedger,
  sameAttempt,
  settledOutcome,
} from './authority.ts';
import type { GameControlResult, GameRuntimeHost } from './host.ts';
import {
  GAME_GOAL,
  GAME_INPUT,
  type Game,
  type GameCommand,
  type GameCommandResult,
  GameControlFact,
  type GameEvent,
  type GameFact,
  type GamePacing,
  type GamePacingHold,
  type GameStatus,
  gameChoiceOptionsDigest,
  gameControlLedger,
  LOCAL_DIALOGUE_GOAL_RPC_MS,
} from './service.ts';
import { GameTelemetry } from './telemetry.ts';

export interface GameBridgeConfig {
  adapterId: string;
  adapterVersion: string;
  localDialogue?: boolean;
  localRecovery?: boolean;
  localNamedChoice?: boolean;
  controlTargetId?: string;
  healthTimeoutMs?: number;
}

const RPC_MS = 2_000;
const MAX_RENEW_MS = 250;
const DEFAULT_HEALTH_MS = 2_000;
const isNotification = Compile(RpcNotification);
const isSuccess = Compile(RpcSuccess);
const isFailure = Compile(RpcFailure);
const requiresOperator = new Set<GameInputReleased['reason']>([
  'focus_lost',
  'takeover',
  'emergency_stop',
  'injection_blocked',
  'hook_lost',
]);
const refusedBeforeExecution = new Set<number>([
  RpcErrorCode.MethodNotFound,
  RpcErrorCode.InvalidParams,
  RpcErrorCode.ServerBusy,
]);

type Health = GameMainHealth | GameMainHealthV2 | GameCoreHealth;
type Description = GameMainDescription | GameMainDescriptionV2 | GameCoreDescription;
interface Link {
  role: Role;
  major: GameBridgeMajor;
  rpc: RpcPeer;
  closed: AbortController;
  description?: Description;
  reason?: string;
  health?: Health;
  earlyHealth?: Health;
  voice?: Pick<GameSituationObserved, 'atMs' | 'voiceActivity'>;
  release?: GameInputReleased;
  stopAck?: Promise<number | undefined>;
  lastSent: number;
}

interface OpenDecision {
  latest: GameDecisionPointOpened;
  observationsAtLatestMs: GameDecisionPointOpened[];
  resolveSent: boolean;
}

interface Permit {
  link: Link;
  lease: Lease;
  renewAt: number;
  acknowledgedUntilMs: number;
  pending: boolean;
}

interface Stopping {
  link: Link;
  token: number;
  atMs: number;
  settled: PromiseWithResolvers<boolean>;
  probe?: true;
}

type Waiting = { ready: false; reason: string };
type Connected = {
  ready: true;
  main: Link;
  core: Link;
  run: string;
  healthFor: number;
  health: GameMainHealth | GameMainHealthV2;
  realtime: GameCoreHealth;
};
type Availability = Waiting | (Connected & { task?: GameTaskOpenParams });

type AuthorityCommand =
  | { method: typeof Method.TaskOpen; payload: GameTaskOpenParams }
  | { method: typeof Method.ActionResolveOutcome; payload: GameActionResolveOutcomeParams };
type AuthorityConnection = Connected & { slot: AuthoritySlot; health: GameMainHealthV2 };

/** 单个插件实例拥有两个会话槽位、在途命令和输入许可。 */
export class GameBridge implements Game {
  readonly #ctx: PluginContext<GameBridgeConfig>;
  readonly #port: GameRuntimeHost['port'];
  readonly #clock: Clock;
  readonly #safety: SafetyFacade;
  readonly #telemetry: GameTelemetry;
  readonly #target: string;
  readonly #legacyTarget: string;
  readonly #links = new Map<Role, Link>();
  readonly #listeners = new Set<(fact: GameFact) => void>();
  readonly #seenActions = new Set<string>();
  readonly #seenDecisions = new Set<string>();
  #seenRun: string | undefined;
  #decision: OpenDecision | undefined;
  #manual: string | undefined;
  #permit: Permit | undefined;
  #release: Stopping | undefined;
  #timer: TimerHandle | undefined;
  #command: AbortController | undefined;
  #authorityCommand: AbortController | undefined;
  #nextHold = 0;
  #disposed = false;

  constructor(
    ctx: PluginContext<GameBridgeConfig>,
    port: GameRuntimeHost['port'],
    clock: Clock,
    safety: SafetyFacade,
  ) {
    this.#ctx = ctx;
    this.#port = port;
    this.#clock = clock;
    this.#safety = safety;
    this.#telemetry = new GameTelemetry(useTracer(ctx, 'game-bridge'), clock, port.wireNowMs);
    this.#legacyTarget = `game:${ctx.config.adapterId}`;
    this.#target = ctx.config.controlTargetId
      ? `game:${authoritySlotKey(ctx.config.controlTargetId)}`
      : this.#legacyTarget;
    this.#manual = safety.view(gameControlLedger)[this.#legacyTarget];
  }

  start(): void {
    const { signal } = this.#ctx;
    this.#ctx.register(() => this.dispose());
    this.#ctx.register(this.#port.register(this));
    this.#ctx.register(
      this.subscribe((fact) => {
        if (fact.method !== Method.SituationObserved) return;
        const main = this.#links.get(Role.Main);
        if (!main || main.description?.runtimeId !== fact.runtimeId) return;
        const { atMs, voiceActivity } = fact.payload;
        if (!main.voice || atMs >= main.voice.atMs) main.voice = { atMs, voiceActivity };
      }),
    );
    this.#ctx.register(
      this.#safety.onLease(({ resource, lease }) => {
        if (resource === GAME_INPUT && !lease) this.#stopInput('安全核吊销游戏输入许可');
      }),
    );
    this.#ctx.register(
      this.#safety.onControl((event) => {
        if (event.kind === 'stop') {
          this.#authorityCommand?.abort();
          this.#stopInput(event.reason);
          this.#telemetry.reset('stopped');
        } else if (event.kind === 'mode') this.#recheck();
      }),
    );
    const onQuiesce = () => {
      this.#authorityCommand?.abort();
      this.#stopInput('游戏桥静止中');
      this.#telemetry.reset('unloaded');
    };
    signal.addEventListener('abort', onQuiesce, { once: true });
    this.#ctx.register(() => signal.removeEventListener('abort', onQuiesce));
  }

  connect(role: Role, connection: Connection): void {
    if (this.#disposed || this.#ctx.signal.aborted || this.#links.has(role)) {
      connection.destroy(new ChannelError('protocol-error', '游戏角色已有连接或游戏桥正在停止'));
      return;
    }
    const link: Link = {
      role,
      major:
        role === Role.Main && this.#ctx.config.controlTargetId !== undefined
          ? GAME_BRIDGE_SEMANTIC_V2
          : GAME_BRIDGE_MAJOR,
      lastSent: 0,
      closed: new AbortController(),
      rpc: new RpcPeer(connection, {
        timeoutMs: RPC_MS,
        acceptIncoming: (message) => {
          if (isSuccess.Check(message) || isFailure.Check(message)) return true;
          if (!isNotification.Check(message)) return false;
          // 握手正文核对前只暂存一条已按所请求版本核对的健康消息。
          return (
            !link.description ||
            message.method === RpcCancel ||
            checkGameBridgeMessage(role, 'runtime', message, link.major)
          );
        },
      }),
    };
    this.#links.set(role, link);
    connection.once('close', () => {
      link.closed.abort();
      if (this.#links.get(role) !== link) return;
      this.#links.delete(role);
      this.#authorityCommand?.abort();
      if (role === Role.Main) this.#decision = undefined;
      this.#recheck();
      if (this.#release?.link === link) {
        this.#release.settled.resolve(false);
        this.#release = undefined;
      }
      this.#telemetry.reset('connection_changed');
    });
    for (const method of role === Role.Main
      ? [
          Method.SituationObserved,
          Method.DecisionPointOpened,
          Method.ActionCommitted,
          Method.HealthReported,
        ]
      : [Method.InputReleased, Method.HealthReported]) {
      link.rpc.onNotification(method, (params) => this.#received(link, method, params));
    }
    void this.#describe(link);
  }

  async #describe(link: Link): Promise<void> {
    const requestedAt = this.#port.wireNowMs();
    try {
      const reply = await link.rpc.request(Method.Describe, { major: link.major });
      if (!this.#active(link)) return;
      const major = readGameBridgeMajor(reply);
      if (major === undefined) throw new Error('握手缺少合法的主版本');
      if (major !== link.major) {
        throw new Error(`主版本不兼容（Bellis ${link.major}，Game Runtime ${major}）`);
      }
      if (!checkGameBridgeResult(link.role, Method.Describe, reply, major)) {
        throw new Error('握手正文无效');
      }
      const description = reply as Description;
      // 两端整毫秒舍入在采样边界可能相差一毫秒。
      if (description.nowMs < requestedAt - 1 || description.nowMs > this.#port.wireNowMs() + 1) {
        throw new Error('Game Runtime 的单调时钟与宿主不一致');
      }
      if (link.role === Role.Main) {
        const adapter = (description as GameMainDescription).adapter;
        if (
          adapter.id !== this.#ctx.config.adapterId ||
          adapter.version !== this.#ctx.config.adapterVersion
        ) {
          throw new Error('Game Runtime 的适配包编号或版本与 profile 不符');
        }
        if (
          major === GAME_BRIDGE_SEMANTIC_V2 &&
          (description as GameMainDescriptionV2).controlTargetId !==
            this.#ctx.config.controlTargetId
        ) {
          throw new Error('Game Runtime 的被控槽位与 profile 不符');
        }
        if (major === GAME_BRIDGE_SEMANTIC_V2) {
          const { controlTargetId } = description as GameMainDescriptionV2;
          const slot = this.#authoritySlot(controlTargetId);
          if (slot && slot.adapterId !== adapter.id) {
            throw new Error('被控槽位的持久适配包绑定不符');
          }
          if (
            !slot &&
            !this.#safety.record(GameAuthorityFact.Bound, {
              controlTargetId,
              adapterId: adapter.id,
            })
          ) {
            throw new Error('无法持久记录被控槽位绑定');
          }
        }
      }
      link.description = description;
      if (link.earlyHealth) {
        const health = link.earlyHealth;
        delete link.earlyHealth;
        this.#received(link, Method.HealthReported, health);
      }
    } catch (error) {
      if (!this.#active(link)) return;
      link.reason = error instanceof RpcError ? 'Game Runtime 拒绝握手' : (error as Error).message;
    }
    this.#recheck();
  }

  #active(link: Link): boolean {
    return !this.#disposed && this.#links.get(link.role) === link && link.rpc.connection.isOpen;
  }

  #pairedRun(): string | undefined {
    const main = this.#links.get(Role.Main);
    const core = this.#links.get(Role.Core);
    const run = main?.description?.runtimeId;
    return run &&
      main &&
      core?.description?.runtimeId === run &&
      this.#active(main) &&
      this.#active(core)
      ? run
      : undefined;
  }

  #connected(): Waiting | Connected {
    const main = this.#links.get(Role.Main);
    const core = this.#links.get(Role.Core);
    const reason = main?.reason ?? core?.reason;
    if (reason) return { ready: false, reason };
    if (!main?.description || !core?.description || !this.#active(main) || !this.#active(core)) {
      return { ready: false, reason: '等待语义与控制连接完成握手' };
    }
    const run = this.#pairedRun();
    if (run === undefined) return { ready: false, reason: '两条连接的 Runtime 会话不一致' };
    const health = main.health as GameMainHealth | GameMainHealthV2 | undefined;
    const realtime = core.health as GameCoreHealth | undefined;
    if (!health || !realtime) return { ready: false, reason: '等待两条连接上报健康' };
    const healthFor =
      Math.min(health.atMs, realtime.atMs) +
      (this.#ctx.config.healthTimeoutMs ?? DEFAULT_HEALTH_MS) -
      this.#port.wireNowMs();
    if (healthFor <= 0) return { ready: false, reason: 'Game Runtime 健康上报已过期' };
    return { ready: true, main, core, run, healthFor, health, realtime };
  }

  #authoritySlot(id: string): AuthoritySlot | undefined {
    return this.#safety.view(gameAuthorityLedger)[authoritySlotKey(id)];
  }

  #authorityTaskIsCurrent(task: AuthorityTask, run: string): boolean {
    return (
      !task.ended &&
      task.runtimeId === run &&
      task.hostSessionId === this.#port.sessionId &&
      task.request.expiresAtMs > this.wireNowMs()
    );
  }

  #isolationBlocker(controlTargetId: string | undefined): string | undefined {
    const bindings = Object.entries(this.#safety.view(gameAuthorityLedger)).filter(
      ([, slot]) => slot.adapterId === this.#ctx.config.adapterId,
    );
    if (bindings.some(([, slot]) => slot.pending.some(({ conflict }) => conflict))) {
      return '物理动作尝试的身份冲突，保持隔离';
    }
    if (bindings.some(([, slot]) => slot.pending.length > 0)) {
      return '物理动作结果未决，等待操作员结案';
    }
    // v1 按适配包寻址。保留此适配包所有持久绑定的槽位目标，覆盖切换版本和重载配置。
    const targets = new Set([this.#legacyTarget, this.#target]);
    for (const [key] of bindings) targets.add(`game:${key}`);
    for (const target of targets) {
      if (this.#safety.isIsolated(target)) return '游戏目标已隔离或状态存储不可用';
    }
    const current = controlTargetId === undefined ? undefined : authoritySlotKey(controlTargetId);
    if (bindings.some(([key, slot]) => key !== current && slot.task?.dispatches.length)) {
      return '被控槽位有待回读的开任务请求';
    }
    return undefined;
  }

  #prerequisitesMet({ main, health }: Connected): boolean {
    const declared = (main.description as GameMainDescription).prerequisites;
    const { localDialogue, localRecovery, localNamedChoice } = this.#ctx.config;
    return (
      ((!localDialogue && !localRecovery && !localNamedChoice) ||
        (main.major === GAME_BRIDGE_MAJOR &&
          declared.some(
            ({ id, confirmed }) =>
              confirmed &&
              ((localDialogue && id === 'local-dialogue') ||
                (localRecovery && id === 'local-recovery') ||
                (localNamedChoice && id === 'local-named-choice')),
          ))) &&
      declared.length === health.prerequisites.length &&
      declared.every((item) =>
        health.prerequisites.some(
          ({ id, text, confirmed }) => id === item.id && text === item.text && confirmed,
        ),
      )
    );
  }

  #availability(): Availability {
    const connected = this.#connected();
    if (!connected.ready) return connected;
    const { run, health, realtime } = connected;
    if (this.#authorityCommand) return { ready: false, reason: '等待游戏授权命令完成' };
    if (this.#release) return { ready: false, reason: '等待实时核核验输入释放' };
    const controlTargetId = this.#ctx.config.controlTargetId;
    const isolation = this.#isolationBlocker(controlTargetId);
    if (isolation) return { ready: false, reason: isolation };
    let task: GameTaskOpenParams | undefined;
    if (controlTargetId) {
      const slot = this.#authoritySlot(controlTargetId);
      if (!slot || !('pendingActionOutcome' in health)) {
        return { ready: false, reason: '未核对被控槽位的完整持久回读' };
      }
      if (health.pendingActionOutcome) {
        return { ready: false, reason: '物理动作结果未决，等待操作员结案' };
      }
      if (
        !this.#ctx.permissions.has(GAME_TASK_OPEN) ||
        !this.#ctx.permissions.has(GAME_RESOLVE_OUTCOME)
      ) {
        return { ready: false, reason: '语义 v2 需要 profile 授予开任务与动作结案能力' };
      }
      if (
        !slot.task?.accepted ||
        !this.#authorityTaskIsCurrent(slot.task, run) ||
        health.activeTaskId !== slot.task.request.taskId
      ) {
        return { ready: false, reason: '等待操作员授权任务和 Runtime 回读当前任务' };
      }
      task = slot.task.request;
    }
    if (!health.ready || health.riskLimitExceeded || realtime.leaseState === 'source_lost') {
      return { ready: false, reason: 'Game Runtime 尚未就绪或报告了安全风险' };
    }
    if (!this.#prerequisitesMet(connected)) {
      return { ready: false, reason: '操作员前置条件未全部确认或声明不一致' };
    }
    return { ...connected, ...(task ? { task } : {}) };
  }

  status(): GameStatus {
    const availability = this.#availability();
    const main = this.#links.get(Role.Main);
    const core = this.#links.get(Role.Core);
    const status: GameStatus = {
      state: this.#manual ? 'MANUAL' : availability.ready ? 'READY' : 'WAITING',
      reason: this.#manual ?? (availability.ready ? null : availability.reason),
      mainConnected: main !== undefined && this.#active(main),
      coreConnected: core !== undefined && this.#active(core),
      runtimeId: this.#pairedRun() ?? null,
      adapter: (main?.description as GameMainDescription | undefined)?.adapter ?? null,
      health: (main?.health as GameMainHealth | GameMainHealthV2 | undefined) ?? null,
      realtimeHealth: (core?.health as GameCoreHealth | undefined) ?? null,
      decision: this.#decision?.latest ?? null,
      inputPermitted: availability.ready && !!this.#permit && this.#usable(this.#permit),
    };
    const controlTargetId = this.#ctx.config.controlTargetId;
    if (controlTargetId) {
      const slot = this.#authoritySlot(controlTargetId);
      const task = slot?.task;
      const health = status.health;
      status.authority = {
        controlTargetId,
        pending: slot?.pending.map(({ outcome }) => outcome) ?? [],
        activeTaskId: health && 'activeTaskId' in health ? health.activeTaskId : null,
        task: task
          ? {
              taskId: task.request.taskId,
              expiresAtMs: task.request.expiresAtMs,
              state: this.#authorityTaskIsCurrent(
                task,
                main?.description?.runtimeId ?? task.runtimeId,
              )
                ? task.accepted
                  ? 'accepted'
                  : 'opening'
                : 'ended',
            }
          : null,
      };
    }
    return structuredClone(status);
  }

  wireNowMs(): number {
    return this.#port.wireNowMs();
  }

  subscribe(listener: (fact: GameFact) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  pacing(expectedRuntime?: string): GamePacing | undefined {
    const main = this.#links.get(Role.Main);
    const runtimeId = main?.description?.runtimeId;
    if (
      !main ||
      !runtimeId ||
      !this.#active(main) ||
      (expectedRuntime !== undefined && runtimeId !== expectedRuntime)
    )
      return undefined;
    const signal = AbortSignal.any([main.closed.signal, this.#ctx.signal]);
    if (signal.aborted) return undefined;
    return {
      signal,
      voiceActivity: () => {
        const voice = main.voice;
        return !signal.aborted &&
          voice &&
          this.wireNowMs() - voice.atMs < (this.#ctx.config.healthTimeoutMs ?? DEFAULT_HEALTH_MS)
          ? voice.voiceActivity
          : 'unknown';
      },
      subscribeVoice: (listener) =>
        this.subscribe((fact) => {
          if (
            !signal.aborted &&
            fact.runtimeId === runtimeId &&
            fact.method === Method.SituationObserved
          )
            listener();
        }),
      hold: (ttlMs, traceparent) =>
        signal.aborted ? undefined : this.#holdPacing(main, runtimeId, ttlMs, traceparent),
    };
  }

  #holdPacing(
    main: Link,
    runtimeId: string,
    ttlMs: number,
    traceparent: string | null,
  ): GamePacingHold | undefined {
    const now = this.wireNowMs();
    const holdId = createHash('sha256')
      .update(JSON.stringify([this.#ctx.instanceId, runtimeId, now, ++this.#nextHold]))
      .digest('hex');
    const expiresAtMs = now + ttlMs;
    const params = { holdId, expiresAtMs, traceparent, reason: '正在播出游戏解说' };
    if (
      expiresAtMs <= now ||
      !this.#active(main) ||
      !checkGameBridgeParams(Role.Main, 'bellis', Method.PacingHold, params)
    )
      return undefined;
    let settled = false;
    let released = false;
    const accepted = this.#pacingRequest(main, runtimeId, Method.PacingHold, params).then((ok) => {
      settled = true;
      return ok;
    });
    return {
      accepted,
      remainingMs: () => expiresAtMs - this.wireNowMs(),
      release: () => {
        if (released) return;
        released = true;
        const send = () =>
          this.#pacingRequest(main, runtimeId, Method.PacingRelease, { holdId, traceparent });
        // 等在途的 hold 确认或超时后清理，发声可以立即取消。
        if (settled) void send();
        else void accepted.then(send);
      },
    };
  }

  async #pacingRequest(
    main: Link,
    runtimeId: string,
    method: typeof Method.PacingHold | typeof Method.PacingRelease,
    params: GamePacingHoldParams | GamePacingReleaseParams,
  ): Promise<boolean> {
    let ok = false;
    if (this.#active(main)) {
      try {
        const reply = await main.rpc.request(method, params);
        ok = checkGameBridgeResult(Role.Main, method, reply, main.major);
      } catch {
        // 未知结果由 Runtime 的绝对到期时间兜底。
      }
    }
    const fact = ok
      ? method === Method.PacingHold
        ? 'pacing.held'
        : 'pacing.released'
      : 'pacing.unconfirmed';
    this.#safety.record(fact, { runtimeId, method, ...params });
    return ok;
  }

  #projectDecision(point: GameDecisionPointOpened): OpenDecision | undefined {
    const current = this.#decision;
    if (current?.latest.decisionPointId !== point.decisionPointId) {
      if (this.#seenDecisions.has(point.decisionPointId)) return;
      return { latest: point, observationsAtLatestMs: [point], resolveSent: false };
    }
    const previous = current.latest;
    if (
      current.resolveSent ||
      point.atMs < previous.atMs ||
      point.prompt !== previous.prompt ||
      point.traceparent !== previous.traceparent ||
      !isDeepStrictEqual(point.options, previous.options) ||
      (point.timing === null) !== (previous.timing === null)
    )
      return;
    if (
      point.timing &&
      previous.timing &&
      (point.timing.resolveByMs > previous.timing.resolveByMs ||
        point.timing.deadlineMs > previous.timing.deadlineMs)
    )
      return;
    // 同一毫秒内可以有多个不同的候选快照，按送达顺序记录每个快照一次。
    const observations = point.atMs === previous.atMs ? current.observationsAtLatestMs : [];
    if (observations.some((observed) => isDeepStrictEqual(observed, point))) return;
    return { latest: point, observationsAtLatestMs: [...observations, point], resolveSent: false };
  }

  #received(link: Link, method: GameEvent['method'], params: RpcParams): void {
    if (
      !this.#active(link) ||
      !checkGameBridgeParams(link.role, 'runtime', method, params, link.major)
    )
      return;
    if (!link.description) {
      if (method === Method.HealthReported && !link.reason) {
        const previous = link.earlyHealth;
        if (!previous || !('pendingActionOutcome' in previous) || !previous.pendingActionOutcome) {
          link.earlyHealth = params as unknown as Health;
        }
      }
      return;
    }
    const payload = params as unknown as GameEvent['payload'];
    if (payload.atMs < link.description.nowMs - 1 || payload.atMs > this.#port.wireNowMs() + 1) {
      if ('traceparent' in payload) {
        if (method === Method.ActionCommitted)
          this.#telemetry.discarded('game.action', payload.traceparent, 'invalid_time');
        if (method === Method.DecisionPointOpened)
          this.#telemetry.discarded('game.decision', payload.traceparent, 'invalid_time');
      }
      return;
    }
    const currentRun = this.#pairedRun();
    if (
      !currentRun &&
      method !== Method.HealthReported &&
      !(method === Method.InputReleased && link.lastSent > 0)
    )
      return;

    // 只有两条连接配对后才切换去重记录，覆盖同会话主连接重连后的重复送达。
    if (currentRun && this.#seenRun !== currentRun) {
      this.#seenActions.clear();
      this.#seenDecisions.clear();
      this.#seenRun = currentRun;
    }
    const event = { method, payload } as GameEvent;
    if (event.method === Method.HealthReported) {
      if (link.health && event.payload.atMs < link.health.atMs) return;
      if (
        currentRun &&
        link.role === Role.Main &&
        (event.payload as GameMainHealth).riskLimitExceeded
      ) {
        this.takeOver('Game Runtime 风险分超阈值');
      }
    } else if (event.method === Method.InputReleased) {
      if (event.payload.token !== null && event.payload.token !== link.lastSent) return;
      if (link.release && event.payload.atMs < link.release.atMs) return;
      this.#handleRelease(link, event.payload);
    }
    const actionId = event.method === Method.ActionCommitted ? event.payload.actionId : undefined;
    if (event.method === Method.ActionCommitted && this.#seenActions.has(event.payload.actionId)) {
      this.#telemetry.discarded('game.action', event.payload.traceparent, 'duplicate');
      return;
    }
    const decision =
      event.method === Method.DecisionPointOpened
        ? this.#projectDecision(event.payload)
        : undefined;
    if (event.method === Method.DecisionPointOpened && !decision) {
      this.#telemetry.discarded('game.decision', event.payload.traceparent, 'ignored_update');
      return;
    }

    const runtimeId = link.description.runtimeId;
    const committed = this.#safety.record(method, {
      runtimeId,
      role: link.role,
      payload,
      ...(link.major === GAME_BRIDGE_SEMANTIC_V2 && method === Method.HealthReported
        ? { controlTargetId: this.#ctx.config.controlTargetId }
        : {}),
    });
    if (!committed) {
      this.#stopInput('游戏事实无法持久化');
      return;
    }
    if (actionId !== undefined) this.#seenActions.add(actionId);
    if (event.method === Method.InputReleased) {
      link.release = event.payload;
    }
    if (event.method === Method.HealthReported) {
      const previous = link.health;
      link.health = event.payload;
      const point = this.#decision?.latest;
      const taskChanged =
        'activeTaskId' in event.payload &&
        (event.payload.pendingActionOutcome !== null ||
          (previous &&
            'activeTaskId' in previous &&
            previous.activeTaskId !== event.payload.activeTaskId));
      if (
        link.role === Role.Main &&
        point &&
        (taskChanged ||
          (event.payload.atMs > point.atMs &&
            (event.payload as GameMainHealth).decisionPointId !== point.decisionPointId))
      ) {
        this.#decision = undefined;
        this.#telemetry.withdrew();
      }
    } else if (decision) {
      const update = this.#decision?.latest.decisionPointId === decision.latest.decisionPointId;
      this.#seenDecisions.add(decision.latest.decisionPointId);
      this.#decision = decision;
      this.#telemetry.opened(runtimeId, decision.latest, update);
    } else if (event.method === Method.ActionCommitted && event.payload.selection) {
      const { decisionPointId } = event.payload.selection;
      this.#seenDecisions.add(decisionPointId);
      if (this.#decision?.latest.decisionPointId === decisionPointId) this.#decision = undefined;
    }
    if (event.method === Method.ActionCommitted) this.#telemetry.action(runtimeId, event.payload);
    for (const listener of [...this.#listeners]) {
      try {
        listener(structuredClone({ ...event, seq: committed.seq, role: link.role, runtimeId }));
      } catch {
        this.#ctx.log('game.fact-listener-failed', { method, seq: committed.seq });
      }
    }
    this.#recheck();
  }

  #modeAllowsInput(): boolean {
    if (this.#safety.mode === 'local-dialogue') {
      const scope = this.#safety.localDialogue;
      return (
        !!scope &&
        !!this.#ctx.config.localDialogue &&
        !this.#port.simulated &&
        !this.#decision &&
        scope.runtimeId === this.#pairedRun() &&
        scope.adapterId === this.#ctx.config.adapterId
      );
    }
    if (this.#safety.mode === 'local-recovery' || this.#safety.mode === 'local-choice') {
      const scope = this.#safety.localRecovery;
      const { localRecovery, localNamedChoice } = this.#ctx.config;
      return (
        !!scope &&
        (scope.kind === 'named'
          ? this.#safety.mode === 'local-choice' && localNamedChoice === true
          : this.#safety.mode === 'local-recovery' && localRecovery === true) &&
        !this.#port.simulated &&
        this.#links.get(Role.Main)?.major === GAME_BRIDGE_MAJOR &&
        scope.runtimeId === this.#pairedRun() &&
        scope.adapterId === this.#ctx.config.adapterId
      );
    }
    return isRealOutput(this.#safety.mode) || (this.#port.simulated && this.#safety.mode === 'M0');
  }

  #usable(permit: Permit): boolean {
    return (
      this.#permit === permit &&
      this.#port.wireNowMs() < permit.acknowledgedUntilMs &&
      this.#safety.isValid(GAME_INPUT, permit.lease.token) &&
      this.#modeAllowsInput() &&
      !this.#manual &&
      !this.#ctx.signal.aborted
    );
  }

  #recheck(): void {
    this.#clearTimer();
    if (this.#disposed || this.#ctx.signal.aborted) return;
    const mainHealth = this.#links.get(Role.Main)?.health as GameMainHealth | undefined;
    if (this.#pairedRun() && mainHealth?.riskLimitExceeded) {
      this.takeOver('Game Runtime 风险分超阈值');
      return;
    }
    const availability = this.#availability();
    if (!availability.ready || this.#manual || !this.#modeAllowsInput()) {
      if (isLocalGameMode(this.#safety.mode)) {
        this.#safety.requestDowngrade(
          availability.ready ? '本机游戏授权、画面或控制已失效' : availability.reason,
        );
        return;
      }
      this.#stopInput(
        availability.ready ? (this.#manual ?? '当前模式禁止游戏输入') : availability.reason,
      );
      return;
    }
    if (!this.#permit && this.#command) return;
    const now = this.#clock.now();
    let permit = this.#permit;
    if (permit && !this.#safety.isValid(GAME_INPUT, permit.lease.token)) {
      this.takeOver('宿主游戏输入许可已过期');
      return;
    }
    if (!permit || (!permit.pending && now >= permit.renewAt)) {
      permit = this.#offerLease(availability.core, permit);
    }
    if (!permit || this.#permit !== permit) return;
    const next = permit.pending ? permit.lease.expiresAt : permit.renewAt;
    this.#timer = this.#clock.setTimeout(
      () => this.#recheck(),
      Math.max(
        1,
        Math.min(
          availability.healthFor,
          next - this.#clock.now(),
          (availability.task?.expiresAtMs ?? Infinity) - this.wireNowMs(),
        ),
      ),
    );
  }

  #offerLease(link: Link, active: Permit | undefined): Permit | undefined {
    const result = active ? this.#safety.renew(active.lease) : this.#safety.grant(GAME_INPUT);
    if (!result.ok) {
      if (active) this.#stopInput(result.reason);
      return undefined;
    }
    const lease = result.lease;
    // 授予和续约会同步通知订阅者。重新核对状态，并归还尚未登记到桥上的许可。
    const current = this.#availability();
    if (
      this.#manual ||
      !current.ready ||
      current.core !== link ||
      this.#permit !== active ||
      !this.#safety.isValid(GAME_INPUT, lease.token) ||
      !this.#modeAllowsInput() ||
      this.#ctx.signal.aborted
    ) {
      this.#safety.release(lease);
      this.#stopInput('发送前游戏输入许可已失效');
      return undefined;
    }
    const now = this.#clock.now();
    const interval = Math.max(1, Math.min(MAX_RENEW_MS, Math.floor(lease.ttlMs / 2)));
    const permit: Permit = active ?? {
      link,
      lease,
      acknowledgedUntilMs: Number.NEGATIVE_INFINITY,
      renewAt: now,
      pending: false,
    };
    permit.lease = lease;
    permit.renewAt = now + interval;
    permit.pending = true;
    this.#permit = permit;
    const wireNow = this.#port.wireNowMs();
    const localDialogue = this.#safety.localDialogue;
    const localRecovery = this.#safety.localRecovery;
    const expiresAtMs = Math.min(
      wireNow + Math.floor(lease.expiresAt - this.#clock.now()),
      current.task?.expiresAtMs ?? Infinity,
      localDialogue?.expiresAtMs ?? Infinity,
      localRecovery?.expiresAtMs ?? Infinity,
    );
    const params = {
      token: lease.token,
      expiresAtMs,
      ...(localDialogue ? { localDialogue } : {}),
      ...(localRecovery ? { localRecovery } : {}),
    };
    if (
      !this.#active(link) ||
      (isLocalGameMode(this.#safety.mode) && !localDialogue && !localRecovery) ||
      expiresAtMs <= wireNow ||
      !checkGameBridgeParams(Role.Core, 'bellis', Method.LeaseRenew, params)
    ) {
      this.takeOver('游戏输入许可已失效或超出契约范围');
      return undefined;
    }
    link.lastSent = lease.token;
    void link.rpc.request(Method.LeaseRenew, params, { timeoutMs: interval }).then(
      (reply) => {
        if (this.#permit !== permit) return;
        if (!checkGameBridgeResult(Role.Core, Method.LeaseRenew, reply)) {
          this.takeOver('实时核许可回执无效');
          return;
        }
        permit.pending = false;
        permit.acknowledgedUntilMs = expiresAtMs;
        this.#recheck();
      },
      () => {
        if (this.#permit === permit) this.takeOver('实时核拒绝许可或未及时确认');
      },
    );
    return permit;
  }

  #clearTimer(): void {
    if (this.#timer) this.#clock.clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #requestStop(link: Link, token: number, reason: string, signal?: AbortSignal) {
    const ack = link.rpc
      .request(
        Method.InputStop,
        { throughToken: token, reason: reason.slice(0, 200) },
        signal ? { signal } : undefined,
      )
      .then(
        (result) =>
          checkGameBridgeResult(Role.Core, Method.InputStop, result) ? this.wireNowMs() : undefined,
        () => undefined,
      );
    link.stopAck = ack;
    return ack;
  }

  #stopInput(reason: string): void {
    this.#clearTimer();
    const permit = this.#permit;
    this.#permit = undefined;
    if (permit) this.#safety.release(permit.lease);
    this.#command?.abort(new Error('游戏命令在停止输入时撤回'));
    if (!permit) return;
    const { link } = permit;
    const token = link.lastSent;
    if (token < permit.lease.token) return;
    const release: Stopping = {
      link,
      token,
      atMs: this.#port.wireNowMs(),
      settled: Promise.withResolvers<boolean>(),
    };
    this.#release = release;
    if (this.#active(link)) {
      // 即使前一条续约尚未应答，也直接用同一控制连接吊销已发出的令牌。
      void this.#requestStop(link, token, reason).then((atMs) => {
        if (atMs === undefined) this.#ctx.log('game.stop-unconfirmed', {});
      });
    } else {
      release.settled.resolve(false);
      this.#release = undefined;
    }
  }

  #handleRelease(link: Link, release: GameInputReleased): void {
    const pending = this.#release;
    const completes =
      pending &&
      pending.link === link &&
      release.atMs >= pending.atMs &&
      release.token === (pending.token || null) &&
      (!pending.probe || release.reason === 'lease_revoked');
    if (completes && release.verification === 'verified') {
      pending.settled.resolve(true);
      this.#release = undefined;
    }
    // 进入这里的非空令牌已在 #received 核对为当前控制连接最后发送的令牌。
    const uncertain = release.token !== null && release.verification !== 'verified';
    if (requiresOperator.has(release.reason) || uncertain) {
      this.takeOver(`实时核停止输入（${release.reason}，${release.verification}）`);
      if (release.reason === 'emergency_stop') this.#port.emergencyStop('Game Runtime 本地急停');
    } else if (this.#permit && ['lease_expired', 'lease_revoked'].includes(release.reason)) {
      this.takeOver('实时核报告当前游戏许可失效');
    }
  }

  takeOver(reason: string): void {
    if (this.#manual) return;
    this.#manual = reason;
    this.#stopInput(reason);
    if (isLocalGameMode(this.#safety.mode)) this.#safety.requestDowngrade(reason);
    this.#safety.record(GameControlFact.Taken, { target: this.#legacyTarget, reason });
    this.#telemetry.reset('stopped');
  }

  returnControl(): GameControlResult {
    const availability = this.#availability();
    if (!this.#manual) return { ok: false, reason: '游戏没有处于人工接管状态' };
    if (!availability.ready) return { ok: false, reason: availability.reason };
    if (!this.#safety.record(GameControlFact.Returned, { target: this.#legacyTarget })) {
      return { ok: false, reason: '无法记录操作员交还控制' };
    }
    this.#manual = undefined;
    this.#recheck();
    return { ok: true };
  }

  #authorityConnection(controlTargetId: string): Waiting | AuthorityConnection {
    if (controlTargetId !== this.#ctx.config.controlTargetId) {
      return { ready: false, reason: '操作的槽位与当前可信配置不符' };
    }
    const connected = this.#connected();
    if (!connected.ready) return connected;
    const slot = this.#authoritySlot(controlTargetId);
    const { health, realtime } = connected;
    if (!slot || !('pendingActionOutcome' in health)) {
      return { ready: false, reason: '尚未核对槽位的完整持久回读' };
    }
    if (
      this.#permit ||
      this.#command ||
      realtime.leaseState === 'valid' ||
      realtime.leaseState === 'source_lost'
    ) {
      return { ready: false, reason: '等待实时核停止游戏输入并保持控制连接' };
    }
    return { ...connected, slot, health };
  }

  openTask(input: OperatorGameTaskOpenParams): Promise<GameControlResult> {
    const { controlTargetId } = input;
    const connected = this.#authorityConnection(controlTargetId);
    if (!connected.ready) return Promise.resolve({ ok: false, reason: connected.reason });
    const task = connected.slot.task;
    let payload: GameTaskOpenParams;
    if ('retryTaskId' in input) {
      if (!task || task.accepted || task.request.taskId !== input.retryTaskId) {
        return Promise.resolve({ ok: false, reason: '该编号没有待回读的开任务请求' });
      }
      payload = task.request;
    } else {
      payload = {
        taskId: randomUUID(),
        objective: input.objective,
        expiresAtMs: this.wireNowMs() + input.durationMs,
        overallCompletion: input.overallCompletion,
      };
    }
    return this.#executeAuthority(controlTargetId, connected, { method: Method.TaskOpen, payload });
  }

  resolveOutcome(input: OperatorGameOutcomeResolveParams): Promise<GameControlResult> {
    const { controlTargetId, reviewed, ...payload } = input;
    if (reviewed !== true) {
      return Promise.resolve({ ok: false, reason: '结案前须核对外部状态和输入释放' });
    }
    const connected = this.#authorityConnection(controlTargetId);
    if (!connected.ready) return Promise.resolve({ ok: false, reason: connected.reason });
    const settled = settledOutcome(connected.slot, payload.attemptId);
    if (settled) {
      if (
        connected.slot.pending.some(({ outcome }) => outcome.attemptId === payload.attemptId) ||
        (connected.health.pendingActionOutcome?.attemptId === payload.attemptId &&
          !sameAttempt(settled.outcome, connected.health.pendingActionOutcome))
      ) {
        return Promise.resolve({ ok: false, reason: '该物理尝试的原始身份冲突' });
      }
      return Promise.resolve(
        settled.outcome.sessionId === payload.sessionId && settled.resolution === payload.resolution
          ? { ok: true }
          : { ok: false, reason: '结案参数与持久回执不一致' },
      );
    }
    return this.#executeAuthority(controlTargetId, connected, {
      method: Method.ActionResolveOutcome,
      payload,
    });
  }

  #authorityBlocker(
    connection: AuthorityConnection,
    command: AuthorityCommand,
  ): string | undefined {
    const { slot, health, run } = connection;
    const current = health.pendingActionOutcome;
    if (command.method === Method.ActionResolveOutcome) {
      const { attemptId, sessionId, resolution } = command.payload;
      const pending = slot.pending.find(({ outcome }) => outcome.attemptId === attemptId);
      if (pending?.conflict) return '该物理尝试的原始身份冲突';
      if (!pending || pending.outcome.sessionId !== sessionId) {
        return '没有可核对的对应物理尝试';
      }
      if (
        pending.resolution &&
        (pending.resolution.request.resolution !== resolution ||
          !sameAttempt(pending.outcome, pending.resolution.outcome))
      ) {
        return '原结案结果待回读，只能精确重送原参数';
      }
      if (current ? !sameAttempt(current, pending.outcome) : !pending.resolution) {
        return '当前未决回读与原尝试不一致';
      }
      return undefined;
    }

    const isolation = this.#isolationBlocker(this.#ctx.config.controlTargetId);
    if (isolation) return isolation;
    if (current) return '游戏目标存在未决状态';
    if (health.riskLimitExceeded || !this.#prerequisitesMet(connection)) {
      return '游戏未满足风险或操作员前置条件';
    }
    const task = slot.task;
    if (command.payload.expiresAtMs <= this.wireNowMs()) return '授权任务已到期';
    if (task?.request.taskId === command.payload.taskId) {
      if (
        task.accepted ||
        !this.#authorityTaskIsCurrent(task, run) ||
        (health.activeTaskId !== null && health.activeTaskId !== task.request.taskId)
      )
        return '无法在当前会话回读原开任务请求';
      return undefined;
    }
    if (
      health.activeTaskId !== null ||
      (task && !task.ended && task.runtimeId === run && task.request.expiresAtMs > this.wireNowMs())
    )
      return '旧任务尚未终止或接纳结果待回读';
    return undefined;
  }

  async #verifyRelease(link: Link, signal: AbortSignal): Promise<Stopping> {
    const previousStop = link.stopAck;
    const previousAckAt = await previousStop;
    if (previousStop && previousAckAt === undefined) {
      throw new Error('先前停止请求的回执无法核对，需重新连接实时核');
    }
    // 控制 v1 用令牌和毫秒而非释放编号。先前停止的回执先于新请求，旧释放最迟在该回执前发生。
    // 保留握手允许的一毫秒舍入，再越过已收到的释放时刻，才发同一令牌的下一次停止。
    const watermark = () =>
      Math.max((previousAckAt ?? -Infinity) + 1, link.release?.atMs ?? -Infinity);
    let atMs = this.wireNowMs();
    while (atMs <= watermark()) {
      if (!(await sleepUnlessAborted(this.#clock, watermark() - atMs + 1, signal))) {
        throw new Error('等待新输入释放核验时连接已失效');
      }
      atMs = this.wireNowMs();
    }
    signal.throwIfAborted();
    const probe: Stopping = {
      link,
      token: link.lastSent,
      atMs,
      probe: true,
      settled: Promise.withResolvers<boolean>(),
    };
    this.#release?.settled.resolve(false);
    this.#release = probe;
    try {
      const [ackAtMs, verified] = await withDeadline(
        this.#clock,
        Promise.all([
          this.#requestStop(link, probe.token, '操作员核对游戏授权前释放输入', signal),
          probe.settled.promise,
        ]),
        RPC_MS,
        '实时核输入释放核验',
      );
      if (!verified || ackAtMs === undefined) {
        throw new Error('实时核未核验输入已释放');
      }
      return probe;
    } finally {
      if (this.#release === probe) this.#release = undefined;
    }
  }

  #settleEarlierDispatches(
    method: AuthorityCommand['method'],
    ids: readonly number[],
    outcome: Outcome,
  ): void {
    if (!ids.length) return;
    for (const intent of this.#safety.unresolved(method)) {
      if (ids.includes(intent.id)) this.#safety.reconcile(intent, outcome);
    }
  }

  async #executeAuthority(
    controlTargetId: string,
    initial: AuthorityConnection,
    command: AuthorityCommand,
  ): Promise<GameControlResult> {
    if (this.#authorityCommand) return { ok: false, reason: '已有在途游戏授权命令' };
    const { method, payload } = command;
    if (!checkGameBridgeParams(Role.Main, 'bellis', method, payload, GAME_BRIDGE_SEMANTIC_V2)) {
      return { ok: false, reason: '游戏授权命令不符合契约' };
    }
    const blocker = this.#authorityBlocker(initial, command);
    if (blocker) return { ok: false, reason: blocker };
    const originalAttempt =
      command.method === Method.ActionResolveOutcome
        ? initial.slot.pending.find(
            ({ outcome }) => outcome.attemptId === command.payload.attemptId,
          )?.outcome
        : undefined;

    const controller = new AbortController();
    this.#authorityCommand = controller;
    const { signal } = controller;
    const opening = method === Method.TaskOpen;
    // 单次发报单独隔离，物理隔离保存在槽位上。只有精确回读可获得另一份发报授权。
    const dispatch = randomUUID();
    const recheck = () => {
      const current = this.#authorityConnection(controlTargetId);
      if (
        signal.aborted ||
        this.#ctx.signal.aborted ||
        !current.ready ||
        current.main !== initial.main ||
        current.core !== initial.core
      )
        throw new Error('发送前游戏授权连接已失效');
      const reason = this.#authorityBlocker(current, command);
      if (reason) throw new Error(reason);
      return current;
    };
    try {
      const authorization = await this.#safety.authorize({
        key: `game-authority:${dispatch}`,
        type: method,
        target: `game:authority:${controlTargetId}/${dispatch}`,
        payload,
        source: { origin: 'operator', inputs: [], untrusted: false },
        capabilities: [opening ? GAME_TASK_OPEN : GAME_RESOLVE_OUTCOME],
        timeSensitive: false,
      });
      if (!authorization.allowed) return { ok: false, reason: authorization.reason };
      if (authorization.duplicate) return { ok: false, reason: '游戏授权发报编号已使用' };
      const { intent: authorizedIntent } = authorization;
      const intent = await this.#safety.execute(authorizedIntent, payload, async (request) => {
        const { core } = recheck();
        const release = await this.#verifyRelease(core, signal);
        const current = recheck();
        if (
          core.release?.verification !== 'verified' ||
          core.release.reason !== 'lease_revoked' ||
          core.release.token !== (release.token || null) ||
          core.release.atMs < release.atMs
        )
          throw new Error('发送前的输入释放核验失效');

        const { slot, run, main } = current;
        let previous: readonly number[] = [];
        if (command.method === Method.TaskOpen) {
          const task = slot.task;
          if (task?.request.taskId === command.payload.taskId) {
            previous = task.dispatches;
          } else if (task?.dispatches.length) {
            this.#settleEarlierDispatches(method, task.dispatches, {
              ok: false,
              error: '旧任务已终止，接纳回执未知',
            });
            if (!this.#safety.record(GameAuthorityFact.TaskRetired, { controlTargetId })) {
              throw new Error('无法持久记录旧任务已终止');
            }
          }
        } else {
          const pending = slot.pending.find(
            ({ outcome }) => outcome.attemptId === command.payload.attemptId,
          );
          if (!pending || !originalAttempt || !sameAttempt(pending.outcome, originalAttempt)) {
            throw new Error('发送前物理尝试的原始身份改变');
          }
          previous = pending.resolution?.dispatches ?? [];
        }
        if (
          !this.#safety.record(
            opening ? GameAuthorityFact.TaskDispatched : GameAuthorityFact.OutcomeDispatched,
            {
              controlTargetId,
              request,
              intentId: authorizedIntent.id,
              runtimeId: run,
              hostSessionId: this.#port.sessionId,
            },
          )
        )
          throw new Error('无法持久记录本次游戏授权发报');

        let reply: unknown;
        try {
          reply = await main.rpc.request(method, request, { signal });
        } catch (error) {
          if (error instanceof RpcError && refusedBeforeExecution.has(error.code)) {
            throw new Error(`Game Runtime 明确拒绝授权命令（${error.code}）`);
          }
          throw new IntentOutcomeUnknown('游戏授权回执未知，等待原请求回读');
        }
        const result = reply as Record<string, unknown>;
        const pending =
          originalAttempt &&
          this.#authoritySlot(controlTargetId)?.pending.find(
            ({ outcome }) => outcome.attemptId === originalAttempt.attemptId,
          );
        if (
          !this.#active(main) ||
          signal.aborted ||
          !checkGameBridgeResult(Role.Main, method, reply, GAME_BRIDGE_SEMANTIC_V2) ||
          (command.method === Method.TaskOpen
            ? result.taskId !== command.payload.taskId
            : result.attemptId !== command.payload.attemptId ||
              result.resolution !== command.payload.resolution ||
              !originalAttempt ||
              !pending ||
              pending.conflict ||
              !sameAttempt(pending.outcome, originalAttempt) ||
              pending.resolution?.dispatches.at(-1) !== authorizedIntent.id)
        )
          throw new IntentOutcomeUnknown('游戏授权回执无法与原请求核对');
        const receipt = { method, controlTargetId, ...result };
        try {
          this.#settleEarlierDispatches(method, previous, { ok: true, result: receipt });
        } catch {
          throw new IntentOutcomeUnknown('当前回执有效，尚未持久核对先前的发报');
        }
        return receipt;
      });
      if (intent.state !== 'succeeded') {
        return { ok: false, reason: intent.error ?? '游戏授权命令未完成' };
      }
      if (originalAttempt) {
        const slot = this.#authoritySlot(controlTargetId);
        if (
          !slot ||
          !settledOutcome(slot, originalAttempt.attemptId) ||
          slot.pending.some(({ outcome }) => outcome.attemptId === originalAttempt.attemptId)
        )
          return { ok: false, reason: '无法持久确认原尝试结案，保持隔离' };
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : '游戏授权命令失败' };
    } finally {
      this.#authorityCommand = undefined;
      this.#recheck();
    }
  }

  submitGoal(
    payload: GameGoalSubmitParams,
    source: IntentSource,
    stillValid?: () => boolean,
  ): Promise<GameCommandResult> {
    return this.#execute({ method: Method.GoalSubmit, payload }, source, stillValid);
  }

  resolveDecision(
    payload: GameDecisionResolveParams,
    source: IntentSource,
    stillValid?: () => boolean,
  ): Promise<GameCommandResult> {
    return this.#execute({ method: Method.DecisionResolve, payload }, source, stillValid);
  }

  #commandBlocker(command: GameCommand): string | undefined {
    const now = this.#port.wireNowMs();
    const point = this.#decision?.latest;
    if (command.payload.localRecovery) {
      const scope = this.#safety.localRecovery;
      if (!scope || !isDeepStrictEqual(command.payload.localRecovery, scope))
        return '不属于当前本机恢复授权';
      if (scope.kind === 'recover' || scope.kind === 'load') {
        if (command.method !== Method.GoalSubmit || point)
          return '本机读档授权只适用于当前恢复步骤';
      } else if (
        command.method !== Method.DecisionResolve ||
        command.payload.source !== 'operator' ||
        command.payload.optionId !== scope.optionId ||
        command.payload.decisionPointId !== scope.decisionPointId ||
        !point ||
        point.timing !== null ||
        (scope.kind === 'named' && scope.optionsDigest !== gameChoiceOptionsDigest(point.options))
      ) {
        return '本机选择只适用于当前已授权的无计时选项';
      }
    } else if (
      this.#safety.mode === 'local-recovery' ||
      this.#safety.mode === 'local-choice' ||
      (command.method === Method.DecisionResolve && command.payload.source === 'operator')
    ) {
      return '缺少本机恢复授权';
    }
    if (command.method === Method.GoalSubmit) {
      if (command.payload.mode === 'manual') return '人工接管只能由操作员执行';
      if (command.payload.expiresAtMs <= now) return '游戏目标已过期';
      if (command.payload.mode !== 'waiting_vote') return undefined;
    } else if (!point?.options.some(({ id }) => id === command.payload.optionId)) {
      return '选项不属于当前决策点';
    }
    if (!point || command.payload.decisionPointId !== point.decisionPointId) return '决策点已更换';
    if (point.timing && (command.method === Method.GoalSubmit || now >= point.timing.resolveByMs)) {
      return '计时决策点不可投票或已到余量线';
    }
    return undefined;
  }

  #blockedReason(command: GameCommand): 'expired' | 'stale' {
    const now = this.wireNowMs();
    const point = this.#decision?.latest;
    const expired =
      command.method === Method.GoalSubmit
        ? command.payload.expiresAtMs <= now
        : point?.decisionPointId === command.payload.decisionPointId &&
          point.timing !== null &&
          point.timing.resolveByMs <= now;
    return expired ? 'expired' : 'stale';
  }

  async #execute(
    command: GameCommand,
    source: IntentSource,
    stillValid?: () => boolean,
  ): Promise<GameCommandResult> {
    const localDialogue = this.#safety.localDialogue;
    const localScope = localDialogue ?? this.#safety.localRecovery;
    if (this.#safety.mode === 'local-dialogue') {
      if (
        !localDialogue ||
        command.method !== Method.GoalSubmit ||
        command.payload.localRecovery !== undefined ||
        !isDeepStrictEqual(command.payload.localDialogue, localDialogue)
      )
        return { ok: false, reason: '不属于当前本机对白授权' };
    } else if (command.method === Method.GoalSubmit && command.payload.localDialogue) {
      return { ok: false, reason: '当前模式不接受本机对白目标' };
    }
    const availability = this.#availability();
    const permit = this.#permit;
    if (!availability.ready) return { ok: false, reason: availability.reason };
    if (!permit || !this.#usable(permit))
      return { ok: false, reason: '没有有效且已确认的游戏输入许可' };
    if (!checkGameBridgeParams(Role.Main, 'bellis', command.method, command.payload)) {
      return { ok: false, reason: '游戏命令不符合契约' };
    }
    const checked = structuredClone(command);
    const { main, run, task } = availability;
    let payload = checked.payload;
    if (task && checked.method === Method.GoalSubmit) {
      checked.payload.expiresAtMs = Math.min(checked.payload.expiresAtMs, task.expiresAtMs);
      payload = { ...checked.payload, taskId: task.taskId } as GameGoalSubmitParams;
    }
    if (!checkGameBridgeParams(Role.Main, 'bellis', command.method, payload, main.major)) {
      return { ok: false, reason: '当前会话的游戏命令不符合契约' };
    }
    const blocker = this.#commandBlocker(checked);
    if (blocker) {
      this.#telemetry.discarded('game.command', payload.traceparent, this.#blockedReason(checked));
      return { ok: false, reason: blocker };
    }
    if (this.#command) return { ok: false, reason: '已有在途游戏命令' };
    const controller = new AbortController();
    this.#command = controller;
    const id =
      checked.method === Method.GoalSubmit
        ? checked.payload.goalId
        : checked.payload.decisionPointId;
    const key = JSON.stringify(['game', command.method, run, id]);
    let observeResult: ReturnType<GameTelemetry['sent']>;
    let prepared: ReturnType<GameTelemetry['prepare']> | undefined;
    let unsentReason: 'expired' | 'stale' = 'stale';
    let outcome: 'accepted' | 'refused' | 'unknown' = 'unknown';
    try {
      const decision = await this.#safety.authorize({
        key,
        type: command.method,
        target: this.#target,
        payload,
        source,
        capabilities: [GAME_GOAL],
        timeSensitive: true,
      });
      if (!decision.allowed) return { ok: false, reason: decision.reason };
      if (decision.duplicate) {
        this.#telemetry.discarded('game.command', payload.traceparent, 'duplicate');
        return decision.intent.state === 'succeeded'
          ? { ok: true, intent: decision.intent, duplicate: true }
          : {
              ok: false,
              intent: decision.intent,
              reason: `游戏意图已有记录（${decision.intent.state}）`,
            };
      }
      const intent = await this.#safety.execute(decision.intent, payload, async (authorized) => {
        prepared = this.#telemetry.prepare(run, checked);
        const current = this.#availability();
        if (
          !current.ready ||
          current.main !== main ||
          current.task?.taskId !== task?.taskId ||
          !this.#usable(permit) ||
          controller.signal.aborted
        ) {
          throw new Error('发送前游戏连接或输入许可已失效');
        }
        const changed = this.#commandBlocker(checked);
        if (changed) {
          unsentReason = this.#blockedReason(checked);
          throw new Error(changed);
        }
        if (stillValid && !stillValid()) throw new Error('发起命令时的游戏局面已失效');
        const timeoutMs = localScope
          ? Math.min(LOCAL_DIALOGUE_GOAL_RPC_MS, localScope.expiresAtMs - this.wireNowMs())
          : undefined;
        if (timeoutMs !== undefined && timeoutMs <= 0) throw new Error('本机游戏授权已到期');
        try {
          // 执行闸门核对过语义载荷。发送时只替换本次 RPC 的追踪上下文。
          const pending = main.rpc.request(
            command.method,
            { ...authorized, traceparent: prepared.traceparent },
            { signal: controller.signal, ...(timeoutMs === undefined ? {} : { timeoutMs }) },
          );
          if (checked.method === Method.DecisionResolve && this.#decision)
            this.#decision.resolveSent = true;
          observeResult = this.#telemetry.sent(
            run,
            checked,
            prepared,
            this.wireNowMs(),
            checked.method === Method.DecisionResolve ? this.#decision?.latest.timing : undefined,
          );
          prepared = undefined;
          const reply = await pending;
          if (!checkGameBridgeResult(Role.Main, command.method, reply, main.major))
            throw new Error('游戏命令回执无效');
          return { accepted: true };
        } catch (error) {
          if (error instanceof RpcError && refusedBeforeExecution.has(error.code)) {
            if (localScope && 'kind' in localScope && localScope.kind === 'named') {
              this.#ctx.log('game.local-choice.refused', {
                code: error.code,
              });
              if (error.code === RpcErrorCode.InvalidParams)
                throw new Error(NAMED_CHOICE_INVALID_PARAMS);
            }
            throw new Error(`Game Runtime 明确拒绝游戏命令（${error.code}）`);
          }
          this.#stopInput('游戏命令执行结果未知');
          throw new IntentOutcomeUnknown('游戏命令已尝试发送，执行结果未知');
        }
      });
      outcome =
        intent.state === 'succeeded'
          ? 'accepted'
          : intent.state === 'unknown'
            ? 'unknown'
            : 'refused';
      return intent.state === 'succeeded'
        ? { ok: true, intent, duplicate: false }
        : { ok: false, reason: intent.error ?? '游戏意图未完成', intent };
    } finally {
      if (prepared) this.#telemetry.unsent(prepared, unsentReason);
      observeResult?.(outcome);
      this.#command = undefined;
      this.#recheck();
    }
  }

  async quiesce(): Promise<void> {
    this.#stopInput('游戏桥卸载');
    if (this.#release && !(await this.#release.settled.promise)) {
      throw new Error('未核验到实时核释放输入');
    }
  }

  dispose(): void {
    this.#stopInput('游戏桥已关闭');
    this.#disposed = true;
    this.#telemetry.reset('unloaded');
    this.#release?.settled.resolve(false);
    for (const link of this.#links.values()) link.rpc.connection.close();
    this.#links.clear();
    this.#listeners.clear();
  }
}
