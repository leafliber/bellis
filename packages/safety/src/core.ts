import {
  type Clock,
  type KernelSafetyHooks,
  type TimerHandle,
  type Transition,
  withDeadline,
} from '@bellis/kernel';
import type { EmergencyPolicy } from '@bellis/obs';
import {
  type Intent,
  type IntentSource,
  type Outcome,
  payloadHash,
  ResourceIsolated,
  type StateStore,
  StoreUnavailable,
} from '@bellis/store';
import { ControlChannel } from './control.ts';
import type { EmergencyObs, ObsChange } from './emergency.ts';
import { type Lease, Leases } from './leases.ts';
import { type RateLimit, RateLimiter } from './rate.ts';
import {
  downgradeTarget,
  type Mode,
  preconditionBlocker,
  producesOutput,
  type UpgradeContext,
  upgradeBlocker,
} from './supervision.ts';

export interface SafetyConfig {
  /** `sim` profile：只允许 M0，只连模拟设备。 */
  simulation: boolean;
  /** 各资源的许可时长（D-34，均待实测）。 */
  leaseTtlMs: Readonly<Record<string, number>>;
  /** 持有各资源许可所需的能力，例如 `stage.audio` 需要 `speech.output`。 */
  leaseCapabilities: Readonly<Record<string, string>>;
  /** M2 的在场确认有效期。 */
  presenceTtlMs: number;
  /** 按能力限速；超限即拒绝并降级。 */
  rateLimits: Readonly<Record<string, RateLimit>>;
  /** 单个守卫的截止时间。 */
  guardTimeoutMs: number;
  emergency: EmergencyPolicy;
  /** 进入无人值守的其余门槛是否已登记满足（数值待定，见安全核）。 */
  unattendedGatesSatisfied: boolean;
}

/** 一次对外动作的申请。 */
export interface IntentRequest {
  /** 提出意图的插件实例。 */
  holder: string;
  key: string;
  type: string;
  target: string;
  /** 载荷本身；闸门只记录它的摘要。 */
  payload: unknown;
  source: IntentSource;
  capabilities: readonly string[];
  timeSensitive: boolean;
}

export type Decision =
  | { allowed: true; intent: Intent; duplicate: boolean }
  | { allowed: false; reason: string };

/** 守卫只能拒绝或弃权（返回 undefined）。 */
export type GuardVerdict = { deny: string } | undefined;
export type Guard = (request: Readonly<IntentRequest>) => GuardVerdict | Promise<GuardVerdict>;

export type LeaseResult = { ok: true; lease: Lease } | { ok: false; reason: string };

export interface EmergencyReport {
  reason: string;
  revoked: number;
  obs: { ok: boolean; error?: string };
}

/** 外部看门狗的应急动作报告。 */
export interface WatchdogReport {
  reason: string;
  ok: boolean;
  actedAt: string;
}

export interface SafetyOptions {
  store: StateStore;
  clock: Clock;
  config: SafetyConfig;
  obs: EmergencyObs;
  /** 插件实例被授予的权限（来自插件内核）。 */
  permissionsOf(holder: string): ReadonlySet<string> | undefined;
  watchdogConnected(): boolean;
  log?(event: string, fields: Record<string, unknown>): void;
}

/**
 * 安全停止下允许的动作之一：把会话令牌写进 Stage 浏览器源的 URL。只申请这一能力的意图、
 * 这一资源的许可，在安全停止下照常判定与授予；维护态与存储不可用时仍拒绝（见安全核“监督模式”）。
 */
export const STAGE_URL = 'obs.stage-url';

/**
 * 安全停止下允许的动作之二：写 Iris（记忆的写入，见记忆“写入”）。只申请这一能力的意图在安全停止下照常判定；
 * 维护态与存储不可用时仍拒绝，Rule of Two 等其它检查照旧。它没有执行许可。
 */
export const MEMORY_WRITE = 'memory.write';

/** 安全停止下照常判定的能力：都不是观众能看到或听到的输出（见安全核“监督模式”）。 */
const SAFE_STOP_EXEMPT: ReadonlySet<string> = new Set([STAGE_URL, MEMORY_WRITE]);

/** 真实输出模式：OBS 的外部变化只在这些模式下按急停处理（M0 只连模拟设备）。 */
const REAL_OUTPUT: ReadonlySet<Mode> = new Set(['M1', 'M2', 'M3']);

/** OBS 外部变化按急停处理时的原因。可能是热键，也可能是手动操作，不断言是热键。 */
export const OBS_EXTERNAL_REASON = {
  scene: 'OBS 外部切到安全场景',
  mute: 'OBS 外部静音了 Stage 源',
} as const;

/** 含不可信输入的意图永远不能申请的能力（Rule of Two）。 */
const UNTRUSTED_FORBIDDEN = new Set([
  'obs.scene',
  'obs.audio',
  'obs.source',
  STAGE_URL,
  'obs.stream',
  'secret.read',
  'memory.private',
]);

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 安全核（D-15）：随宿主装配，不经过插件加载器，不能被 profile 移除，永不热替换。
 * 监督模式、在场确认与维护态以内存为准，事件只作记录：写入失败不能阻止降级、急停或拒绝。
 * 重启后总是从安全停止开始。
 */
export class SafetyCore {
  readonly control: ControlChannel;
  readonly leases: Leases;
  /** 状态存储；只给宿主装配与执行意图用，不交给插件。 */
  readonly store: StateStore;
  readonly #store: StateStore;
  readonly #clock: Clock;
  readonly #config: SafetyConfig;
  readonly #obs: EmergencyObs;
  readonly #permissionsOf: (holder: string) => ReadonlySet<string> | undefined;
  readonly #watchdogConnected: () => boolean;
  readonly #log: (event: string, fields: Record<string, unknown>) => void;
  readonly #rate: RateLimiter;
  readonly #guards = new Set<Guard>();
  #mode: Mode = 'safe-stop';
  #presenceUntil = Number.NEGATIVE_INFINITY;
  #presenceTimer: TimerHandle | undefined;
  #maintenance = false;
  #moderation: boolean | undefined;
  #obsRun: Promise<EmergencyReport['obs']> | undefined;

  constructor(options: SafetyOptions) {
    this.#store = options.store;
    this.store = options.store;
    this.#clock = options.clock;
    this.#config = options.config;
    this.#obs = options.obs;
    this.#permissionsOf = options.permissionsOf;
    this.#watchdogConnected = options.watchdogConnected;
    this.#log = options.log ?? (() => {});
    this.#rate = new RateLimiter(options.clock, options.config.rateLimits);
    this.control = new ControlChannel((error) =>
      this.#log('control.listener-failed', { error: message(error) }),
    );
    this.leases = new Leases(options.store, options.clock, options.config.leaseTtlMs, this.#log);
    this.#record('safety.started', { simulation: options.config.simulation, mode: this.#mode });
    options.obs.watch?.({
      change: (change) => this.#onObsChange(change, false),
      connected: () => this.#resyncObs(),
    });
  }

  get mode(): Mode {
    return this.#mode;
  }

  get maintenance(): boolean {
    return this.#maintenance;
  }

  /** 急停时静音的 Stage 源，也是写 Stage URL 唯一允许的目标。 */
  get stageSource(): string {
    return this.#config.emergency.stageSource;
  }

  get moderationEnabled(): boolean | undefined {
    return this.#moderation;
  }

  presenceValid(): boolean {
    return this.#clock.now() < this.#presenceUntil;
  }

  /** 在场确认还剩多久有效（毫秒）；无效时为 0。 */
  presenceRemainingMs(): number {
    const remaining = this.#presenceUntil - this.#clock.now();
    return Number.isFinite(remaining) ? Math.max(0, remaining) : 0;
  }

  /** 给外部看门狗的心跳内容。 */
  heartbeat(): { mode: Mode; maintenance: boolean } {
    return { mode: this.#mode, maintenance: this.#maintenance };
  }

  // ---------------------------------------------------------------- 执行闸门

  addGuard(guard: Guard): () => void {
    this.#guards.add(guard);
    return () => this.#guards.delete(guard);
  }

  /** 授权一个意图。任一检查不通过即拒绝；每次判定都写入状态存储（写不进时照样拒绝）。 */
  async authorize(request: IntentRequest): Promise<Decision> {
    const reason = await this.#denial(request);
    if (reason !== undefined) return this.#deny(request, reason);
    try {
      const { intent, duplicate } = this.#store.authorize({
        key: request.key,
        type: request.type,
        target: request.target,
        payloadHash: payloadHash(request.payload),
        source: request.source,
        capabilities: request.capabilities,
        timeSensitive: request.timeSensitive,
      });
      return { allowed: true, intent, duplicate };
    } catch (error) {
      const why =
        error instanceof StoreUnavailable
          ? '状态存储不可用'
          : error instanceof ResourceIsolated
            ? error.message
            : `写入意图失败：${message(error)}`;
      return this.#deny(request, why);
    }
  }

  async #denial(request: IntentRequest): Promise<string | undefined> {
    // 只申请安全停止下的例外能力（写 Stage URL、写 Iris）的意图，安全停止下照常判定。
    const exempt =
      request.capabilities.length > 0 && request.capabilities.every((c) => SAFE_STOP_EXEMPT.has(c));
    const immediate = this.#outputBlocker(exempt);
    if (immediate) return immediate;
    const granted = this.#permissionsOf(request.holder);
    if (!granted) return `未知的意图来源 ${request.holder}`;
    const missing = request.capabilities.filter((c) => !granted.has(c));
    if (missing.length > 0) return `${request.holder} 没有能力 ${missing.join(', ')}`;
    if (request.source.untrusted) {
      const forbidden = request.capabilities.filter((c) => UNTRUSTED_FORBIDDEN.has(c));
      if (forbidden.length > 0) return `含不可信输入的意图不能申请 ${forbidden.join(', ')}`;
    }
    if (this.#store.intentsIn('unknown').some((intent) => intent.target === request.target)) {
      return `目标 ${request.target} 有结果未知的意图，已隔离`;
    }
    const over = this.#rate.take(request.capabilities);
    if (over !== undefined) {
      this.downgrade(`超出速率：${over}`);
      return `超出速率：${over}`;
    }
    for (const guard of [...this.#guards]) {
      let verdict: GuardVerdict;
      try {
        verdict = await withDeadline(
          this.#clock,
          Promise.resolve().then(() => guard(request)),
          this.#config.guardTimeoutMs,
          '守卫',
        );
      } catch (error) {
        return `守卫失败：${message(error)}`;
      }
      if (verdict && typeof verdict.deny === 'string') return verdict.deny;
    }
    // 守卫可能是异步的：判定期间若进入了安全停止，同样拒绝。
    return this.#outputBlocker(exempt);
  }

  /** `exempt` 为 true 时是安全停止下的例外（写 Stage URL、写 Iris）：安全停止下放行，维护态仍拒绝。 */
  #outputBlocker(exempt = false): string | undefined {
    if (!this.#store.healthy) return '状态存储不可用';
    if (!producesOutput(this.#mode) && !(exempt && !this.#maintenance))
      return '安全停止中，不产生新输出';
    if (this.#maintenance) return '维护态中';
    return undefined;
  }

  // ---------------------------------------------------------------- 对账

  /** 插件实例被授予的权限（来自插件内核）；激活期间的实例还查不到。 */
  permissionsOf(holder: string): ReadonlySet<string> | undefined {
    return this.#permissionsOf(holder);
  }

  /**
   * 结果未知、可以由所有者对账的意图（状态存储“重启”第 4 步）：按类型，没有时效，且所需能力 `granted` 全都有。
   * 持有一个意图全部所需能力的实例，才算它的所有者。
   */
  unresolved(type: string, granted: ReadonlySet<string>): Intent[] {
    return this.#store
      .intentsIn('unknown')
      .filter(
        (intent) =>
          intent.type === type &&
          !intent.timeSensitive &&
          intent.capabilities.every((capability) => granted.has(capability)),
      );
  }

  /**
   * 对账：所有者查询外部状态后，为结果未知的意图补记结果。不是所有者、不是结果未知的意图都抛错；
   * 有时效的意图只能由操作员结案（由状态存储拒绝）。
   */
  reconcile(id: number, outcome: Outcome, granted: ReadonlySet<string>): Intent {
    const intent = this.#store.intent(id);
    if (intent?.state !== 'unknown') throw new Error(`意图 ${id} 不是结果未知的意图`);
    const missing = intent.capabilities.filter((capability) => !granted.has(capability));
    if (missing.length > 0) {
      throw new Error(`不能对账意图 ${intent.key}：没有能力 ${missing.join(', ')}`);
    }
    return this.#store.resolve(id, outcome, 'reconcile');
  }

  #deny(request: IntentRequest, reason: string): Decision {
    this.#record('intent.denied', {
      key: request.key,
      type: request.type,
      target: request.target,
      holder: request.holder,
      reason,
    });
    return { allowed: false, reason };
  }

  // ---------------------------------------------------------------- 执行许可

  grant(holder: string, resource: string): LeaseResult {
    const blocked = this.#outputBlocker(resource === STAGE_URL);
    if (blocked) return { ok: false, reason: blocked };
    const capability = this.#config.leaseCapabilities[resource];
    if (!capability) return { ok: false, reason: `资源 ${resource} 没有配置所需能力` };
    if (!this.#permissionsOf(holder)?.has(capability)) {
      return { ok: false, reason: `${holder} 没有能力 ${capability}` };
    }
    try {
      return { ok: true, lease: this.leases.grant(resource, holder) };
    } catch (error) {
      return { ok: false, reason: message(error) };
    }
  }

  renew(lease: Lease): LeaseResult {
    const blocked = this.#outputBlocker(lease.resource === STAGE_URL);
    if (blocked) return { ok: false, reason: blocked };
    try {
      return { ok: true, lease: this.leases.renew(lease) };
    } catch (error) {
      return { ok: false, reason: message(error) };
    }
  }

  // ---------------------------------------------------------------- 急停

  /**
   * 急停：吊销全部执行许可 → 在控制通道广播停止 → 进入安全停止 →
   * 经 OBS 应急连接静音 Stage 源并切安全场景，完成后在控制通道广播结果。前三步同步完成，不依赖存储写入成功。
   */
  emergencyStop(reason: string): Promise<EmergencyReport> {
    const revoked = this.leases.revokeAll(`急停：${reason}`);
    this.control.broadcast({ kind: 'stop', reason });
    if (this.#mode !== 'safe-stop') this.#setMode('safe-stop', reason, 'safety');
    this.#record('safety.emergency-requested', { reason, revoked });
    this.#obsRun ??= this.#obs
      .run(this.#config.emergency)
      .then(
        (outcome) =>
          outcome.ok ? { ok: true } : { ok: false, error: JSON.stringify(outcome.results) },
        (error: unknown) => ({ ok: false, error: message(error) }),
      )
      .then((obs: EmergencyReport['obs']) => {
        this.control.broadcast({ kind: 'emergency-completed', reason, obsOk: obs.ok });
        return obs;
      })
      .finally(() => {
        this.#obsRun = undefined;
      });
    return this.#obsRun.then((obs) => {
      this.#record('safety.emergency-completed', { reason, ...obs });
      if (!obs.ok) this.#log('safety.alarm', { reason: 'emergency-obs-failed', detail: obs.error });
      return { reason, revoked, obs };
    });
  }

  /**
   * 外部看门狗报告已执行应急动作：记录事实，并走急停路径进入安全停止（R-14）。
   * 已在安全停止时只记录；看门狗的 OBS 动作没有成功时，仍用自己的应急连接再做一次。
   */
  watchdogActed(report: WatchdogReport): void {
    this.#record('watchdog.acted', { ...report });
    this.#log('safety.alarm', { reason: 'watchdog-acted', report });
    if (this.#mode !== 'safe-stop' || !report.ok) {
      void this.emergencyStop(`外部看门狗已执行应急动作（${report.reason}）`);
    }
  }

  /** 操作员否决 M1 中等待放行的句子（key 为空时否决全部），经控制通道送到持有它们的插件。 */
  veto(key: string | undefined): void {
    this.control.broadcast({ kind: 'veto', key, reason: '操作员否决' });
  }

  /** 操作员放行 M1 中等待的句子（key 为空时放行全部），与否决一样经控制通道送达。 */
  release(key: string | undefined): void {
    this.control.broadcast({ kind: 'release', key, reason: '操作员放行' });
  }

  /**
   * OBS 的外部变化（R-27）：真实输出模式下节目场景变为安全场景、或 Stage 源被静音，先记事实
   * `safety.obs-external`，再走完整的急停路径（吊销许可、广播停止，并经应急连接把静音与切安全场景再做一遍：
   * 两个动作都幂等，热键可能只绑了其中一项）。已在安全停止、M0 或维护态时只写日志：安全核自己急停、
   * 看门狗动作引起的这两个事件都落在这里。
   */
  #onObsChange(change: ObsChange, resync: boolean): void {
    const { safeScene, stageSource } = this.#config.emergency;
    const fields =
      change.kind === 'scene'
        ? change.sceneName === safeScene
          ? { change: 'scene', scene: change.sceneName }
          : undefined
        : change.inputName === stageSource && change.muted
          ? { change: 'mute', input: change.inputName }
          : undefined;
    if (!fields) return;
    if (!REAL_OUTPUT.has(this.#mode) || this.#maintenance) {
      this.#log('safety.obs-external-ignored', {
        ...fields,
        resync,
        mode: this.#mode,
        maintenance: this.#maintenance,
      });
      return;
    }
    this.#record('safety.obs-external', { ...fields, resync, mode: this.#mode });
    this.#log('safety.alarm', { reason: 'obs-external', ...fields, resync });
    void this.emergencyStop(OBS_EXTERNAL_REASON[change.kind]);
  }

  /** 应急连接（重新）连上了 OBS：真实输出模式下读一次当前状态，断开期间可能错过了事件。 */
  #resyncObs(): void {
    const observe = this.#obs.observe?.bind(this.#obs);
    if (!observe || !REAL_OUTPUT.has(this.#mode) || this.#maintenance) return;
    const policy = this.#config.emergency;
    observe(policy).then(
      (observed) => {
        this.#log('safety.obs-resynced', { ...observed });
        if (observed.sceneName !== undefined)
          this.#onObsChange({ kind: 'scene', sceneName: observed.sceneName }, true);
        if (observed.stageMuted !== undefined)
          this.#onObsChange(
            { kind: 'mute', inputName: policy.stageSource, muted: observed.stageMuted },
            true,
          );
      },
      (error: unknown) => this.#log('safety.obs-resync-failed', { error: message(error) }),
    );
  }

  // ---------------------------------------------------------------- 监督模式

  /** 切换到目标模式的前置条件是否满足（不切换、不记录）；满足时返回 undefined。 */
  modeBlocker(target: Mode): string | undefined {
    return upgradeBlocker(this.#mode, target, this.#upgradeContext());
  }

  /**
   * 开播预检用：目标模式的前置条件是否满足，不计“已经处于该模式”（见 preconditionBlocker）。
   * 不切换、不记录；满足时返回 undefined。
   */
  preconditionBlocker(target: Mode): string | undefined {
    return preconditionBlocker(this.#mode, target, this.#upgradeContext());
  }

  #upgradeContext(): UpgradeContext {
    return {
      simulation: this.#config.simulation,
      maintenance: this.#maintenance,
      storeHealthy: this.#store.healthy,
      emergencyReady: this.#obs.ready,
      watchdogConnected: this.#watchdogConnected(),
      presenceValid: this.presenceValid(),
      moderationEnabled: this.#moderation,
      unattendedGatesSatisfied: this.#config.unattendedGatesSatisfied,
    };
  }

  /** 操作员切换模式。升级须满足目标模式的前置条件；切到安全停止走急停路径。 */
  requestMode(target: Mode): { ok: true } | { ok: false; reason: string } {
    const blocker = this.modeBlocker(target);
    if (blocker) {
      this.#record('supervision.refused', { from: this.#mode, to: target, reason: blocker });
      return { ok: false, reason: blocker };
    }
    if (target === 'safe-stop') {
      void this.emergencyStop('操作员要求安全停止');
    } else {
      this.#setMode(target, '操作员切换', 'operator');
    }
    return { ok: true };
  }

  /** 操作员确认在场（M2 的前提）。操作台页面在线不算在场。 */
  confirmPresence(): void {
    this.#presenceUntil = this.#clock.now() + this.#config.presenceTtlMs;
    this.#record('presence.confirmed', { ttlMs: this.#config.presenceTtlMs });
    this.#watchPresence();
  }

  /** 自动降级：在场确认有效时从 M2/M3 降到 M1，否则进入安全停止。恢复只能由操作员重新升级。 */
  downgrade(reason: string): Mode {
    if (this.#mode === 'safe-stop') return 'safe-stop';
    const target = downgradeTarget(this.#mode, this.presenceValid());
    this.#log('safety.downgraded', { from: this.#mode, to: target, reason });
    if (target === 'safe-stop') void this.emergencyStop(reason);
    else this.#setMode(target, reason, 'safety');
    return target;
  }

  /**
   * 插件请求自动降级（例如决策模型连续失败、输出连续重复或漂移）：先记事实 `safety.downgrade-requested`
   * （请求者、原因、当时的模式），再按 {@link downgrade} 的规则处理。只能往下走：插件不能借此升级或恢复。
   */
  requestDowngrade(holder: string, reason: string): Mode {
    this.#record('safety.downgrade-requested', { holder, reason, mode: this.#mode });
    return this.downgrade(`${reason}（${holder} 请求降级）`);
  }

  /** 审核插件的开关（D-18）：由宿主按 profile 的显式设置报告，变化写入事件；关闭时不允许 M3。 */
  setModeration(enabled: boolean): void {
    if (this.#moderation === enabled) return;
    this.#moderation = enabled;
    this.#record('moderation.switched', { enabled });
    if (!enabled && this.#mode === 'M3') this.downgrade('审核插件已关闭');
  }

  /** 维护态：只能从安全停止进入，期间不授予任何执行许可，此时才能替换关键平面。 */
  enterMaintenance(): { ok: true } | { ok: false; reason: string } {
    if (this.#mode !== 'safe-stop') return { ok: false, reason: '只能从安全停止进入维护态' };
    this.leases.revokeAll('进入维护态');
    this.#maintenance = true;
    this.#record('maintenance.entered', {});
    return { ok: true };
  }

  exitMaintenance(): void {
    if (!this.#maintenance) return;
    this.#maintenance = false;
    this.#record('maintenance.exited', {});
  }

  // ---------------------------------------------------------------- 与插件内核的接缝

  kernelHooks(): KernelSafetyHooks {
    return {
      revokeLeases: (instanceId) => {
        this.leases.revokeHolder(instanceId, '插件停用');
      },
      quiesceTimedOut: (event) => {
        this.#record('plugin.quiesce-timed-out', { ...event, outcome: 'unknown' });
        this.#log('safety.alarm', { reason: 'quiesce-timeout', ...event });
        if (event.tier === 'critical')
          void this.emergencyStop(`关键平面 ${event.entryId} 收尾超时`);
      },
      inMaintenance: () => this.#maintenance,
    };
  }

  /** 关键平面在输出模式下意外停用（非维护态）时走急停路径（D-30）。 */
  onPluginTransition(transition: Transition, tier: 'critical' | 'ordinary'): void {
    if (tier !== 'critical' || transition.from !== 'active' || this.#maintenance) return;
    if (!producesOutput(this.#mode)) return;
    void this.emergencyStop(`关键平面 ${transition.entryId} 停用：${transition.reason ?? ''}`);
  }

  // ---------------------------------------------------------------- 内部

  #setMode(to: Mode, reason: string, by: 'operator' | 'safety'): void {
    const from = this.#mode;
    this.#mode = to;
    this.#record('supervision.changed', { from, to, reason, by });
    this.control.broadcast({ kind: 'mode', mode: to, reason });
    this.#watchPresence();
  }

  #watchPresence(): void {
    if (this.#presenceTimer) this.#clock.clearTimeout(this.#presenceTimer);
    this.#presenceTimer = undefined;
    if (this.#mode !== 'M2') return;
    const remaining = Math.max(0, this.#presenceUntil - this.#clock.now());
    this.#presenceTimer = this.#clock.setTimeout(
      () => {
        this.#presenceTimer = undefined;
        if (this.#mode === 'M2' && !this.presenceValid()) this.downgrade('在场确认过期');
        else this.#watchPresence();
      },
      Number.isFinite(remaining) ? remaining : 0,
    );
  }

  /** 尽力写入事件：写不进只记日志，不影响调用方。 */
  record(type: string, data: Record<string, unknown>): void {
    this.#record(type, data);
  }

  #record(type: string, data: Record<string, unknown>): void {
    try {
      this.#store.append(type, data, { source: 'safety' });
    } catch (error) {
      this.#log('safety.record-failed', { type, error: message(error) });
    }
  }
}
