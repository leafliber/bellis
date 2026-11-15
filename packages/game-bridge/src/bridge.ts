import { ChannelError, type Connection, RpcError, RpcPeer } from '@bellis/channel';
import type { Clock, PluginContext, TimerHandle } from '@bellis/kernel';
import {
  checkGameBridgeMessage,
  checkGameBridgeParams,
  checkGameBridgeResult,
  GAME_BRIDGE_MAJOR,
  type GameCoreDescription,
  type GameCoreHealth,
  type GameDecisionPointOpened,
  type GameDecisionResolveParams,
  type GameGoalSubmitParams,
  type GameInputReleased,
  type GameMainDescription,
  type GameMainHealth,
  GameBridgeMethod as Method,
  GameBridgeRole as Role,
  RpcCancel,
  RpcErrorCode,
  RpcFailure,
  RpcNotification,
  type RpcParams,
  RpcSuccess,
  readGameBridgeMajor,
} from '@bellis/protocol';
import { isRealOutput, type Lease, type SafetyFacade } from '@bellis/safety';
import { IntentOutcomeUnknown, type IntentSource } from '@bellis/store';
import { Compile } from 'typebox/compile';
import type { GameControlResult, GameRuntimeHost } from './host.ts';
import {
  GAME_GOAL,
  GAME_INPUT,
  type Game,
  type GameCommandResult,
  GameControlFact,
  type GameEvent,
  type GameFact,
  type GameStatus,
  gameControlLedger,
} from './service.ts';

export interface GameBridgeConfig {
  adapterId: string;
  adapterVersion: string;
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

type Health = GameMainHealth | GameCoreHealth;
type Description = GameMainDescription | GameCoreDescription;
type Command =
  | { method: typeof Method.GoalSubmit; payload: GameGoalSubmitParams }
  | { method: typeof Method.DecisionResolve; payload: GameDecisionResolveParams };

interface Link {
  role: Role;
  rpc: RpcPeer;
  description?: Description;
  reason?: string;
  health?: Health;
  earlyHealth?: Health;
  lastSent: number;
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
}

type Availability =
  | { ready: false; reason: string }
  | { ready: true; main: Link; core: Link; run: string; healthFor: number };

/** 单个插件实例拥有两个会话槽位、在途命令和输入许可。 */
export class GameBridge implements Game {
  readonly #ctx: PluginContext<GameBridgeConfig>;
  readonly #port: GameRuntimeHost['port'];
  readonly #clock: Clock;
  readonly #safety: SafetyFacade;
  readonly #target: string;
  readonly #links = new Map<Role, Link>();
  readonly #listeners = new Set<(fact: GameFact) => void>();
  readonly #seen = new Set<string>();
  #seenRun: string | undefined;
  #decision: GameDecisionPointOpened | undefined;
  #manual: string | undefined;
  #permit: Permit | undefined;
  #release: Stopping | undefined;
  #timer: TimerHandle | undefined;
  #command: AbortController | undefined;
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
    this.#target = `game:${ctx.config.adapterId}`;
    this.#manual = safety.view(gameControlLedger)[this.#target];
  }

  start(): void {
    const { signal } = this.#ctx;
    this.#ctx.register(() => this.dispose());
    this.#ctx.register(this.#port.register(this));
    this.#ctx.register(
      this.#safety.onLease(({ resource, lease }) => {
        if (resource === GAME_INPUT && !lease) this.#stopInput('安全核吊销游戏输入许可');
      }),
    );
    this.#ctx.register(
      this.#safety.onControl((event) => {
        if (event.kind === 'stop') this.#stopInput(event.reason);
        else if (event.kind === 'mode') this.#recheck();
      }),
    );
    const onQuiesce = () => this.#stopInput('游戏桥静止中');
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
      lastSent: 0,
      rpc: new RpcPeer(connection, {
        timeoutMs: RPC_MS,
        acceptIncoming: (message) => {
          if (isSuccess.Check(message) || isFailure.Check(message)) return true;
          if (!isNotification.Check(message)) return false;
          // 握手正文核对前只暂存一条已按 v1 核对的健康消息。
          return (
            !link.description ||
            message.method === RpcCancel ||
            checkGameBridgeMessage(role, 'runtime', message)
          );
        },
      }),
    };
    this.#links.set(role, link);
    connection.once('close', () => {
      if (this.#links.get(role) !== link) return;
      this.#links.delete(role);
      if (role === Role.Main) this.#decision = undefined;
      this.#recheck();
      if (this.#release?.link === link) {
        this.#release.settled.resolve(false);
        this.#release = undefined;
      }
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
      const reply = await link.rpc.request(Method.Describe, { major: GAME_BRIDGE_MAJOR });
      if (!this.#active(link)) return;
      const major = readGameBridgeMajor(reply);
      if (major === undefined) throw new Error('握手缺少合法的主版本');
      if (major !== GAME_BRIDGE_MAJOR) {
        throw new Error(`主版本不兼容（Bellis ${GAME_BRIDGE_MAJOR}，Game Runtime ${major}）`);
      }
      if (!checkGameBridgeResult(link.role, Method.Describe, reply)) {
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
        // 同一 Runtime 在主连接重连后可能重复送达一条事实。
        if (this.#seenRun !== description.runtimeId) {
          this.#seen.clear();
          this.#seenRun = description.runtimeId;
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

  #availability(): Availability {
    const main = this.#links.get(Role.Main);
    const core = this.#links.get(Role.Core);
    const reason = main?.reason ?? core?.reason;
    if (reason) return { ready: false, reason };
    if (!main?.description || !core?.description || !this.#active(main) || !this.#active(core)) {
      return { ready: false, reason: '等待语义与控制连接完成握手' };
    }
    const run = this.#pairedRun();
    if (run === undefined) return { ready: false, reason: '两条连接的 Runtime 会话不一致' };
    if (this.#safety.isIsolated(this.#target)) {
      return { ready: false, reason: '游戏目标已隔离或状态存储不可用' };
    }
    if (this.#release) return { ready: false, reason: '等待实时核核验输入释放' };
    const health = main.health as GameMainHealth | undefined;
    const realtime = core.health as GameCoreHealth | undefined;
    if (!health || !realtime) return { ready: false, reason: '等待两条连接上报健康' };
    const healthFor =
      Math.min(health.atMs, realtime.atMs) +
      (this.#ctx.config.healthTimeoutMs ?? DEFAULT_HEALTH_MS) -
      this.#port.wireNowMs();
    if (healthFor <= 0) return { ready: false, reason: 'Game Runtime 健康上报已过期' };
    if (!health.ready || health.riskLimitExceeded || realtime.leaseState === 'source_lost') {
      return { ready: false, reason: 'Game Runtime 尚未就绪或报告了安全风险' };
    }
    const declared = (main.description as GameMainDescription).prerequisites;
    if (
      declared.length !== health.prerequisites.length ||
      !declared.every((item) =>
        health.prerequisites.some(
          ({ id, text, confirmed }) => id === item.id && text === item.text && confirmed,
        ),
      )
    ) {
      return { ready: false, reason: '操作员前置条件未全部确认或声明不一致' };
    }
    return { ready: true, main, core, run, healthFor };
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
      health: (main?.health as GameMainHealth | undefined) ?? null,
      realtimeHealth: (core?.health as GameCoreHealth | undefined) ?? null,
      decision: this.#decision ?? null,
      inputPermitted: availability.ready && !!this.#permit && this.#usable(this.#permit),
    };
    return structuredClone(status);
  }

  wireNowMs(): number {
    return this.#port.wireNowMs();
  }

  subscribe(listener: (fact: GameFact) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #received(link: Link, method: GameEvent['method'], params: RpcParams): void {
    if (!this.#active(link) || !checkGameBridgeParams(link.role, 'runtime', method, params)) return;
    if (!link.description) {
      if (method === Method.HealthReported && !link.reason)
        link.earlyHealth = params as unknown as Health;
      return;
    }
    const payload = params as unknown as GameEvent['payload'];
    if (payload.atMs < link.description.nowMs - 1 || payload.atMs > this.#port.wireNowMs() + 1)
      return;
    const currentRun = this.#pairedRun();
    if (
      !currentRun &&
      method !== Method.HealthReported &&
      !(method === Method.InputReleased && link.lastSent > 0)
    )
      return;

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
      this.#handleRelease(link, event.payload);
    }
    const id =
      event.method === Method.ActionCommitted
        ? JSON.stringify([event.method, event.payload.actionId])
        : event.method === Method.DecisionPointOpened
          ? JSON.stringify([event.method, event.payload.decisionPointId])
          : undefined;
    if (id !== undefined && this.#seen.has(id)) return;

    const runtimeId = link.description.runtimeId;
    const committed = this.#safety.record(method, { runtimeId, role: link.role, payload });
    if (!committed) {
      this.#stopInput('游戏事实无法持久化');
      return;
    }
    if (id !== undefined) this.#seen.add(id);
    if (event.method === Method.HealthReported) {
      link.health = event.payload;
      if (
        link.role === Role.Main &&
        this.#decision &&
        event.payload.atMs > this.#decision.atMs &&
        (event.payload as GameMainHealth).decisionPointId !== this.#decision.decisionPointId
      ) {
        this.#decision = undefined;
      }
    } else if (event.method === Method.DecisionPointOpened) {
      this.#decision = event.payload;
    } else if (
      event.method === Method.ActionCommitted &&
      event.payload.selection?.decisionPointId === this.#decision?.decisionPointId
    ) {
      this.#decision = undefined;
    }
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
      Math.max(1, Math.min(availability.healthFor, next - this.#clock.now())),
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
    const expiresAtMs = wireNow + Math.floor(lease.expiresAt - this.#clock.now());
    const params = { token: lease.token, expiresAtMs };
    if (
      !this.#active(link) ||
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
      const unconfirmed = () => this.#ctx.log('game.stop-unconfirmed', {});
      void link.rpc
        .request(Method.InputStop, { throughToken: token, reason: reason.slice(0, 200) })
        .then((result) => {
          if (!checkGameBridgeResult(Role.Core, Method.InputStop, result)) unconfirmed();
        }, unconfirmed);
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
      release.token === pending.token;
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
    this.#safety.record(GameControlFact.Taken, { target: this.#target, reason });
  }

  returnControl(): GameControlResult {
    const availability = this.#availability();
    if (!this.#manual) return { ok: false, reason: '游戏没有处于人工接管状态' };
    if (!availability.ready) return { ok: false, reason: availability.reason };
    if (!this.#safety.record(GameControlFact.Returned, { target: this.#target })) {
      return { ok: false, reason: '无法记录操作员交还控制' };
    }
    this.#manual = undefined;
    this.#recheck();
    return { ok: true };
  }

  submitGoal(payload: GameGoalSubmitParams, source: IntentSource): Promise<GameCommandResult> {
    return this.#execute({ method: Method.GoalSubmit, payload }, source);
  }

  resolveDecision(
    payload: GameDecisionResolveParams,
    source: IntentSource,
  ): Promise<GameCommandResult> {
    return this.#execute({ method: Method.DecisionResolve, payload }, source);
  }

  #commandBlocker(command: Command): string | undefined {
    const now = this.#port.wireNowMs();
    const point = this.#decision;
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

  async #execute(command: Command, source: IntentSource): Promise<GameCommandResult> {
    const availability = this.#availability();
    const permit = this.#permit;
    if (!availability.ready) return { ok: false, reason: availability.reason };
    if (!permit || !this.#usable(permit))
      return { ok: false, reason: '没有有效且已确认的游戏输入许可' };
    if (!checkGameBridgeParams(Role.Main, 'bellis', command.method, command.payload)) {
      return { ok: false, reason: '游戏命令不符合契约' };
    }
    const payload = structuredClone(command.payload);
    const checked = { ...command, payload } as Command;
    const blocker = this.#commandBlocker(checked);
    if (blocker) return { ok: false, reason: blocker };
    if (this.#command) return { ok: false, reason: '已有在途游戏命令' };
    const controller = new AbortController();
    this.#command = controller;
    const { main, run } = availability;
    const id =
      checked.method === Method.GoalSubmit
        ? checked.payload.goalId
        : checked.payload.decisionPointId;
    const key = JSON.stringify(['game', command.method, run, id]);
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
        return decision.intent.state === 'succeeded'
          ? { ok: true, intent: decision.intent, duplicate: true }
          : {
              ok: false,
              intent: decision.intent,
              reason: `游戏意图已有记录（${decision.intent.state}）`,
            };
      }
      const intent = await this.#safety.execute(decision.intent, payload, async () => {
        const current = this.#availability();
        if (
          !current.ready ||
          current.main !== main ||
          !this.#usable(permit) ||
          controller.signal.aborted
        ) {
          throw new Error('发送前游戏连接或输入许可已失效');
        }
        const changed = this.#commandBlocker(checked);
        if (changed) throw new Error(changed);
        try {
          const reply = await main.rpc.request(command.method, payload, {
            signal: controller.signal,
          });
          if (!checkGameBridgeResult(Role.Main, command.method, reply))
            throw new Error('游戏命令回执无效');
          return { accepted: true };
        } catch (error) {
          if (error instanceof RpcError && refusedBeforeExecution.has(error.code)) {
            throw new Error(`Game Runtime 明确拒绝游戏命令（${error.code}）`);
          }
          this.#stopInput('游戏命令执行结果未知');
          throw new IntentOutcomeUnknown('游戏命令已尝试发送，执行结果未知');
        }
      });
      return intent.state === 'succeeded'
        ? { ok: true, intent, duplicate: false }
        : { ok: false, reason: intent.error ?? '游戏意图未完成', intent };
    } finally {
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
    this.#release?.settled.resolve(false);
    for (const link of this.#links.values()) link.rpc.connection.close();
    this.#links.clear();
    this.#listeners.clear();
  }
}
