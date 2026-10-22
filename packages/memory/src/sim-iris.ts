import { ClockService, definePlugin, defineService, TraceService } from '@bellis/kernel';
import Type from 'typebox';
import { IrisHealth } from './health.ts';
import { type Iris, IrisError, type IrisMemory, type IrisMessage, IrisService } from './iris.ts';

/** 模拟 Iris 里存下的一条消息。 */
export interface SimIrisMessage {
  id: number;
  entryId: string;
  dedupeKey: string;
  kind: IrisMessage['kind'];
  account: string | null;
  sender: string;
  content: string;
}

/**
 * 模拟 Iris 的数据（仿真与测试用）：按契约在同一入口里按去重键去重（重复的键返回原消息的 ID，不覆盖正文），
 * 召回时把最近存下的消息当作记忆返回（说话人为写入时的显示名，来源为那条消息）。它代表进程外的服务，
 * 由仿真在各次启动之间保留（核心服务 `iris.sim-backend@1`），宿主崩溃重启后数据仍在。
 */
export class SimIrisBackend {
  readonly messages: SimIrisMessage[] = [];
  readonly feedback: Array<{ recallId: string; memoryIds: number[] }> = [];
  readonly #byKey = new Map<string, number>();
  #recalls = 0;

  write(entryId: string, messages: readonly IrisMessage[]): number[] {
    return messages.map((message) => {
      const key = `${entryId}\u0000${message.dedupeKey}`;
      const existing = this.#byKey.get(key);
      if (existing !== undefined) return existing;
      const id = this.messages.length + 1;
      this.#byKey.set(key, id);
      this.messages.push({
        id,
        entryId,
        dedupeKey: message.dedupeKey,
        kind: message.kind,
        account: message.accountId ?? null,
        sender: message.sender,
        content: message.content,
      });
      return id;
    });
  }

  /** 最近 `limit` 条本入口的消息，各作一条记忆（新的在前）。 */
  recall(entryId: string, limit: number): { recallId: string; memories: IrisMemory[] } {
    this.#recalls += 1;
    const memories = this.messages
      .filter((message) => message.entryId === entryId)
      .slice(limit > 0 ? -limit : Number.POSITIVE_INFINITY)
      .reverse()
      .map(
        (message): IrisMemory => ({
          id: message.id,
          content: message.content,
          kind: '事件',
          stance: message.kind === 'self_output' ? '亲历' : '转述',
          speakerName: message.sender,
          about: [],
          sources: [{ messageId: message.id, entryId }],
        }),
      );
    return { recallId: `sim-recall-${this.#recalls}`, memories };
  }
}

export const SimIrisBackendService = defineService<SimIrisBackend>('iris.sim-backend', 1);

/** 写入的故障：`reject` 没存下就失败（503），`lost` 存下了但应答丢失（超时，客户端不知道写没写成）。 */
export const SIM_WRITE_FAULTS = ['ok', 'reject', 'lost'] as const;
export type SimWriteFault = (typeof SIM_WRITE_FAULTS)[number];

/**
 * 模拟 Iris（`iris-sim`，提供 `iris@1`）：仿真与测试用，不连任何端点。召回可以设延迟（超过调用方的截止时间
 * 即超时），写入按 `writeFaults` 依次注入故障（循环使用）。数据在核心服务 `iris.sim-backend@1` 里，没有时
 * 每次激活新建一份。在仿真里把每次写入与召回写进追踪。
 */
export const simIris = definePlugin({
  manifest: {
    id: 'iris-sim',
    version: '0.1.0',
    tier: 'ordinary',
    provides: [IrisService.ref],
    inject: [ClockService.ref, `${SimIrisBackendService.ref}?`, `${TraceService.ref}?`],
    permissions: [],
    process: 'in-process',
    config: Type.Object({
      /** 召回准备的耗时；超过调用方的截止时间即超时。 */
      recallDelayMs: Type.Integer({ minimum: 0, default: 0 }),
      /** 写入的应答耗时：先存下，再等这么久才应答。 */
      writeDelayMs: Type.Integer({ minimum: 0, default: 0 }),
      /** 依次用于每次写入的故障，循环使用；空表示总是成功。 */
      writeFaults: Type.Array(
        Type.Union([Type.Literal('ok'), Type.Literal('reject'), Type.Literal('lost')]),
        { default: [] },
      ),
      /** 召回时另外返回一条来源不在本入口的记忆（召回过滤应当丢弃它）。 */
      foreignMemory: Type.Boolean({ default: false }),
      /** 召回准备返回的当前人设；不配置时正文为空（Iris 没有当前人设）。 */
      persona: Type.Optional(
        Type.Object({
          content: Type.String(),
          version: Type.Union([Type.Integer(), Type.Null()], { default: null }),
        }),
      ),
    }),
  },
  activate(ctx) {
    const clock = ctx.service(ClockService);
    const backend = ctx.optional(SimIrisBackendService) ?? new SimIrisBackend();
    const trace = ctx.optional(TraceService);
    const health = new IrisHealth(3, () => clock.now());
    const config = ctx.config;
    let writes = 0;

    /** 等 `ms` 毫秒（时钟），中止即以 `aborted` 结束。 */
    const wait = (ms: number, signal: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
          reject(new IrisError('aborted', '已取消'));
          return;
        }
        if (ms <= 0) {
          resolve();
          return;
        }
        const onAbort = () => {
          clock.clearTimeout(timer);
          reject(new IrisError('aborted', '已取消'));
        };
        const timer = clock.setTimeout(() => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        }, ms);
        signal.addEventListener('abort', onAbort, { once: true });
      });

    const tracked = async <T>(work: () => Promise<T>): Promise<T> => {
      try {
        const value = await work();
        health.succeeded();
        return value;
      } catch (error) {
        if (error instanceof IrisError) health.failed(error);
        throw error;
      }
    };

    const iris: Iris = {
      write(entryId, messages, signal) {
        return tracked(async () => {
          const fault: SimWriteFault =
            config.writeFaults[writes % Math.max(1, config.writeFaults.length)] ?? 'ok';
          writes += 1;
          if (fault === 'reject') {
            trace?.record('iris.write', { entryId, keys: messages.map((m) => m.dedupeKey), fault });
            throw new IrisError('unavailable', '模拟 Iris 暂不可用', {
              status: 503,
              retryAfterMs: 1000,
            });
          }
          const before = backend.messages.length;
          const ids = backend.write(entryId, messages);
          trace?.record('iris.write', {
            entryId,
            keys: messages.map((m) => m.dedupeKey),
            fault,
            stored: backend.messages.slice(before).map((m) => ({ ...m })),
          });
          // 应答在路上：这时中止或宿主崩溃，Iris 已经存下了，客户端却不知道。
          await wait(config.writeDelayMs, signal);
          if (fault === 'lost') throw new IrisError('timeout', '模拟 Iris 的应答丢失');
          return { messageIds: ids, pendingCount: ids.length };
        });
      },
      prepare(entryId, request, signal) {
        return tracked(async () => {
          await wait(config.recallDelayMs, signal);
          const { recallId, memories } = backend.recall(entryId, request.memoryLimit);
          if (config.foreignMemory && request.memoryLimit > 0) {
            memories.push({
              id: 1_000_000 + memories.length,
              content: '这是别的入口里的记忆',
              about: [],
              sources: [{ messageId: 1_000_000, entryId: null }],
            });
          }
          trace?.record('iris.prepare', { entryId, recallId, ids: memories.map((m) => m.id) });
          return {
            recallId,
            memories,
            persona: config.persona
              ? { content: config.persona.content, version: config.persona.version }
              : { content: '', version: null },
            judgment: request.judge ? 'applied' : 'disabled',
          };
        });
      },
      feedback(recallId, memoryIds) {
        return tracked(async () => {
          backend.feedback.push({ recallId, memoryIds: [...memoryIds] });
          trace?.record('iris.feedback', { recallId, memoryIds: [...memoryIds] });
          return { accepted: [...memoryIds], strengthened: [...memoryIds] };
        });
      },
      check() {
        return tracked(async () => ({ service: 'ready' }));
      },
      get ready() {
        return health.ready;
      },
      get status() {
        return `模拟 Iris：${health.status}`;
      },
      get failures() {
        return health.failures;
      },
    };
    ctx.provide(IrisService, iris);
  },
});
