import { defineService } from '@bellis/kernel';
import { executeIntent, type Intent } from '@bellis/store';
import type { ControlSignal } from './control.ts';
import type { Decision, IntentRequest, LeaseResult, SafetyCore } from './core.ts';
import type { Lease, LeaseUpdate } from './leases.ts';
import type { Mode } from './supervision.ts';

/**
 * 插件能接触到的安全核：申请授权、持有与续约执行许可、订阅控制信号、执行已授权的意图、记录事实。
 * 插件拿不到状态存储本身，也不能切换监督模式。
 */
export interface SafetyFacade {
  readonly mode: Mode;
  readonly moderationEnabled: boolean | undefined;
  authorize(request: IntentRequest): Promise<Decision>;
  /** 执行已授权的意图：核对载荷后标为执行中 → 执行 → 写入结果。 */
  execute<P>(intent: Intent, payload: P, effect: (payload: P) => Promise<unknown>): Promise<Intent>;
  grant(holder: string, resource: string): LeaseResult;
  renew(lease: Lease): LeaseResult;
  /** 持有者主动交还许可。 */
  release(lease: Lease): void;
  isValid(resource: string, token: number): boolean;
  onLease(listener: (update: LeaseUpdate) => void): () => void;
  onControl(listener: (signal: ControlSignal) => void): () => void;
  /** 记录一条事实（`对象.过去式`）；写不进只记日志，不影响调用方。 */
  record(type: string, data: Record<string, unknown>): void;
}

export const SafetyService = defineService<SafetyFacade>('safety', 1);

export function safetyFacade(core: SafetyCore): SafetyFacade {
  return {
    get mode() {
      return core.mode;
    },
    get moderationEnabled() {
      return core.moderationEnabled;
    },
    authorize: (request) => core.authorize(request),
    execute: (intent, payload, effect) =>
      executeIntent(core.store, intent, payload, (p) => effect(p)),
    grant: (holder, resource) => core.grant(holder, resource),
    renew: (lease) => core.renew(lease),
    release: (lease) => {
      if (core.leases.isValid(lease.resource, lease.token))
        core.leases.revoke(lease.resource, '持有者交还');
    },
    isValid: (resource, token) => core.leases.isValid(resource, token),
    onLease: (listener) => core.leases.subscribe(listener),
    onControl: (listener) => core.control.subscribe(listener),
    record: (type, data) => core.record(type, data),
  };
}
