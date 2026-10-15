import { type Driver, openSqlite, type Row } from './driver.ts';
import { SCHEMA, SCHEMA_VERSION } from './schema.ts';

/** 已经发生的事实，命名为 `对象.过去式`。 */
export interface StoredEvent<T = unknown> {
  seq: number;
  type: string;
  /** 产生它的模块或外部来源。 */
  source: string;
  /** 发生时间（外部来源可能早于记录时间），毫秒。 */
  occurredAt: number;
  /** 写入时间，毫秒。 */
  recordedAt: number;
  data: T;
}

/** 由事件归约出的当前状态。归约必须是纯函数：重启时从事件完整重放。 */
export interface Projection<S> {
  readonly name: string;
  readonly initial: S;
  reduce(state: S, event: StoredEvent): S;
}

export type IntentState = 'pending' | 'executing' | 'succeeded' | 'failed' | 'unknown';

/** 意图来自谁、基于哪些输入，用于判断是否混入了不可信输入（见安全核）。 */
export interface IntentSource {
  origin: string;
  inputs: readonly string[];
  untrusted: boolean;
}

export interface IntentInput {
  /** 幂等键：同一意图重复提交只执行一次。 */
  key: string;
  type: string;
  target: string;
  /** 载荷的哈希，防止授权后被替换。 */
  payloadHash: string;
  source: IntentSource;
  capabilities: readonly string[];
  /** 说话、游戏输入这类有时效的动作：重启后永不重做，只能人工结案。 */
  timeSensitive: boolean;
}

export interface Intent extends IntentInput {
  id: number;
  state: IntentState;
  result: unknown;
  error: string | undefined;
  createdAt: number;
  updatedAt: number;
}

export type Outcome = { ok: true; result: unknown } | { ok: false; error: string };

export interface RecoveryReport {
  /** 重启时还没开始执行的意图，已标为失败（放弃）。 */
  abandoned: Intent[];
  /** 重启时停在执行中的意图，结果未知，已标为 `unknown`，等待对账或人工结案。 */
  orphaned: Intent[];
}

export interface StoreOptions {
  path: string;
  projections?: readonly Projection<unknown>[];
  /** 墙钟毫秒数；`sim` profile 用确定性的实现替换。 */
  now?: () => number;
  /** 写入点的故障注入，仅用于测试。 */
  fault?: (point: string) => void;
  /** 存储出现 I/O 故障、进入不可用状态时调用。 */
  onFault?: (error: Error) => void;
}

/** 测试中模拟进程在某个写入点崩溃。 */
export class SimulatedCrash extends Error {
  constructor(point: string) {
    super(`模拟崩溃：${point}`);
    this.name = 'SimulatedCrash';
  }
}

/** 存储不可用：新的副作用一律拒绝，直到恢复。 */
export class StoreUnavailable extends Error {
  constructor(cause: unknown) {
    super('状态存储不可用', { cause });
    this.name = 'StoreUnavailable';
  }
}

/** 目标上有结果未知的意图：在对账或人工结案前隔离该目标。 */
export class ResourceIsolated extends Error {
  constructor(target: string, key: string) {
    super(`目标 ${target} 有结果未知的意图 ${key}，已隔离`);
    this.name = 'ResourceIsolated';
  }
}

/** 投影状态冻结后交出，调用方与归约函数都不能原地修改。 */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function sameRequest(existing: Intent, input: IntentInput): boolean {
  return (
    existing.type === input.type &&
    existing.target === input.target &&
    existing.payloadHash === input.payloadHash &&
    existing.timeSensitive === input.timeSensitive &&
    JSON.stringify(existing.capabilities) === JSON.stringify(input.capabilities) &&
    JSON.stringify(existing.source) === JSON.stringify(input.source)
  );
}

/** 存储层面的故障（I/O、磁盘满、损坏、只读），区别于约束或逻辑错误。 */
const STORAGE_FAULTS = new Set([8, 10, 11, 13, 14, 26]);

function isStorageFault(error: unknown): boolean {
  const { code, errcode } = error as { code?: string; errcode?: number };
  return (
    code === 'ERR_SQLITE_ERROR' && typeof errcode === 'number' && STORAGE_FAULTS.has(errcode & 0xff)
  );
}

const TRANSITIONS: Record<IntentState, readonly IntentState[]> = {
  pending: ['executing', 'failed'],
  executing: ['succeeded', 'failed', 'unknown'],
  unknown: ['succeeded', 'failed'],
  succeeded: [],
  failed: [],
};

/** 一个事务内可用的写操作。 */
export interface Tx {
  append<T>(type: string, data: T, meta?: { source?: string; occurredAt?: number }): StoredEvent<T>;
  /** 资源的执行许可令牌加一并返回新值（D-31）。 */
  nextToken(resource: string): number;
}

/**
 * 状态存储（D-17）：单个 SQLite（WAL）文件中的只追加事件表、同事务更新的投影表、待执行意图表与许可令牌。
 * 所有写入都是同步的短事务；投影在提交后才更新到内存，订阅者在提交后才收到事件。
 */
export class StateStore {
  readonly #db: Driver;
  readonly #now: () => number;
  readonly #fault: (point: string) => void;
  readonly #onFault: (error: Error) => void;
  readonly #projections: readonly Projection<unknown>[];
  readonly #listeners = new Set<(event: StoredEvent) => void>();
  #views = new Map<string, unknown>();
  #pending: { views: Map<string, unknown>; events: StoredEvent[] } | undefined;
  #healthy = true;

  static open(options: StoreOptions): StateStore {
    const db = openSqlite(options.path);
    try {
      return new StateStore(db, options);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  private constructor(db: Driver, options: StoreOptions) {
    this.#db = db;
    this.#now = options.now ?? Date.now;
    this.#fault = options.fault ?? (() => {});
    this.#onFault = options.onFault ?? (() => {});
    this.#projections = options.projections ?? [];
    const names = new Set(this.#projections.map((p) => p.name));
    if (names.size !== this.#projections.length) throw new Error('投影名重复');
    db.exec(SCHEMA);
    this.#checkVersion();
    this.#rebuild();
  }

  get healthy(): boolean {
    return this.#healthy;
  }

  close(): void {
    this.#db.close();
  }

  /** 在一个事务里完成多项写入。工作函数抛错则整体回滚。 */
  transaction<T>(work: (tx: Tx) => T, point = 'transaction'): T {
    if (!this.#healthy) throw new StoreUnavailable(undefined);
    this.#pending = { views: new Map(this.#views), events: [] };
    let committed = false;
    try {
      this.#db.exec('BEGIN IMMEDIATE');
      const result = work({
        append: (type, data, meta) => this.#append(type, data, meta),
        nextToken: (resource) => this.#nextToken(resource),
      });
      this.#fault(`${point}:before-commit`);
      this.#db.exec('COMMIT');
      committed = true;
      const { views, events } = this.#pending;
      this.#views = views;
      this.#pending = undefined;
      this.#fault(`${point}:after-commit`);
      for (const event of events) for (const listener of this.#listeners) listener(event);
      return result;
    } catch (error) {
      this.#pending = undefined;
      if (!committed && this.#db.inTransaction) this.#db.exec('ROLLBACK');
      throw this.#classify(error);
    }
  }

  /** 读取同样经过故障分类：存储故障使状态存储进入不可用状态。 */
  #read<T>(work: () => T): T {
    try {
      this.#fault('read');
      return work();
    } catch (error) {
      throw this.#classify(error);
    }
  }

  #classify(error: unknown): unknown {
    if (!isStorageFault(error)) return error;
    if (this.#healthy) {
      this.#healthy = false;
      this.#onFault(error as Error);
    }
    return new StoreUnavailable(error);
  }

  append<T>(
    type: string,
    data: T,
    meta?: { source?: string; occurredAt?: number },
  ): StoredEvent<T> {
    return this.transaction((tx) => tx.append(type, data, meta), 'append');
  }

  nextToken(resource: string): number {
    return this.transaction((tx) => tx.nextToken(resource), 'token');
  }

  /** 资源当前的执行许可令牌；从未授予过时为 0。 */
  token(resource: string): number {
    const row = this.#read(() =>
      this.#db.prepare('SELECT token FROM lease_tokens WHERE resource = ?').get(resource),
    );
    return row ? Number(row.token) : 0;
  }

  view<S>(projection: Projection<S>): S {
    if (!this.#views.has(projection.name)) throw new Error(`投影 ${projection.name} 未注册`);
    return this.#views.get(projection.name) as S;
  }

  events(afterSeq = 0): StoredEvent[] {
    return this.#read(() =>
      this.#db
        .prepare('SELECT * FROM events WHERE seq > ? ORDER BY seq')
        .all(afterSeq)
        .map(toEvent),
    );
  }

  /** 订阅提交后的新事件；重放历史事件时不通知。 */
  subscribe(listener: (event: StoredEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** 测试用的检查点：在两次写入之间模拟崩溃。 */
  checkpoint(point: string): void {
    this.#fault(point);
  }

  /**
   * 写入意图，同事务记录授权事件。幂等键已存在时返回已有意图，不再写入；
   * 同一幂等键但任何授权字段不同都视为篡改，抛错。目标上有结果未知的意图时抛 ResourceIsolated。
   */
  authorize(input: IntentInput): { intent: Intent; duplicate: boolean } {
    const existing = this.intentByKey(input.key);
    if (existing) {
      if (!sameRequest(existing, input)) throw new Error(`幂等键 ${input.key} 已用于不同的意图`);
      return { intent: existing, duplicate: true };
    }
    const isolated = this.#read(() =>
      this.#db
        .prepare(
          "SELECT key FROM intents WHERE state = 'unknown' AND target = ? ORDER BY id LIMIT 1",
        )
        .get(input.target),
    );
    if (isolated) throw new ResourceIsolated(input.target, String(isolated.key));
    const intent = this.transaction((tx) => {
      const now = this.#now();
      const row = this.#db
        .prepare(
          `INSERT INTO intents (key, type, target, payload_hash, source, capabilities, time_sensitive,
             state, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?) RETURNING *`,
        )
        .get(
          input.key,
          input.type,
          input.target,
          input.payloadHash,
          JSON.stringify(input.source),
          JSON.stringify(input.capabilities),
          input.timeSensitive ? 1 : 0,
          now,
          now,
        ) as Row;
      const created = toIntent(row);
      tx.append('intent.authorized', {
        id: created.id,
        key: created.key,
        type: created.type,
        target: created.target,
        capabilities: created.capabilities,
        source: created.source,
      });
      return created;
    }, 'authorize');
    return { intent, duplicate: false };
  }

  /** 先写“执行中”再执行副作用：执行中崩溃，重启后能识别为结果未知。 */
  start(id: number): Intent {
    return this.#move(id, 'executing', 'intent.started', {}, 'start');
  }

  succeed(id: number, result: unknown): Intent {
    return this.#move(id, 'succeeded', 'intent.succeeded', { result: result ?? null }, 'complete');
  }

  fail(id: number, error: string): Intent {
    return this.#move(id, 'failed', 'intent.failed', { error }, 'complete');
  }

  /** 对账或人工结案：结果未知的意图补记结果。有时效的意图只能由操作员结案。 */
  resolve(id: number, outcome: Outcome, by: 'reconcile' | 'operator'): Intent {
    const current = this.intent(id);
    if (current?.state !== 'unknown') throw new Error(`意图 ${id} 不是 unknown，不能结案`);
    if (by === 'reconcile' && current.timeSensitive) {
      throw new Error(`意图 ${id} 有时效，只能由操作员结案`);
    }
    return outcome.ok
      ? this.#move(
          id,
          'succeeded',
          'intent.reconciled',
          { by, result: outcome.result ?? null },
          'resolve',
        )
      : this.#move(id, 'failed', 'intent.reconciled', { by, error: outcome.error }, 'resolve');
  }

  intent(id: number): Intent | undefined {
    const row = this.#read(() => this.#db.prepare('SELECT * FROM intents WHERE id = ?').get(id));
    return row ? toIntent(row) : undefined;
  }

  intentByKey(key: string): Intent | undefined {
    const row = this.#read(() => this.#db.prepare('SELECT * FROM intents WHERE key = ?').get(key));
    return row ? toIntent(row) : undefined;
  }

  intentsIn(state: IntentState): Intent[] {
    return this.#read(() =>
      this.#db
        .prepare('SELECT * FROM intents WHERE state = ? ORDER BY id')
        .all(state)
        .map(toIntent),
    );
  }

  /**
   * 重启后调用一次：还没开始执行的意图标为失败（放弃）；停在执行中的意图标为 `unknown`。
   * 永不重做副作用。可对账的意图由其所有者查询外部状态后用 `resolve` 补记。
   */
  recover(): RecoveryReport {
    return this.transaction((tx) => {
      const abandoned = this.intentsIn('pending').map((intent) => {
        this.#update(intent.id, 'failed', { error: '重启时尚未执行，已放弃' });
        tx.append('intent.abandoned', { id: intent.id, key: intent.key });
        return this.intent(intent.id) as Intent;
      });
      const orphaned = this.intentsIn('executing').map((intent) => {
        this.#update(intent.id, 'unknown', {});
        tx.append('intent.orphaned', {
          id: intent.id,
          key: intent.key,
          target: intent.target,
          timeSensitive: intent.timeSensitive,
        });
        return this.intent(intent.id) as Intent;
      });
      return { abandoned, orphaned };
    }, 'recover');
  }

  #move(
    id: number,
    to: IntentState,
    eventType: string,
    data: Record<string, unknown>,
    point: string,
  ): Intent {
    return this.transaction((tx) => {
      this.#update(id, to, data);
      tx.append(eventType, { id, ...data });
      return this.intent(id) as Intent;
    }, point);
  }

  #update(id: number, to: IntentState, data: { result?: unknown; error?: string }): void {
    const current = this.intent(id);
    if (!current) throw new Error(`没有意图 ${id}`);
    if (!TRANSITIONS[current.state].includes(to)) {
      throw new Error(`意图 ${id} 不能从 ${current.state} 变为 ${to}`);
    }
    this.#db
      .prepare('UPDATE intents SET state = ?, result = ?, error = ?, updated_at = ? WHERE id = ?')
      .run(
        to,
        'result' in data ? JSON.stringify(data.result) : null,
        data.error ?? null,
        this.#now(),
        id,
      );
  }

  #append<T>(
    type: string,
    data: T,
    meta: { source?: string; occurredAt?: number } = {},
  ): StoredEvent<T> {
    const pending = this.#pending;
    if (!pending) throw new Error('只能在事务内追加事件');
    const recordedAt = this.#now();
    const row = this.#db
      .prepare(
        'INSERT INTO events (type, source, occurred_at, recorded_at, data) VALUES (?, ?, ?, ?, ?) RETURNING seq',
      )
      .get(
        type,
        meta.source ?? 'bellis',
        meta.occurredAt ?? recordedAt,
        recordedAt,
        JSON.stringify(data),
      ) as Row;
    const event: StoredEvent<T> = {
      seq: Number(row.seq),
      type,
      source: meta.source ?? 'bellis',
      occurredAt: meta.occurredAt ?? recordedAt,
      recordedAt,
      data,
    };
    for (const projection of this.#projections) {
      const next = deepFreeze(projection.reduce(pending.views.get(projection.name), event));
      pending.views.set(projection.name, next);
      this.#db
        .prepare(
          `INSERT INTO projections (name, state, seq) VALUES (?, ?, ?)
           ON CONFLICT (name) DO UPDATE SET state = excluded.state, seq = excluded.seq`,
        )
        .run(projection.name, JSON.stringify(next), event.seq);
    }
    pending.events.push(event);
    return event;
  }

  #nextToken(resource: string): number {
    const row = this.#db
      .prepare(
        `INSERT INTO lease_tokens (resource, token) VALUES (?, 1)
         ON CONFLICT (resource) DO UPDATE SET token = token + 1 RETURNING token`,
      )
      .get(resource) as Row;
    return Number(row.token);
  }

  #checkVersion(): void {
    const row = this.#db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
    if (!row) {
      this.#db
        .prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)")
        .run(String(SCHEMA_VERSION));
    } else if (row.value !== String(SCHEMA_VERSION)) {
      throw new Error(`数据库结构版本 ${row.value} 与程序 ${SCHEMA_VERSION} 不一致`);
    }
  }

  /** 从事件完整重放投影，覆盖库中保存的投影；重放期间不通知订阅者。 */
  #rebuild(): void {
    const views = new Map<string, unknown>(
      this.#projections.map((p) => [p.name, deepFreeze(p.initial)]),
    );
    const events = this.events();
    for (const event of events) {
      for (const projection of this.#projections) {
        views.set(
          projection.name,
          deepFreeze(projection.reduce(views.get(projection.name), event)),
        );
      }
    }
    const last = events.at(-1)?.seq ?? 0;
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      for (const projection of this.#projections) {
        this.#db
          .prepare(
            `INSERT INTO projections (name, state, seq) VALUES (?, ?, ?)
             ON CONFLICT (name) DO UPDATE SET state = excluded.state, seq = excluded.seq`,
          )
          .run(projection.name, JSON.stringify(views.get(projection.name)), last);
      }
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
    this.#views = views;
  }
}

function toEvent(row: Row): StoredEvent {
  return {
    seq: Number(row.seq),
    type: String(row.type),
    source: String(row.source),
    occurredAt: Number(row.occurred_at),
    recordedAt: Number(row.recorded_at),
    data: JSON.parse(String(row.data)),
  };
}

function toIntent(row: Row): Intent {
  return {
    id: Number(row.id),
    key: String(row.key),
    type: String(row.type),
    target: String(row.target),
    payloadHash: String(row.payload_hash),
    source: JSON.parse(String(row.source)),
    capabilities: JSON.parse(String(row.capabilities)),
    timeSensitive: row.time_sensitive === 1 || row.time_sensitive === 1n,
    state: String(row.state) as IntentState,
    result: row.result === null ? undefined : JSON.parse(String(row.result)),
    error: row.error === null ? undefined : String(row.error),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}
