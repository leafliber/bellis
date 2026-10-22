import { type Danmaku, DanmakuService, looksLikeInjection, sanitizeText } from '@bellis/audience';
import {
  ClockService,
  DeadlineError,
  definePlugin,
  RandomService,
  type TimerHandle,
  TraceService,
} from '@bellis/kernel';
import { SafetyService } from '@bellis/safety';
import { type UtteranceOutcome, UtterancePlayed } from '@bellis/speech';
import { ErrorType, Metric, TelemetryService, useTracer } from '@bellis/telemetry';
import Type, { type Static } from 'typebox';
import {
  entryIdBlocker,
  IrisError,
  type IrisMemory,
  type IrisMessage,
  type IrisPersona,
  IrisService,
  irisFailureText,
} from './iris.ts';
import {
  dedupeKey,
  MemoryFact,
  memoryLedger,
  pseudonym,
  pseudonymCode,
  type QueuedItem,
  type QueuedKind,
  validAccount,
} from './ledger.ts';
import { cleanText, DEFAULT_PRIVACY_RULES, PrivacyGateway } from './privacy.ts';
import { type Memory, type MemoryPersona, MemoryService, type RecalledMemory } from './service.ts';

/** 写入 Iris 所需的能力（执行闸门）。不在 Rule of Two 的禁止清单里：写入的内容总含不可信输入。 */
export const MEMORY_WRITE = 'memory.write';

/** 首次创建入口时的类型：直播间。 */
const ENTRY_KIND = 'live';

/** 同一时刻记住的召回（使用反馈用）：只回报最近这么多次召回里的。 */
const RECALLS_KEPT = 32;

/** 开播预检访问 Iris 的截止时间。 */
const CHECK_TIMEOUT_MS = 5_000;

export const MemoryConfig = Type.Object({
  /**
   * Iris 的入口 ID（直播间）：1–200 个字符，不含 `?`、`#` 与控制字符；建议带连接器名字作前缀，
   * 例如 `bellis:bilibili:<房间号>`，宿主令牌的范围按这个前缀授予。空串表示未配置。
   */
  entryId: Type.String({ default: '' }),
  /** 首次创建入口时的名字。 */
  entryName: Type.String({ minLength: 1, maxLength: 200, default: '直播间' }),
  /** 写入的 `platform`。 */
  platform: Type.String({ minLength: 1, maxLength: 100, default: 'bilibili' }),
  /** 角色自己的发言写入时的显示名。 */
  selfName: Type.String({ minLength: 1, maxLength: 200, default: '主播' }),
  /** 首次创建入口时的学习节奏。 */
  pace: Type.Union([Type.Literal('realtime'), Type.Literal('standard'), Type.Literal('economy')], {
    default: 'standard',
  }),
  recall: Type.Object(
    {
      /** 召回判断：缺省关闭，避免默认的长等待。 */
      judge: Type.Boolean({ default: false }),
      /** 打开召回判断时的预算（秒，只能缩短缺省的 10 秒）；不配置就不发。 */
      judgeBudgetSeconds: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 10 })),
      memoryLimit: Type.Integer({ minimum: 1, maximum: 8, default: 5 }),
      tokenBudget: Type.Integer({ minimum: 1, maximum: 1500, default: 600 }),
      /** 每条记忆进入上下文的字数上限（码点）。 */
      maxChars: Type.Integer({ minimum: 1, maximum: 500, default: 120 }),
    },
    { default: {} },
  ),
  write: Type.Object(
    {
      /** 写入观众的弹幕（观众声称）。 */
      danmaku: Type.Boolean({ default: true }),
      /** 写入角色的发言（只含观众实际听到的部分）。 */
      speech: Type.Boolean({ default: true }),
      /** 一批至多这么多条（Iris 一次接收 1–1000 条，整批原子）。 */
      batchSize: Type.Integer({ minimum: 1, maximum: 1000, default: 50 }),
      /** 进入待发队列后等这么久再写，攒成一批。 */
      flushDelayMs: Type.Integer({ minimum: 0, default: 2_000 }),
      /** 待发队列的容量：满了丢弃最旧的并记录（`memory.dropped`，`overflow`）。 */
      capacity: Type.Integer({ minimum: 1, maximum: 5_000, default: 500 }),
      /** 失败后的重试间隔：从这里起翻倍，至多 `retryMaxMs`；Iris 给了 Retry-After 时按它。 */
      retryMinMs: Type.Integer({ minimum: 1, default: 1_000 }),
      retryMaxMs: Type.Integer({ minimum: 1, default: 60_000 }),
      /** 弹幕写入时的字数上限（码点，净化后截断）。 */
      maxChars: Type.Integer({ minimum: 1, maximum: 2_000, default: 200 }),
    },
    { default: {} },
  ),
  /** 命中提示注入检测的弹幕不写入，召回的记忆命中也不用。 */
  skipInjection: Type.Boolean({ default: true }),
  persona: Type.Object(
    {
      /**
       * 取人设用的入口，缺省为 `entryId`。人设是角色全局的，令牌范围内任一已经存在的入口都返回同一份；
       * 直播间入口还没写入过消息时 Iris 返回 404，可以先指向一个已经存在的入口。
       */
      entryId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      /** 人设正文的字数上限（码点），超长截断并记日志。 */
      maxChars: Type.Integer({ minimum: 1, maximum: 10_000, default: 2_000 }),
    },
    { default: {} },
  ),
  privacy: Type.Object(
    {
      /** 隐私网关的规则（见 privacy.ts）；整体替换，空数组表示不过滤。 */
      rules: Type.Array(
        Type.Object(
          {
            category: Type.String({ pattern: '^[a-z][a-z0-9_-]{0,31}$' }),
            pattern: Type.String({ minLength: 1, maxLength: 1_000 }),
          },
          { additionalProperties: false },
        ),
        { default: DEFAULT_PRIVACY_RULES.map((rule) => ({ ...rule })) },
      ),
    },
    { default: {} },
  ),
});
export type MemoryConfig = Static<typeof MemoryConfig>;

/** 本条为什么不写：写进 `memory.filtered` 的类别。 */
const INJECTION = 'injection';

function hex(random: { int(min: number, max: number): number }, digits: number): string {
  let out = '';
  for (let i = 0; i < digits; i += 1) out += random.int(0, 15).toString(16);
  return out;
}

function describe(error: unknown): string {
  if (error instanceof IrisError) return irisFailureText(error);
  return error instanceof Error ? error.message : String(error);
}

/**
 * 记忆（普通插件，`memory@1`）：经隐私网关接入 Iris（D-10、R-19）。解读观众输入，按 Rule of Two 不持有任何凭据，
 * 收发交给 Iris 客户端（`iris@1`）。
 *
 * - **写入**：订阅弹幕（`danmaku@1`，可选）与发声结果（扩展点 `speech.played`，只含观众实际听到的部分）；
 *   净化、注入检测与隐私网关拦下的只记类别（`memory.filtered`），其余记 `memory.queued` 进入待发队列
 *   （投影 `memory.ledger`，重启时从事件重建）。观众消息作为 `message` 写入，带平台稳定 ID 与由它派生的代号，
 *   不带昵称；角色的发言作为 `self_output`。
 * - **去重键**（见 ledger.ts 的 `dedupeKey`）：前缀随机、每个状态存储记一次（`memory.epoch`）；弹幕加平台消息编号，
 *   发言加 `memory.queued` 的序号。重试与重启后补发沿用同一个键，Iris 按键返回原消息，不会重复写入。
 * - **待发队列**：有界，满了丢弃最旧的并记录；按批写入，失败按退避重试（429、503 按 Retry-After），
 *   Iris 拒收（400、413）时二分找出那一条丢弃并记录；不阻塞直播。
 * - **执行闸门**：每一批作为一个没有时效的意图（能力 `memory.write`，目标 `iris:<入口>`）申请授权后再写；
 *   安全停止中不申请，等模式恢复。执行中崩溃的意图在重启后对账为失败，这批仍在队列里，以原键补发。
 * - **墓碑**（`memory.tombstoned`，操作员登记）：队列里这名观众的条目立即移除，此后不写入；发出之前再核对一次。
 *   召回的记忆提到这名观众（说话人、涉及的人或正文里有他的代号）的不用。
 * - **召回**：只召回直播间入口内的公开事实（`prepare`，关闭召回判断，不取人物要点、人物摘要、近期原始消息与目标）；
 *   截止时间由调用方给。来源不全在本入口的、提到有墓碑的观众的、命中隐私规则或注入检测的记忆都丢弃。
 * - **使用反馈**：调用方回报这次召回里实际用到的编号（`m1`…），只回报这次给出的，没用到就回报空集。
 * - **人设**：记住最近一次从 Iris 拿到的人设（召回准备的 `persona` 分区，只取正文与版本号；为空视同没有，超长截断），
 *   激活时与每次召回时更新，开播预检时再取一次；决策插件据此选用人设（见决策模型“人设”）。
 *
 * 遥测：召回与每批写入各一个 span（`memory.recall`、`memory.write`），召回耗时记直方图
 * `bellis.memory.recall.duration`；只记条数、类别与耗时，不记内容。
 */
export const memory = definePlugin({
  manifest: {
    id: 'memory',
    version: '0.1.0',
    tier: 'ordinary',
    provides: [MemoryService.ref],
    inject: [
      IrisService.ref,
      SafetyService.ref,
      ClockService.ref,
      RandomService.ref,
      `${DanmakuService.ref}?`,
      `${TelemetryService.ref}?`,
      `${TraceService.ref}?`,
    ],
    permissions: [MEMORY_WRITE],
    process: 'in-process',
    config: MemoryConfig,
  },
  activate(ctx) {
    const config = ctx.config;
    const blocked =
      config.entryId === ''
        ? '未配置入口 ID（entryId）'
        : (entryIdBlocker(config.entryId) ??
          (config.persona.entryId === undefined
            ? undefined
            : entryIdBlocker(config.persona.entryId)));
    if (blocked) {
      ctx.log('memory.unavailable', { reason: blocked });
      throw new Error(`记忆插件不可用：${blocked}`);
    }
    const gateway = new PrivacyGateway(config.privacy.rules);
    const iris = ctx.service(IrisService);
    const safety = ctx.service(SafetyService);
    const clock = ctx.service(ClockService);
    const random = ctx.service(RandomService);
    const trace = ctx.optional(TraceService);
    const tracer = useTracer(ctx, 'memory');
    const entryId = config.entryId;
    const target = `iris:${entryId}`;

    // 去重键的前缀：每个状态存储记一次。
    if (safety.view(memoryLedger).epoch === null) {
      safety.record(MemoryFact.Epoch, { id: hex(random, 16) });
    }
    const epoch = safety.view(memoryLedger).epoch;
    if (epoch === null) throw new Error('记忆插件不可用：记不下去重键的前缀（状态存储不可用？）');

    // 先查状态再补发：执行中崩溃的写入意图结果未知。这批仍在待发队列里（没有 memory.written），
    // 以原去重键补发，Iris 按键返回原消息；所以这里把意图对账为失败，不声称已写入。
    for (const intent of safety.unresolved(MEMORY_WRITE)) {
      safety.reconcile(intent, {
        ok: false,
        error: '重启时结果未知；这批仍在待发队列里，以原去重键补发（Iris 按去重键返回原消息）',
      });
      ctx.log('memory.reconciled', { key: intent.key });
    }

    // ------------------------------------------------------------------ 写入

    const ledger = () => safety.view(memoryLedger);
    let timer: TimerHandle | undefined;
    let timerDue = Number.POSITIVE_INFINITY;
    let flushing = false;
    /** 安全停止中：不申请授权，等模式恢复。 */
    let waitingForMode = false;
    let backoffMs = 0;
    let retryAt: number | undefined;
    /** 二分找 Iris 拒收的那一条：下一批至多这么多条；0 表示按 batchSize。 */
    let split = 0;
    let attempts = 0;
    let overflowing = false;

    const schedule = (delayMs: number) => {
      if (ctx.signal.aborted) return;
      const due = clock.now() + delayMs;
      if (timer !== undefined && timerDue <= due) return;
      if (timer !== undefined) clock.clearTimeout(timer);
      timerDue = due;
      timer = clock.setTimeout(() => {
        timer = undefined;
        timerDue = Number.POSITIVE_INFINITY;
        void flush();
      }, delayMs);
    };

    const retryLater = (error: unknown) => {
      const advised = error instanceof IrisError ? error.retryAfterMs : undefined;
      backoffMs = Math.min(
        config.write.retryMaxMs,
        Math.max(config.write.retryMinMs, backoffMs * 2),
      );
      const delay =
        error instanceof IrisError && (error.kind === 'auth' || error.kind === 'forbidden')
          ? config.write.retryMaxMs
          : (advised ?? backoffMs);
      retryAt = clock.now() + delay;
      schedule(delay);
    };

    const toMessage = (item: QueuedItem): IrisMessage => ({
      platform: config.platform,
      sender: item.sender,
      ...(item.account === null ? {} : { accountId: item.account }),
      content: item.content,
      occurredAt: new Date(item.at).toISOString(),
      dedupeKey: dedupeKey(epoch, item),
      kind: item.kind,
      entryName: config.entryName,
      entryKind: ENTRY_KIND,
      pace: config.pace,
    });

    const flush = async (): Promise<void> => {
      if (flushing || ctx.signal.aborted) return;
      const outbox = ledger().outbox;
      if (outbox.length === 0) return;
      if (safety.mode === 'safe-stop') {
        waitingForMode = true;
        return;
      }
      waitingForMode = false;
      flushing = true;
      try {
        await writeBatch(outbox);
      } catch (error) {
        // 本插件自己的错误（不是 Iris 的失败）：记下后稍后再试。
        ctx.log('memory.flush-failed', { error: describe(error) });
        retryLater(error);
      } finally {
        flushing = false;
      }
    };

    const writeBatch = async (outbox: readonly QueuedItem[]) => {
      const limit = split > 0 ? split : config.write.batchSize;
      const batch: QueuedItem[] = [];
      const privacy: Array<{ seq: number; categories: string[] }> = [];
      for (const item of outbox) {
        if (batch.length >= limit) break;
        // 隐私规则可能在排队之后改过（重启后）：发出之前按现在的规则再过一次。
        const verdict = gateway.check(item.content);
        if (verdict.ok) batch.push(item);
        else privacy.push({ seq: item.seq, categories: verdict.categories });
      }
      if (privacy.length > 0) {
        safety.record(MemoryFact.Dropped, {
          seqs: privacy.map((p) => p.seq),
          cause: 'privacy',
          categories: [...new Set(privacy.flatMap((p) => p.categories))],
        });
      }
      if (batch.length === 0) {
        if (ledger().outbox.length > 0) schedule(0);
        return;
      }
      const messages = batch.map(toMessage);
      const seqs = batch.map((item) => item.seq);
      const span = tracer.startSpan('memory.write', {
        kind: 'client',
        attributes: { 'bellis.memory.batch_size': batch.length },
      });
      attempts += 1;
      const payload = { entryId, messages };
      const decision = await safety.authorize({
        key: `memory.write:${ctx.instanceId}:${attempts}`,
        type: MEMORY_WRITE,
        target,
        payload,
        // 观众的弹幕是不可信输入；角色的发言也可能受弹幕影响。
        source: { origin: 'memory', inputs: batch.map((item) => item.ref), untrusted: true },
        capabilities: [MEMORY_WRITE],
        timeSensitive: false,
      });
      if (!decision.allowed || decision.duplicate) {
        const reason = decision.allowed ? '同一意图已经执行过' : decision.reason;
        span.setAttributes({ 'bellis.memory.outcome': 'denied' });
        span.fail('denied');
        span.end();
        ctx.log('memory.write-denied', { reason });
        if (safety.mode === 'safe-stop') waitingForMode = true;
        else retryLater(undefined);
        return;
      }
      let ids: number[] | undefined;
      let failure: unknown;
      const intent = await safety.execute(decision.intent, payload, async (checked) => {
        // 墓碑可能在组批之后登记：这批里有这名观众的就不发，下一轮重新组批（队列里的已被移除）。
        const tombstones = new Set(ledger().tombstones);
        if (batch.some((item) => item.account !== null && tombstones.has(item.account))) {
          failure = new Error('组批之后登记了墓碑，这批不发');
          throw failure;
        }
        if (ctx.signal.aborted) {
          failure = new Error('记忆插件停用');
          throw failure;
        }
        trace?.record('memory.write-sent', {
          keys: checked.messages.map((m) => m.dedupeKey),
        });
        try {
          const result = await iris.write(entryId, checked.messages, ctx.signal);
          ids = result.messageIds;
          return { count: result.messageIds.length };
        } catch (error) {
          failure = error;
          throw error;
        }
      });
      if (intent.state === 'succeeded' && ids !== undefined) {
        safety.record(MemoryFact.Written, { seqs, messageIds: ids });
        span.setAttributes({ 'bellis.memory.outcome': 'written' });
        span.end();
        backoffMs = 0;
        retryAt = undefined;
        split = 0;
        if (ledger().outbox.length > 0) schedule(0);
        return;
      }
      const kind = failure instanceof IrisError ? failure.kind : 'withheld';
      span.setAttributes({ 'bellis.memory.outcome': 'failed' });
      span.fail(kind);
      span.end();
      ctx.log('memory.write-failed', {
        count: batch.length,
        ...(failure instanceof IrisError
          ? {
              kind: failure.kind,
              ...(failure.status === undefined ? {} : { status: failure.status }),
              ...(failure.code === undefined ? {} : { code: failure.code }),
            }
          : { error: describe(failure ?? intent.error) }),
      });
      if (failure instanceof IrisError && (kind === 'invalid' || kind === 'too_large')) {
        // Iris 拒收：整批原子，二分找出那一条；只剩一条时丢弃并记录。
        const first = batch[0];
        if (batch.length === 1 && first) {
          safety.record(MemoryFact.Dropped, {
            seqs: [first.seq],
            cause: 'rejected',
            ...(failure.status === undefined ? {} : { status: failure.status }),
            ...(failure.code === undefined ? {} : { code: failure.code }),
          });
          split = 0;
        } else {
          split = Math.ceil(batch.length / 2);
        }
        schedule(0);
        return;
      }
      if (!(failure instanceof IrisError) && ledger().outbox.length > 0) {
        // 没有发出（墓碑、停用）：立即重新组批。
        schedule(0);
        return;
      }
      retryLater(failure);
    };

    const enqueue = (item: {
      kind: QueuedKind;
      ref: string;
      account: string | null;
      sender: string;
      content: string;
    }) => {
      const over = ledger().outbox.length + 1 - config.write.capacity;
      if (over > 0) {
        const oldest = ledger().outbox.slice(0, over);
        safety.record(MemoryFact.Dropped, {
          seqs: oldest.map((queued) => queued.seq),
          cause: 'overflow',
        });
        if (!overflowing) ctx.log('memory.overflow', { capacity: config.write.capacity });
        overflowing = true;
      } else {
        overflowing = false;
      }
      safety.record(MemoryFact.Queued, item);
      schedule(config.write.flushDelayMs);
    };

    const filtered = (source: 'danmaku' | 'speech', ref: string, categories: string[]) => {
      safety.record(MemoryFact.Filtered, { source, ref, categories });
      ctx.log('memory.filtered', { source, categories });
    };

    const onDanmaku = (danmaku: Danmaku) => {
      if (!config.write.danmaku || ctx.signal.aborted) return;
      if (!validAccount(danmaku.viewer)) {
        ctx.log('memory.skipped', { why: 'account' });
        return;
      }
      // 有墓碑的观众：不写入，也不记内容。
      if (ledger().tombstones.includes(danmaku.viewer)) return;
      // 平台重发、还在队列里的同一条弹幕：不再排队（已经写入的，Iris 按同一个去重键返回原消息）。
      if (ledger().outbox.some((item) => item.kind === 'message' && item.ref === danmaku.id)) {
        ctx.log('memory.skipped', { why: 'duplicate' });
        return;
      }
      const content = sanitizeText(danmaku.text, config.write.maxChars);
      if (content === '') return;
      if (config.skipInjection && looksLikeInjection(content)) {
        filtered('danmaku', danmaku.id, [INJECTION]);
        return;
      }
      const verdict = gateway.check(content);
      if (!verdict.ok) {
        filtered('danmaku', danmaku.id, verdict.categories);
        return;
      }
      enqueue({
        kind: 'message',
        ref: danmaku.id,
        account: danmaku.viewer,
        sender: pseudonym(danmaku.viewer),
        content,
      });
    };

    const onPlayed = (outcome: UtteranceOutcome) => {
      if (!config.write.speech || ctx.signal.aborted) return;
      // 只写观众实际听到的部分（写回），原样写入。
      const content = outcome.heard;
      if (content.trim() === '') return;
      const verdict = gateway.check(content);
      if (!verdict.ok) {
        filtered('speech', outcome.id, verdict.categories);
        return;
      }
      enqueue({
        kind: 'self_output',
        ref: outcome.id,
        account: null,
        sender: config.selfName,
        content,
      });
    };

    const danmaku = ctx.optional(DanmakuService);
    if (danmaku) ctx.register(danmaku.subscribe(onDanmaku));
    ctx.on(UtterancePlayed, onPlayed);
    ctx.register(
      safety.onControl((signal) => {
        if (signal.kind === 'mode' && signal.mode !== 'safe-stop' && waitingForMode) schedule(0);
      }),
    );
    ctx.register(() => {
      if (timer !== undefined) clock.clearTimeout(timer);
      timer = undefined;
    });
    // 上次没写完的（含重启前在途的）：激活后补发。
    if (ledger().outbox.length > 0) schedule(0);

    // ------------------------------------------------------------------ 人设

    /** 最近一次从 Iris 拿到的非空人设：召回或预检时更新，召回超时或失败时决策用这一份。 */
    let persona: MemoryPersona | undefined;
    const personaEntry = config.persona.entryId ?? entryId;

    /** 采用 Iris 给的人设：去掉首尾空白，为空视同没有拿到；超长截断。变了才记日志（不记正文）。 */
    const adoptPersona = (raw: IrisPersona | undefined): MemoryPersona | undefined => {
      const trimmed = raw?.content.trim() ?? '';
      if (!raw || trimmed === '') return undefined;
      const chars = [...trimmed];
      const truncated = chars.length > config.persona.maxChars;
      const next: MemoryPersona = {
        text: truncated ? chars.slice(0, config.persona.maxChars).join('') : trimmed,
        version: raw.version,
      };
      if (persona?.text !== next.text || persona.version !== next.version) {
        if (truncated) {
          ctx.log('memory.persona-truncated', {
            version: next.version,
            chars: chars.length,
            max: config.persona.maxChars,
          });
        }
        ctx.log('memory.persona', { version: next.version, chars: [...next.text].length });
      }
      persona = next;
      return next;
    };

    /** 只取人设、不取记忆的召回准备（截止时间 CHECK_TIMEOUT_MS）。 */
    const fetchPersona = async (): Promise<MemoryPersona | undefined> => {
      const deadline = new AbortController();
      const handle = clock.setTimeout(
        () => deadline.abort(new DeadlineError('取人设超时')),
        CHECK_TIMEOUT_MS,
      );
      try {
        const result = await iris.prepare(
          personaEntry,
          { text: '', judge: false, memoryLimit: 0, tokenBudget: 0 },
          AbortSignal.any([deadline.signal, ctx.signal]),
        );
        return adoptPersona(result.persona);
      } catch (error) {
        if (deadline.signal.aborted) {
          throw new IrisError('timeout', `取人设未在 ${CHECK_TIMEOUT_MS}ms 内完成`);
        }
        throw error;
      } finally {
        clock.clearTimeout(handle);
      }
    };

    // 激活时先取一次，第一次决策就能用上 Iris 的人设；取不到时决策先用 profile 的。
    void fetchPersona().then(
      (found) => {
        if (!found) ctx.log('memory.persona-missing', {});
      },
      (error: unknown) => {
        if (!ctx.signal.aborted) {
          ctx.log('memory.persona-failed', {
            kind: error instanceof IrisError ? error.kind : 'error',
          });
        }
      },
    );

    // ------------------------------------------------------------------ 召回

    /** 最近的召回：本地编号到 Iris 记忆 ID，Iris 是否给出了记忆，是否已回报。 */
    const recalls = new Map<string, { ids: Map<string, number>; total: number; sent: boolean }>();

    /** 记忆提到了有墓碑的观众：说话人、涉及的人或正文里有他的代号（或平台 ID 本身）。 */
    const mentionsTombstoned = (memory: IrisMemory, tombstones: readonly string[]) => {
      if (tombstones.length === 0) return false;
      const haystacks = [
        memory.content,
        memory.speakerName ?? '',
        ...memory.about.map((person) => person.name),
      ].map((text) => text.toLowerCase());
      return tombstones.some((account) => {
        const code = pseudonymCode(account);
        const raw = account.toLowerCase();
        return haystacks.some((text) => text.includes(code) || text.includes(raw));
      });
    };

    /** 只用直播间入口内的：来源都在本入口（来源入口在令牌范围外时为 null，同样不用）。 */
    const inScope = (memory: IrisMemory) =>
      memory.sources.length > 0 && memory.sources.every((source) => source.entryId === entryId);

    const service: Memory = {
      async recall(request, signal) {
        const startedAt = clock.now();
        const span = tracer.startSpan('memory.recall', {
          kind: 'client',
          parent: request.traceparent,
          attributes: { 'bellis.memory.judge': config.recall.judge },
        });
        const finish = (outcome: string, errorType?: string) => {
          span.setAttributes({ 'bellis.memory.outcome': outcome });
          if (errorType !== undefined) span.fail(errorType);
          tracer.record(
            Metric.MemoryRecallDuration,
            (clock.now() - startedAt) / 1000,
            's',
            { 'bellis.memory.outcome': outcome, [ErrorType]: errorType },
            span,
          );
          span.end();
        };
        if (ctx.signal.aborted) {
          finish('unavailable', 'unavailable');
          return { ok: false, kind: 'unavailable', detail: '记忆插件停用' };
        }
        let result: Awaited<ReturnType<typeof iris.prepare>>;
        try {
          result = await iris.prepare(
            entryId,
            {
              ...(request.text === undefined ? {} : { text: request.text }),
              judge: config.recall.judge,
              ...(config.recall.judge && config.recall.judgeBudgetSeconds !== undefined
                ? { judgeBudgetSeconds: config.recall.judgeBudgetSeconds }
                : {}),
              memoryLimit: config.recall.memoryLimit,
              tokenBudget: config.recall.tokenBudget,
            },
            AbortSignal.any([signal, ctx.signal]),
          );
        } catch (error) {
          if (signal.aborted && signal.reason instanceof DeadlineError) {
            finish('timeout', 'timeout');
            return { ok: false, kind: 'timeout', detail: '召回未在截止时间内完成' };
          }
          if (signal.aborted || ctx.signal.aborted) {
            finish('aborted', 'aborted');
            return { ok: false, kind: 'aborted', detail: '召回已取消' };
          }
          const kind = error instanceof IrisError ? error.kind : 'error';
          finish('error', kind);
          ctx.log('memory.recall-failed', { kind });
          return { ok: false, kind: 'error', detail: describe(error) };
        }
        adoptPersona(result.persona);
        const tombstones = ledger().tombstones;
        const counts = { scope: 0, tombstone: 0, privacy: 0, injection: 0 };
        const kept: Array<RecalledMemory & { irisId: number }> = [];
        for (const found of result.memories) {
          if (!inScope(found)) {
            counts.scope += 1;
            continue;
          }
          if (mentionsTombstoned(found, tombstones)) {
            counts.tombstone += 1;
            continue;
          }
          if (!gateway.check(found.content).ok) {
            counts.privacy += 1;
            continue;
          }
          const text = cleanText(found.content, config.recall.maxChars);
          if (text === '') continue;
          if (config.skipInjection && looksLikeInjection(text)) {
            counts.injection += 1;
            continue;
          }
          kept.push({
            id: `m${kept.length + 1}`,
            text,
            kind: found.kind ?? null,
            stance: found.stance ?? null,
            irisId: found.id,
          });
        }
        recalls.set(result.recallId, {
          ids: new Map(kept.map((m) => [m.id, m.irisId])),
          total: result.memories.length,
          sent: false,
        });
        while (recalls.size > RECALLS_KEPT) {
          const oldest = recalls.keys().next().value;
          if (oldest === undefined) break;
          recalls.delete(oldest);
        }
        span.setAttributes({
          'bellis.memory.recalled': result.memories.length,
          'bellis.memory.kept': kept.length,
          'bellis.memory.filtered_scope': counts.scope,
          'bellis.memory.filtered_tombstone': counts.tombstone,
          'bellis.memory.filtered_privacy': counts.privacy,
          'bellis.memory.filtered_injection': counts.injection,
        });
        finish('ok');
        trace?.record('memory.recalled', {
          recallId: result.recallId,
          irisIds: kept.map((m) => m.irisId),
        });
        return {
          ok: true,
          recall: {
            recallId: result.recallId,
            memories: kept.map(({ irisId: _irisId, ...m }) => m),
          },
        };
      },

      feedback(recallId, used) {
        const entry = recalls.get(recallId);
        if (!entry || entry.sent || ctx.signal.aborted) return;
        entry.sent = true;
        // Iris 没有给出记忆：没有可回报的。
        if (entry.total === 0) return;
        const ids = [...new Set(used)]
          .map((local) => entry.ids.get(local))
          .filter((id): id is number => id !== undefined);
        const unknown = new Set(used).size - ids.length;
        if (unknown > 0) ctx.log('memory.feedback-unknown', { count: unknown });
        trace?.record('memory.feedback', { recallId, irisIds: ids });
        void iris.feedback(recallId, ids, ctx.signal).then(
          () => ctx.log('memory.feedback', { used: ids.length }),
          (error: unknown) => ctx.log('memory.feedback-failed', { error: describe(error) }),
        );
      },

      async check() {
        const deadline = new AbortController();
        const handle = clock.setTimeout(
          () => deadline.abort(new DeadlineError('访问 Iris 超时')),
          CHECK_TIMEOUT_MS,
        );
        try {
          const status = await iris.check(AbortSignal.any([deadline.signal, ctx.signal]));
          if (status.service !== 'ready') throw new Error(`Iris 的服务状态为 ${status.service}`);
        } catch (error) {
          if (deadline.signal.aborted) {
            throw new IrisError('timeout', `访问 Iris 未在 ${CHECK_TIMEOUT_MS}ms 内完成`);
          }
          throw error;
        } finally {
          clock.clearTimeout(handle);
        }
      },

      get persona() {
        return persona;
      },

      currentPersona: () => fetchPersona(),

      get report() {
        const state = ledger();
        const notes: string[] = [];
        if (state.outbox.length > 0 && (waitingForMode || safety.mode === 'safe-stop')) {
          notes.push('安全停止中，写入暂停');
        } else if (retryAt !== undefined && retryAt > clock.now()) {
          notes.push(`写入失败，约 ${Math.ceil((retryAt - clock.now()) / 1000)} 秒后重试`);
        }
        return {
          ready: iris.ready && !ctx.signal.aborted,
          status: [iris.status, ...notes].join('；'),
          pending: state.outbox.length,
          written: state.written,
          dropped: state.dropped,
          tombstones: state.tombstones.length,
        };
      },
    };
    ctx.provide(MemoryService, service);
  },
});
