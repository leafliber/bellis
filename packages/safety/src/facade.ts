import { defineService } from '@bellis/kernel';
import { executeIntent, type Intent } from '@bellis/store';
import type { ControlSignal } from './control.ts';
import type { Decision, IntentRequest, LeaseResult, SafetyCore } from './core.ts';
import type { Lease, LeaseUpdate } from './leases.ts';
import type { Mode } from './supervision.ts';

/**
 * 插件能接触到的安全核：申请授权、持有与续约执行许可、订阅控制信号、执行已授权的意图、记录事实。
 * 每个插件实例拿到的门面都绑定了它自己的实例编号，不能冒用其他实例的身份。
 * 插件拿不到状态存储本身，也不能切换监督模式。
 */
export interface SafetyFacade {
  readonly mode: Mode;
  readonly moderationEnabled: boolean | undefined;
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
}

export const SafetyService = defineService<SafetyFacade>('safety', 1);

/** 为一个插件实例生成门面（由宿主按实例提供，见 `Kernel.provideScoped`）。 */
export function safetyFacade(core: SafetyCore, holder: string): SafetyFacade {
  const own = (lease: Lease) => lease.holder === holder;
  return {
    get mode() {
      return core.mode;
    },
    get moderationEnabled() {
      return core.moderationEnabled;
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
  };
}
