import { defineService } from '@bellis/kernel';
import { executeIntent, type Intent, type Outcome, type Projection } from '@bellis/store';
import type { ControlSignal } from './control.ts';
import type { Decision, IntentRequest, LeaseResult, SafetyCore } from './core.ts';
import type { Lease, LeaseUpdate } from './leases.ts';
import type { Mode } from './supervision.ts';

/**
 * 插件能接触到的安全核：申请授权、持有与续约执行许可、订阅控制信号、执行已授权的意图、记录事实，
 * 读取宿主注册的投影，以及为自己的结果未知的意图对账。
 * 每个插件实例拿到的门面都绑定了它自己的实例编号，不能冒用其他实例的身份。
 * 插件拿不到状态存储本身，也不能切换监督模式，只能请求降级。
 */
export interface SafetyFacade {
  readonly mode: Mode;
  readonly moderationEnabled: boolean | undefined;
  /** 急停时静音的 Stage 源，也是写 Stage URL 唯一允许的目标。 */
  readonly stageSource: string;
  /** 以本实例的身份申请授权。 */
  authorize(request: Omit<IntentRequest, 'holder'>): Promise<Decision>;
  /** 执行已授权的意图：核对载荷后标为执行中 → 执行 → 写入结果。 */
  execute<P>(intent: Intent, payload: P, effect: (payload: P) => Promise<unknown>): Promise<Intent>;
  /** 以本实例的身份取得资源的执行许可。 */
  grant(resource: string): LeaseResult;
  /** 续约本实例持有的许可。 */
  renew(lease: Lease): LeaseResult;
  /** 交还本实例持有的许可。 */
  release(lease: Lease): void;
  isValid(resource: string, token: number): boolean;
  onLease(listener: (update: LeaseUpdate) => void): () => void;
  onControl(listener: (signal: ControlSignal) => void): () => void;
  /** 记录一条事实（`对象.过去式`）；写不进只记日志，不影响调用方。 */
  record(type: string, data: Record<string, unknown>): void;
  /** 读取宿主注册的投影（由事实归约出的当前状态，重启时从事件重建）；没有注册时抛错。 */
  view<S>(projection: Projection<S>): S;
  /** 本实例能对账的、结果未知的意图（按类型）：没有时效，且所需能力本实例全都有。 */
  unresolved(type: string): Intent[];
  /** 对账：查询外部状态后为结果未知的意图补记结果；只能对账 {@link unresolved} 会列出的意图。 */
  reconcile(intent: Intent, outcome: Outcome): Intent;
  /**
   * 以本实例的身份请求自动降级（记事实 `safety.downgrade-requested`，再按自动降级的规则处理），返回之后的模式。
   * 只有降级这一个方向：插件仍不能切换或恢复监督模式。
   */
  requestDowngrade(reason: string): Mode;
}

export const SafetyService = defineService<SafetyFacade>('safety', 1);

/**
 * 为一个插件实例生成门面（由宿主按实例提供，见 `Kernel.provideScoped`）。
 * `permissions` 是 profile 授予该条目的权限：激活期间实例尚未登记、按实例编号查不到，对账要用它判断所有者。
 * 不给时在调用时按实例编号向安全核查询。
 */
export function safetyFacade(
  core: SafetyCore,
  holder: string,
  permissions?: ReadonlySet<string>,
): SafetyFacade {
  const own = (lease: Lease) => lease.holder === holder;
  const granted = () => permissions ?? core.permissionsOf(holder) ?? new Set<string>();
  return {
    get mode() {
      return core.mode;
    },
    get moderationEnabled() {
      return core.moderationEnabled;
    },
    get stageSource() {
      return core.stageSource;
    },
    authorize: (request) => core.authorize({ ...request, holder }),
    execute: (intent, payload, effect) =>
      executeIntent(core.store, intent, payload, (p) => effect(p)),
    grant: (resource) => core.grant(holder, resource),
    renew: (lease) =>
      own(lease) ? core.renew(lease) : { ok: false, reason: '不是本实例持有的许可' },
    release: (lease) => {
      if (own(lease) && core.leases.isValid(lease.resource, lease.token)) {
        core.leases.revoke(lease.resource, '持有者交还');
      }
    },
    isValid: (resource, token) => core.leases.isValid(resource, token),
    onLease: (listener) => core.leases.subscribe(listener),
    onControl: (listener) => core.control.subscribe(listener),
    record: (type, data) => core.record(type, data),
    view: (projection) => core.store.view(projection),
    unresolved: (type) => core.unresolved(type, granted()),
    reconcile: (intent, outcome) => core.reconcile(intent.id, outcome, granted()),
    requestDowngrade: (reason) => core.requestDowngrade(holder, reason),
  };
}
