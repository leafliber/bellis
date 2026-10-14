import type { TSchema } from 'typebox';
import { Compile } from 'typebox/compile';
import Value from 'typebox/value';
import { type Clock, type TimerHandle, withDeadline } from './clock.ts';
import { Extensions } from './extension.ts';
import type { Disposer, PluginCatalog, PluginContext, PluginDefinition } from './plugin.ts';
import { type ParsedRef, parseRef, ServiceRegistry, type ServiceToken } from './service.ts';

export type PluginState =
  | 'waiting'
  | 'loading'
  | 'active'
  | 'quiescing'
  | 'unloading'
  | 'failed'
  | 'disposed';

/** profile 展开后的条目（见 `resolveProfile`）。 */
export interface ResolvedEntry {
  id: string;
  plugin: string;
  config: unknown;
  disabled: boolean;
  grant: readonly string[];
}

/** 内核与安全核之间的接缝。安全核不是插件，由宿主在装配时传入（D-15）。 */
export interface KernelSafetyHooks {
  /** 静止中第 2 步：吊销该插件实例持有的全部执行许可。 */
  revokeLeases(instanceId: string): void | Promise<void>;
  /** 收尾超时或撤销失败：记录 `unknown` 并告警；关键平面同时走急停路径。 */
  quiesceTimedOut(event: QuiesceTimeout): void;
  /** 关键平面只在维护态替换。 */
  inMaintenance(): boolean;
}

export interface QuiesceTimeout {
  entryId: string;
  instanceId: string;
  tier: 'critical' | 'ordinary';
  process: 'in-process' | 'sidecar';
  error: string;
}

export interface Transition {
  entryId: string;
  from: PluginState;
  to: PluginState;
  reason: string | undefined;
}

export interface KernelOptions {
  clock: Clock;
  safety: KernelSafetyHooks;
  log?: (event: string, fields: Record<string, unknown>) => void;
  onTransition?: (transition: Transition) => void;
  /** 激活的截止时间，默认 10 秒。 */
  activateTimeoutMs?: number;
  /** 静止中等待物理确认的截止时间，默认 5 秒。 */
  quiesceTimeoutMs?: number;
  /** 单个撤销函数的截止时间，默认 2 秒。 */
  disposerTimeoutMs?: number;
  /** 失败后的重试间隔，用尽后停在 FAILED 等待操作员，默认 1、2、4 秒。 */
  retryDelaysMs?: readonly number[];
  /** 活动满这么久才清零重试计数，避免崩溃循环无限重试，默认 60 秒。 */
  stableAfterMs?: number;
}

export interface EntrySnapshot {
  id: string;
  plugin: string;
  version: string;
  tier: 'critical' | 'ordinary';
  process: 'in-process' | 'sidecar';
  state: PluginState;
  reason: string | undefined;
  instanceId: string | undefined;
  enabled: boolean;
}

export type ReplaceResult = { ok: true } | { ok: false; error: string };

interface Instance {
  readonly id: string;
  readonly definition: PluginDefinition;
  readonly config: unknown;
  readonly controller: AbortController;
  readonly disposers: Disposer[];
  /** 激活期间提供的服务，激活成功后才发布。 */
  readonly staged: Map<string, { major: number; impl: unknown }>;
  /** 激活期间注册的扩展点监听者，与服务一同发布，发布前不会收到分发。 */
  readonly stagedHandlers: Array<() => () => void>;
  context: PluginContext;
  published: boolean;
  closed: boolean;
  forced: boolean;
  activeSince: number;
}

interface Entry {
  readonly id: string;
  definition: PluginDefinition;
  config: unknown;
  readonly grant: ReadonlySet<string>;
  enabled: boolean;
  state: PluginState;
  reason: string | undefined;
  instance: Instance | undefined;
  attempts: number;
  retry: TimerHandle | undefined;
  /** 运行中经 ctx.fail 报告的失败，由下一轮调和处理。 */
  failure: Error | undefined;
}

const CORE_PROVIDER = 'core';
const validators = new WeakMap<TSchema, ReturnType<typeof Compile>>();

function validator(schema: TSchema) {
  let compiled = validators.get(schema);
  if (!compiled) {
    compiled = Compile(schema);
    validators.set(schema, compiled);
  }
  return compiled;
}

/** 按清单的 Schema 补齐缺省值（不改动传入的配置），再校验。 */
function prepareConfig(
  definition: PluginDefinition,
  raw: unknown,
): { config: unknown } | { error: string } {
  const schema = definition.manifest.config;
  const config = Value.Default(schema, structuredClone(raw ?? {}));
  const check = validator(schema);
  if (check.Check(config)) return { config };
  const first = [...check.Errors(config)][0];
  return {
    error: `配置不合法：${first ? `${first.instancePath || '/'} ${first.message}` : '未知错误'}`,
  };
}

function configError(definition: PluginDefinition, raw: unknown): string | undefined {
  const prepared = prepareConfig(definition, raw);
  return 'error' in prepared ? prepared.error : undefined;
}

/** 清单中同一个服务名只能出现一次（提供与依赖分别检查）。 */
function manifestError(definition: PluginDefinition): string | undefined {
  for (const field of ['provides', 'inject'] as const) {
    const names = definition.manifest[field].map((ref) => parseRef(ref).name);
    const duplicate = names.find((name, index) => names.indexOf(name) !== index);
    if (duplicate) return `插件 ${definition.manifest.id} 的 ${field} 中 ${duplicate} 重复`;
  }
  return undefined;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 插件内核（D-13、D-14）：按依赖激活、注册可撤销、停用前安全收尾。
 *
 * 所有状态变更都在一个串行的调和循环里进行。每一轮：
 * 1. 先停用：被禁用、运行中失败或缺少必需依赖的活动实例经过静止中卸载；
 *    卸载前先把依赖它所提供服务的活动实例卸载回 WAITING（消费方先于提供方停用）。
 * 2. 再按 profile 顺序加载依赖齐全的 WAITING 条目。
 */
export class Kernel {
  readonly services = new ServiceRegistry();
  readonly extensions: Extensions;
  readonly #clock: Clock;
  readonly #safety: KernelSafetyHooks;
  readonly #log: (event: string, fields: Record<string, unknown>) => void;
  readonly #onTransition: ((transition: Transition) => void) | undefined;
  readonly #activateTimeoutMs: number;
  readonly #quiesceTimeoutMs: number;
  readonly #disposerTimeoutMs: number;
  readonly #retryDelaysMs: readonly number[];
  readonly #stableAfterMs: number;
  readonly #entries = new Map<string, Entry>();
  #lock: Promise<unknown> = Promise.resolve();
  #loop: Promise<void> | undefined;
  #dirty = false;
  #nextInstance = 1;
  /** 宿主停止后不再接受任何生命周期变更。 */
  #closed = false;

  constructor(options: KernelOptions) {
    this.#clock = options.clock;
    this.#safety = options.safety;
    this.#log = options.log ?? (() => {});
    this.#onTransition = options.onTransition;
    this.#activateTimeoutMs = options.activateTimeoutMs ?? 10_000;
    this.#quiesceTimeoutMs = options.quiesceTimeoutMs ?? 5_000;
    this.#disposerTimeoutMs = options.disposerTimeoutMs ?? 2_000;
    this.#retryDelaysMs = options.retryDelaysMs ?? [1_000, 2_000, 4_000];
    this.#stableAfterMs = options.stableAfterMs ?? 60_000;
    this.extensions = new Extensions((name, error) =>
      this.#log('extension.observer-failed', { extension: name, error: message(error) }),
    );
  }

  /** 由宿主直接提供的基础服务（时钟、通道等），不属于任何插件。 */
  provideCore<T>(token: ServiceToken<T>, impl: T): () => void {
    const dispose = this.services.add(token.name, token.major, impl, CORE_PROVIDER);
    return () => {
      dispose();
      this.#requestReconcile();
    };
  }

  /** 按顺序加入 profile 条目。加入后调用 `settled()` 等待调和完成。 */
  add(entries: readonly ResolvedEntry[], plugins: PluginCatalog): void {
    this.#admit();
    // 先校验整批，全部合格才写入，失败不留下半批条目。
    const ids = new Set(this.#entries.keys());
    const definitions = entries.map((resolved) => {
      if (ids.has(resolved.id)) throw new Error(`条目 ${resolved.id} 重复`);
      ids.add(resolved.id);
      const definition = plugins.get(resolved.plugin);
      if (!definition) throw new Error(`条目 ${resolved.id} 引用了未知插件 ${resolved.plugin}`);
      const invalid = manifestError(definition);
      if (invalid) throw new Error(invalid);
      return definition;
    });
    entries.forEach((resolved, index) => {
      const definition = definitions[index] as PluginDefinition;
      this.#entries.set(resolved.id, {
        id: resolved.id,
        definition,
        config: resolved.config ?? {},
        grant: new Set(resolved.grant),
        enabled: !resolved.disabled,
        state: resolved.disabled ? 'disposed' : 'waiting',
        reason: resolved.disabled ? '已禁用' : undefined,
        instance: undefined,
        attempts: 0,
        retry: undefined,
        failure: undefined,
      });
    });
    this.#requestReconcile();
  }

  async enable(id: string): Promise<void> {
    this.#admit();
    const entry = this.#entry(id);
    entry.enabled = true;
    this.#requestReconcile();
    await this.settled();
  }

  async disable(id: string): Promise<void> {
    this.#admit();
    const entry = this.#entry(id);
    entry.enabled = false;
    this.#requestReconcile();
    await this.settled();
  }

  /** 操作员处理后重新尝试一个 FAILED 条目，重试计数清零。 */
  async retry(id: string): Promise<void> {
    this.#admit();
    const entry = this.#entry(id);
    if (entry.state !== 'failed') return;
    this.#cancelRetry(entry);
    entry.attempts = 0;
    this.#set(entry, 'waiting', undefined);
    this.#requestReconcile();
    await this.settled();
  }

  /**
   * 热替换：先加载并校验新版本（服务暂不发布），失败则保留旧实例；
   * 成功后旧实例经过静止中卸载，再发布新实例的服务。这只是类事务，不保证原子：
   * 新旧实例会短暂并存，依赖方会经历一次停用与重新激活。
   * 关键平面只能在维护态替换（D-19）。
   */
  replace(id: string, definition: PluginDefinition, config?: unknown): Promise<ReplaceResult> {
    this.#admit();
    return this.#exclusive(async () => {
      if (this.#closed) return { ok: false, error: '宿主正在停止' };
      const entry = this.#entry(id);
      const critical =
        entry.definition.manifest.tier === 'critical' || definition.manifest.tier === 'critical';
      if (critical && !this.#safety.inMaintenance()) {
        return { ok: false, error: '关键平面只能在维护态替换' };
      }
      const nextConfig = config ?? entry.config;
      const invalid = manifestError(definition) ?? configError(definition, nextConfig);
      if (invalid) return { ok: false, error: invalid };

      if (entry.state !== 'active') {
        entry.definition = definition;
        entry.config = nextConfig;
        if (entry.state === 'failed') {
          this.#cancelRetry(entry);
          entry.attempts = 0;
          this.#set(entry, 'waiting', undefined);
        }
        this.#requestReconcile();
        return { ok: true };
      }

      // 新版本的依赖与权限此刻必须齐全，否则不动旧实例。
      const blockers = this.#blockersOf(definition, entry.grant);
      if (blockers.length > 0) return { ok: false, error: blockers.join('；') };

      const staged = this.#newInstance(entry, definition, nextConfig);
      try {
        await this.#activate(entry, staged);
      } catch (error) {
        await this.#dispose(staged);
        this.#log('plugin.replace-failed', { entry: id, error: message(error) });
        return { ok: false, error: message(error) };
      }

      const previous = { definition: entry.definition, config: entry.config };
      await this.#unload(entry, 'waiting', '热替换');
      entry.definition = definition;
      entry.config = nextConfig;
      try {
        this.#publish(staged);
      } catch (error) {
        await this.#dispose(staged);
        entry.definition = previous.definition;
        entry.config = previous.config;
        this.#requestReconcile();
        return { ok: false, error: message(error) };
      }
      entry.instance = staged;
      staged.activeSince = this.#clock.now();
      this.#set(entry, 'active', undefined);
      this.#requestReconcile();
      return { ok: true };
    });
  }

  /** 等待调和循环与正在进行的操作全部结束。 */
  async settled(): Promise<void> {
    for (;;) {
      if (this.#loop) {
        await this.#loop;
        continue;
      }
      const lock = this.#lock;
      await lock;
      if (!this.#loop && lock === this.#lock) return;
    }
  }

  /** 按 profile 逆序卸载全部插件。 */
  async shutdown(): Promise<void> {
    this.#closed = true;
    await this.settled();
    await this.#exclusive(async () => {
      for (const entry of [...this.#entries.values()].reverse()) {
        entry.enabled = false;
        this.#cancelRetry(entry);
        if (entry.instance) await this.#unload(entry, 'disposed', '宿主停止');
        else if (entry.state !== 'disposed') this.#set(entry, 'disposed', '宿主停止');
      }
    });
  }

  snapshot(): EntrySnapshot[] {
    return [...this.#entries.values()].map((entry) => ({
      id: entry.id,
      plugin: entry.definition.manifest.id,
      version: entry.definition.manifest.version,
      tier: entry.definition.manifest.tier,
      process: entry.definition.manifest.process,
      state: entry.state,
      reason: entry.reason,
      instanceId: entry.instance?.id,
      enabled: entry.enabled,
    }));
  }

  /** 某个插件实例被授予的权限；实例不存在时返回 undefined（供安全核核对意图来源）。 */
  permissionsOf(instanceId: string): ReadonlySet<string> | undefined {
    for (const entry of this.#entries.values()) {
      if (entry.instance?.id === instanceId) return entry.grant;
    }
    return undefined;
  }

  #entry(id: string): Entry {
    const entry = this.#entries.get(id);
    if (!entry) throw new Error(`没有条目 ${id}`);
    return entry;
  }

  #admit(): void {
    if (this.#closed) throw new Error('宿主正在停止，不再接受插件变更');
  }

  #exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#lock.then(work);
    this.#lock = run.catch(() => {});
    return run;
  }

  #requestReconcile(): void {
    this.#dirty = true;
    this.#loop ??= (async () => {
      try {
        while (this.#dirty) {
          this.#dirty = false;
          await this.#exclusive(() => this.#pass());
        }
      } finally {
        this.#loop = undefined;
      }
    })();
  }

  async #pass(): Promise<void> {
    if (this.#closed) return;
    for (const entry of [...this.#entries.values()].reverse()) {
      if (entry.state !== 'active') continue;
      if (!entry.enabled) {
        await this.#unload(entry, 'disposed', '已禁用');
      } else if (entry.failure) {
        await this.#unload(entry, 'failed', entry.failure.message);
      } else {
        const blockers = this.#blockers(entry);
        if (blockers.length > 0) await this.#unload(entry, 'waiting', blockers.join('；'));
      }
    }

    for (const entry of this.#entries.values()) {
      if (!entry.enabled) {
        if (entry.state === 'waiting' || entry.state === 'failed') {
          this.#cancelRetry(entry);
          this.#set(entry, 'disposed', '已禁用');
        }
        continue;
      }
      if (entry.state === 'disposed') this.#set(entry, 'waiting', undefined);
      if (entry.state !== 'waiting') continue;
      const invalid = configError(entry.definition, entry.config);
      if (invalid) {
        // 配置错误重试也不会好，直接停在 FAILED。
        entry.attempts = this.#retryDelaysMs.length;
        this.#set(entry, 'failed', invalid);
        continue;
      }
      const blockers = this.#blockers(entry);
      if (blockers.length > 0) {
        this.#set(entry, 'waiting', blockers.join('；'));
        continue;
      }
      await this.#load(entry);
      this.#dirty = true;
    }
  }

  /** WAITING 的原因：缺少的服务、不兼容的版本、未授予的权限。 */
  #blockers(entry: Entry): string[] {
    return this.#blockersOf(entry.definition, entry.grant);
  }

  #blockersOf(definition: PluginDefinition, grant: ReadonlySet<string>): string[] {
    const reasons: string[] = [];
    for (const ref of definition.manifest.inject) {
      const dependency = parseRef(ref);
      if (dependency.optional) continue;
      const found = this.services.resolve(dependency.name, dependency.major);
      if ('missing' in found) reasons.push(found.missing);
    }
    for (const permission of definition.manifest.permissions) {
      if (!grant.has(permission)) reasons.push(`未授予权限 ${permission}`);
    }
    return reasons;
  }

  async #load(entry: Entry): Promise<void> {
    const instance = this.#newInstance(entry, entry.definition, entry.config);
    this.#set(entry, 'loading', undefined);
    try {
      await this.#activate(entry, instance);
      this.#publish(instance);
    } catch (error) {
      await this.#dispose(instance);
      this.#fail(entry, message(error));
      return;
    }
    entry.instance = instance;
    instance.activeSince = this.#clock.now();
    this.#set(entry, 'active', undefined);
  }

  async #activate(entry: Entry, instance: Instance): Promise<void> {
    const { definition } = instance;
    await withDeadline(
      this.#clock,
      Promise.resolve().then(() => definition.activate(instance.context)),
      this.#activateTimeoutMs,
      `${entry.id} 激活`,
    );
    for (const ref of definition.manifest.provides) {
      const { name, major } = parseRef(ref);
      if (instance.staged.get(name)?.major !== major) {
        throw new Error(`${entry.id} 激活后没有提供 ${name}@${major}`);
      }
    }
  }

  #publish(instance: Instance): void {
    const added: Array<() => void> = [];
    try {
      for (const [name, { major, impl }] of instance.staged) {
        added.push(this.services.add(name, major, impl, instance.id));
      }
    } catch (error) {
      for (const remove of added.reverse()) remove();
      throw error;
    }
    // 监听者与服务最后注册，卸载时最先撤回。
    for (const attach of instance.stagedHandlers.splice(0)) instance.disposers.push(attach());
    instance.disposers.push(...added);
    instance.published = true;
  }

  /**
   * 静止中（QUIESCING）→ 卸载中（UNLOADING）→ 目标状态：
   * 停止接收新工作 → 先卸载依赖它的消费方 → 吊销执行许可 → 插件收尾并等待物理确认 → 运行撤销函数。
   */
  async #unload(
    entry: Entry,
    target: 'waiting' | 'disposed' | 'failed',
    reason: string,
  ): Promise<void> {
    const instance = entry.instance;
    if (!instance) return;
    entry.failure = undefined;
    this.#set(entry, 'quiescing', reason);
    instance.controller.abort(new Error(reason));
    await this.#unloadConsumers(entry, instance);

    try {
      await withDeadline(
        this.#clock,
        Promise.resolve().then(() => this.#safety.revokeLeases(instance.id)),
        this.#disposerTimeoutMs,
        `${entry.id} 吊销执行许可`,
      );
    } catch (error) {
      // 吊销失败不能当作已吊销：按收尾超时升级给安全核（关键平面会急停）。
      this.#forced(entry, instance, `吊销执行许可失败：${message(error)}`);
    }

    const { quiesce } = instance.definition;
    if (quiesce) {
      try {
        await withDeadline(
          this.#clock,
          Promise.resolve().then(() => quiesce.call(instance.definition, instance.context)),
          this.#quiesceTimeoutMs,
          `${entry.id} 收尾`,
        );
      } catch (error) {
        this.#forced(entry, instance, message(error));
      }
    }

    this.#set(entry, 'unloading', reason);
    await this.#dispose(instance);
    entry.instance = undefined;
    const stable = this.#clock.now() - instance.activeSince >= this.#stableAfterMs;
    if (stable) entry.attempts = 0;
    if (target === 'failed') this.#fail(entry, reason);
    else this.#set(entry, target, reason);
  }

  async #unloadConsumers(entry: Entry, instance: Instance): Promise<void> {
    const names = new Set(this.services.providedBy(instance.id));
    if (names.size === 0) return;
    for (const other of [...this.#entries.values()].reverse()) {
      if (other === entry || other.state !== 'active') continue;
      const needs = other.definition.manifest.inject
        .map((ref): ParsedRef => parseRef(ref))
        .some((dependency) => !dependency.optional && names.has(dependency.name));
      if (needs) await this.#unload(other, 'waiting', `依赖的提供方 ${entry.id} 正在停用`);
    }
  }

  /** 按后注册先撤销的顺序运行撤销函数；单个失败或超时不影响其余。 */
  async #dispose(instance: Instance): Promise<void> {
    instance.closed = true;
    instance.controller.abort(new Error('已卸载'));
    for (let disposer = instance.disposers.pop(); disposer; disposer = instance.disposers.pop()) {
      const run = disposer;
      try {
        await withDeadline(
          this.#clock,
          Promise.resolve().then(run),
          this.#disposerTimeoutMs,
          `${instance.id} 撤销`,
        );
      } catch (error) {
        this.#log('plugin.disposer-failed', { instance: instance.id, error: message(error) });
        if (!instance.forced) {
          const entry = [...this.#entries.values()].find((e) => e.instance === instance);
          if (entry) this.#forced(entry, instance, message(error));
        }
      }
    }
  }

  #forced(entry: Entry, instance: Instance, error: string): void {
    instance.forced = true;
    this.#log('plugin.quiesce-timeout', { entry: entry.id, instance: instance.id, error });
    this.#safety.quiesceTimedOut({
      entryId: entry.id,
      instanceId: instance.id,
      tier: instance.definition.manifest.tier,
      process: instance.definition.manifest.process,
      error,
    });
  }

  #fail(entry: Entry, reason: string): void {
    const delay = this.#retryDelaysMs[entry.attempts];
    entry.attempts += 1;
    if (delay === undefined) {
      this.#set(entry, 'failed', `${reason}；重试已用尽，等待操作员处理`);
      return;
    }
    this.#set(entry, 'failed', `${reason}；${delay}ms 后重试`);
    entry.retry = this.#clock.setTimeout(() => {
      entry.retry = undefined;
      if (entry.state !== 'failed' || !entry.enabled) return;
      this.#set(entry, 'waiting', undefined);
      this.#requestReconcile();
    }, delay);
  }

  #cancelRetry(entry: Entry): void {
    if (entry.retry) this.#clock.clearTimeout(entry.retry);
    entry.retry = undefined;
  }

  #set(entry: Entry, state: PluginState, reason: string | undefined): void {
    const from = entry.state;
    if (from === state && entry.reason === reason) return;
    entry.state = state;
    entry.reason = reason;
    this.#onTransition?.({ entryId: entry.id, from, to: state, reason });
  }

  #reportFailure(entry: Entry, instance: Instance, error: Error): void {
    if (entry.instance !== instance || instance.closed || entry.failure) return;
    this.#log('plugin.failed', { entry: entry.id, instance: instance.id, error: error.message });
    entry.failure = error;
    this.#requestReconcile();
  }

  #newInstance(entry: Entry, definition: PluginDefinition, raw: unknown): Instance {
    const prepared = prepareConfig(definition, raw);
    const config = 'config' in prepared ? prepared.config : raw;
    const instance: Instance = {
      id: `${entry.id}#${this.#nextInstance++}`,
      definition,
      config,
      controller: new AbortController(),
      disposers: [],
      staged: new Map(),
      stagedHandlers: [],
      context: undefined as unknown as PluginContext,
      published: false,
      closed: false,
      forced: false,
      activeSince: 0,
    };
    instance.context = this.#context(entry, instance);
    return instance;
  }

  #context(entry: Entry, instance: Instance): PluginContext {
    const { manifest } = instance.definition;
    const injects = new Map(manifest.inject.map((ref) => [parseRef(ref).name, parseRef(ref)]));
    const provides = new Map(manifest.provides.map((ref) => [parseRef(ref).name, parseRef(ref)]));
    const alive = () => {
      if (instance.closed) throw new Error(`${instance.id} 已卸载`);
    };
    const declared = (token: ServiceToken<unknown>, optional: boolean) => {
      const dependency = injects.get(token.name);
      if (!dependency || dependency.major !== token.major || (!optional && dependency.optional)) {
        throw new Error(`${entry.id} 没有声明${optional ? '' : '必需'}依赖 ${token.ref}`);
      }
    };
    return {
      entryId: entry.id,
      instanceId: instance.id,
      config: instance.config,
      permissions: entry.grant,
      get signal() {
        return instance.controller.signal;
      },
      get forced() {
        return instance.forced;
      },
      extensions: this.extensions,
      service: <T>(token: ServiceToken<T>): T => {
        alive();
        declared(token, false);
        const found = this.services.resolve(token.name, token.major);
        if ('missing' in found) throw new Error(found.missing);
        return found.impl as T;
      },
      optional: <T>(token: ServiceToken<T>): T | undefined => {
        alive();
        declared(token, true);
        const found = this.services.resolve(token.name, token.major);
        return 'impl' in found ? (found.impl as T) : undefined;
      },
      provide: (token, impl) => {
        alive();
        const declaredProvide = provides.get(token.name);
        if (!declaredProvide || declaredProvide.major !== token.major) {
          throw new Error(`${entry.id} 没有声明提供 ${token.ref}`);
        }
        if (instance.published) throw new Error('只能在激活期间提供服务');
        if (instance.staged.has(token.name)) throw new Error(`${token.ref} 已提供过`);
        instance.staged.set(token.name, { major: token.major, impl });
      },
      on: (extension, handler) => {
        alive();
        const attach = () => this.extensions.add(extension, handler);
        if (instance.published) instance.disposers.push(attach());
        else instance.stagedHandlers.push(attach);
      },
      register: (disposer) => {
        if (instance.closed) {
          // 激活超时后才注册的副作用：立即撤销。
          void Promise.resolve()
            .then(disposer)
            .catch((error: unknown) =>
              this.#log('plugin.disposer-failed', { instance: instance.id, error: message(error) }),
            );
          return;
        }
        instance.disposers.push(disposer);
      },
      fail: (error) => this.#reportFailure(entry, instance, error),
      log: (event, fields = {}) =>
        this.#log(event, { entry: entry.id, instance: instance.id, ...fields }),
    };
  }
}
