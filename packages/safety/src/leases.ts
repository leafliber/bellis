import type { Clock } from '@bellis/kernel';
import type { StateStore } from '@bellis/store';

/** 执行许可：持有者在到期前可以续约；设备只接受等于当前令牌且未过期的指令（D-31）。 */
export interface Lease {
  resource: string;
  holder: string;
  token: number;
  /** 许可时长；跨进程的设备按收到的时刻加时长自行判定到期。 */
  ttlMs: number;
  /** 宿主单调时钟上的到期时刻。 */
  expiresAt: number;
}

/** 发给设备的许可状态。`lease` 为 undefined 表示已吊销或无人持有。 */
export interface LeaseUpdate {
  resource: string;
  lease: Lease | undefined;
}

/**
 * 执行许可与令牌。每个资源至多一个持有者。授予与吊销都递增令牌并持久化；
 * 吊销先在内存中生效，不等待写入成功（急停不依赖存储）。续约只延长到期时刻，不改令牌。
 */
export class Leases {
  readonly #store: StateStore;
  readonly #clock: Clock;
  readonly #ttl: Readonly<Record<string, number>>;
  readonly #active = new Map<string, Lease>();
  readonly #listeners = new Set<(update: LeaseUpdate) => void>();
  readonly #log: (event: string, fields: Record<string, unknown>) => void;

  constructor(
    store: StateStore,
    clock: Clock,
    ttl: Readonly<Record<string, number>>,
    log: (event: string, fields: Record<string, unknown>) => void,
  ) {
    this.#store = store;
    this.#clock = clock;
    this.#ttl = ttl;
    this.#log = log;
  }

  /** 授予许可；资源被他人有效持有时抛错。令牌写入失败时不授予。 */
  grant(resource: string, holder: string): Lease {
    const ttlMs = this.#ttl[resource];
    if (ttlMs === undefined) throw new Error(`资源 ${resource} 没有配置许可时长`);
    const current = this.#live(resource);
    if (current && current.holder !== holder)
      throw new Error(`资源 ${resource} 已由 ${current.holder} 持有`);
    const token = this.#store.transaction((tx) => {
      const next = tx.nextToken(resource);
      tx.append('lease.granted', { resource, holder, token: next, ttlMs });
      return next;
    }, 'lease');
    const lease: Lease = { resource, holder, token, ttlMs, expiresAt: this.#clock.now() + ttlMs };
    this.#active.set(resource, lease);
    this.#publish(resource, lease);
    return lease;
  }

  /** 续约：必须是当前有效的许可。 */
  renew(lease: Lease): Lease {
    const current = this.#live(lease.resource);
    if (!current || current.token !== lease.token || current.holder !== lease.holder) {
      throw new Error(`许可 ${lease.resource}#${lease.token} 已失效`);
    }
    const renewed = { ...current, expiresAt: this.#clock.now() + current.ttlMs };
    this.#active.set(lease.resource, renewed);
    this.#publish(lease.resource, renewed);
    return renewed;
  }

  isValid(resource: string, token: number): boolean {
    const current = this.#live(resource);
    return current !== undefined && current.token === token;
  }

  current(resource: string): Lease | undefined {
    return this.#live(resource);
  }

  holders(): Lease[] {
    return [...this.#active.values()].filter((lease) => this.#live(lease.resource) === lease);
  }

  revoke(resource: string, reason: string): boolean {
    const lease = this.#active.get(resource);
    if (!lease) return false;
    this.#active.delete(resource);
    this.#publish(resource, undefined);
    try {
      this.#store.transaction((tx) => {
        const token = tx.nextToken(resource);
        tx.append('lease.revoked', { resource, holder: lease.holder, token, reason });
      }, 'lease');
    } catch (error) {
      // 内存中已经吊销；令牌未能持久化，重启后所有许可本来就作废。
      this.#log('lease.persist-failed', { resource, error: (error as Error).message });
    }
    return true;
  }

  revokeHolder(holder: string, reason: string): number {
    let count = 0;
    for (const lease of [...this.#active.values()]) {
      if (lease.holder === holder && this.revoke(lease.resource, reason)) count += 1;
    }
    return count;
  }

  revokeAll(reason: string): number {
    let count = 0;
    for (const resource of [...this.#active.keys()]) if (this.revoke(resource, reason)) count += 1;
    return count;
  }

  subscribe(listener: (update: LeaseUpdate) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #live(resource: string): Lease | undefined {
    const lease = this.#active.get(resource);
    if (!lease) return undefined;
    if (this.#clock.now() >= lease.expiresAt) return undefined;
    return lease;
  }

  #publish(resource: string, lease: Lease | undefined): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener({ resource, lease });
      } catch (error) {
        this.#log('lease.listener-failed', { resource, error: (error as Error).message });
      }
    }
  }
}
