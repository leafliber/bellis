import {
  type Candidate,
  CandidatesService,
  VoteEnded,
  type VoteEndedNotice,
  VoteService,
} from '@bellis/audience';
import {
  ClockService,
  DeadlineError,
  definePlugin,
  defineService,
  type TimerHandle,
  TraceService,
  withDeadline,
} from '@bellis/kernel';
import { type Memory, type MemoryRecall, MemoryService, type RecallResult } from '@bellis/memory';
import { SafetyService } from '@bellis/safety';
import { type SpeechRequest, SpeechService, type UtteranceOutcome } from '@bellis/speech';
import {
  ErrorType,
  GenAi,
  Metric,
  type Span,
  TelemetryService,
  type TraceRef,
  traceRef,
  useTracer,
} from '@bellis/telemetry';
import Type, { type Static } from 'typebox';
import { DEFAULT_DRIFT_PHRASES, type DriftSignal, driftSignals } from './drift.ts';
import { type Llm, LlmError, type LlmModel, type LlmRequest, LlmService } from './llm.ts';
import { MAX_SPEAK_TEXT, parseIntent, type VoteAction } from './output.ts';
import { choosePersona } from './persona.ts';
import {
  buildMessages,
  type DecisionTrigger,
  type DirectorContext,
  type EndedVoteContext,
  INTENT_OUTPUT,
  type VoteContext,
} from './prompt.ts';
import { IntentScanner, type ScanEvent, TextQueue } from './stream.ts';

const UNKNOWN_MODEL: LlmModel = { provider: 'unknown', name: 'unknown' };

/** 决策时机的先后（合并后按这个顺序写进上下文）。 */
const TRIGGER_ORDER: readonly DecisionTrigger[] = ['vote-ended', 'candidates', 'idle'];

export const DirectorConfig = Type.Object({
  /** 人设与核心价值（操作员管理），放进提示词的系统部分。 */
  persona: Type.String({ default: '' }),
  maxCandidates: Type.Integer({ minimum: 1, default: 5 }),
  /** 上下文里放观众实际听到的近期发言的条数（最近的若干条，跳过没有人听到的）。 */
  heardLimit: Type.Integer({ minimum: 0, default: 8 }),
  /** 一次调用的截止时间（含思考与全部输出），到点即取消。 */
  callTimeoutMs: Type.Integer({ minimum: 1, default: 8_000 }),
  /**
   * 增量解析：模型流式输出时边到边扫描，说话的文本一开始（满足开口条件时）就交给发声，流读完再整段校验
   * （见决策模型“解析”）。关掉时整段解析，用于真机对照与回退。
   */
  streamOutput: Type.Boolean({ default: true }),
  /**
   * 召回记忆的截止时间（记忆插件在场时，在调用模型之前召回）：到点就不带记忆继续决策，不计入 `callTimeoutMs`。
   */
  recallTimeoutMs: Type.Integer({ minimum: 1, default: 2_000 }),
  /** 召回的查询提示至多这么多字（候选弹幕的净化文本、投票题目）。 */
  recallQueryChars: Type.Integer({ minimum: 1, maximum: 8_000, default: 500 }),
  replyTtlMs: Type.Integer({ minimum: 1, default: 20_000 }),
  /** 冷场多久后自主发言；0 表示不闲聊。 */
  idleMs: Type.Integer({ minimum: 0, default: 0 }),
  /** 连续失败（超时、出错、非法输出）每满这么多次：告警并请求安全核降级。 */
  alarmAfter: Type.Integer({ minimum: 1, default: 3 }),
  /** 固定过渡语：模型超时或出错、而这次有观众在等回应时播一句（每串连续失败至多一句，轮流取用）。 */
  fallback: Type.Object(
    {
      lines: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { default: [] }),
      ttlMs: Type.Integer({ minimum: 1, default: 5_000 }),
    },
    { default: {} },
  ),
  /** 人设漂移信号（见 drift.ts）。 */
  drift: Type.Object(
    {
      phrases: Type.Array(Type.String({ minLength: 1 }), { default: [...DEFAULT_DRIFT_PHRASES] }),
      similarity: Type.Number({ minimum: 0, maximum: 1, default: 0.8 }),
      /** 与最近多少段发言比较（观众听到的与本插件最近交给发声的各取这么多）。 */
      recent: Type.Integer({ minimum: 0, default: 8 }),
      maxChars: Type.Integer({ minimum: 1, default: 120 }),
      /** 有输出的决策连续命中信号每满这么多次：告警并请求安全核降级（内容重复或漂移）。 */
      alarmAfter: Type.Integer({ minimum: 1, default: 3 }),
    },
    { default: {} },
  ),
});
export type DirectorConfig = Static<typeof DirectorConfig>;

/** 调用失败的类别（写进遥测的 `error.type`）：模型客户端给的类别，或本插件判定的。 */
function failureKind(error: unknown): string {
  if (error instanceof LlmError) return error.kind;
  if (error instanceof DeadlineError) return 'timeout';
  return 'call_failed';
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const lastOf = <T>(list: readonly T[], n: number): T[] => (n <= 0 ? [] : list.slice(-n));

/** 被取消的调用（更高优先级的时机到来，或插件停用）。 */
class Cancelled extends Error {}

/** 增量开口的发言：交给发声的文本流、回应对象，以及已经扫到的文本（最终校验时与整段解析的结果比较）。 */
interface OpenedSpeech {
  queue: TextQueue;
  replyTo: string | undefined;
  text: string;
  /** `text` 的码点数。 */
  chars: number;
  outcome: Promise<UtteranceOutcome>;
}

/**
 * 决策模型（普通插件）：在决策时机到来时组装上下文、调用模型、把输出解析成枚举的意图（见决策模型）。
 *
 * - 时机：新一批候选到达、冷场计时到期、投票正常结束（扩展点 `vote.ended`）。同时只有一个在途调用：
 *   在途的是不带候选与投票结果、还没开口的闲聊调用时，新到的候选或投票结束取消它并立即重来；否则新时机排队，
 *   排队的时机在在途调用结束后合并成一次调用；在途时冷场计时到期不另排。每次调用都有截止时间。
 * - 提示词由确定性代码组装（prompt.ts）：观众内容只在不可信数据区里；输出各种方式共用 `parseIntent` 解析与校验，
 *   非法输出丢弃，不修补。
 * - 增量解析（`streamOutput`，见 stream.ts）：流式客户端报来正文增量时边到边扫描，说话的文本一开始、动作与回应对象
 *   都已确定且回应对象在本次上下文里，就把文本流交给发声（开口）；开口之后这次调用不再可被取消。流读完仍由
 *   `parseIntent` 整段校验，与已送出的一致才让文本流正常结束，否则文本流以错误结束、算一次非法输出；
 *   模型出错、超时或插件停用时文本流同样以错误结束。投票与沉默不提前开口。
 * - 失败：超时或出错时放弃本次时机，有观众在等回应、且还没开口时可播一句固定过渡语；连续失败每满 `alarmAfter`
 *   次告警（事实 `director.alarmed`）并请求安全核降级。人设漂移信号连续命中同样处理。
 * - 发起投票交给投票插件（可选依赖，不在场时只记日志）；游戏目标在后续阶段接入。
 * - 记忆插件（`memory@1`，可选依赖）在场时，调用模型之前召回，截止时间 `recallTimeoutMs`，到点、出错都不带记忆
 *   继续；记忆只放进不可信数据区。决策后回报使用反馈：意图里写的、这次召回给出的编号，没有用到就是空集。
 *
 * 遥测（见运维“观测”）：一次模型调用一个 GenAI span（`chat <型号>`，父为排第一的候选，其余候选以 links
 * 关联），记 `gen_ai.client.inference.duration`；模型客户端报来用量时 token 数记在 span 上，流式客户端报来
 * 第一块时记 `gen_ai.client.inference.time_to_first_chunk`、第一个正文块时记 `bellis.llm.time_to_first_output`；
 * span 上记是否开口（`bellis.director.streamed`），开口的时刻记事件 `bellis.director.speech_started`。
 * 回应弹幕的发言以被回应的候选为父、以 link 关联这次调用，带上链路起点；闲聊与开票说明以这次调用为父。
 * 不记上下文与模型输出。
 */
export const director = definePlugin({
  manifest: {
    id: 'director',
    version: '0.3.0',
    tier: 'ordinary',
    provides: [],
    inject: [
      LlmService.ref,
      SpeechService.ref,
      CandidatesService.ref,
      ClockService.ref,
      SafetyService.ref,
      `${VoteService.ref}?`,
      `${MemoryService.ref}?`,
      `${TelemetryService.ref}?`,
    ],
    permissions: [],
    process: 'in-process',
    config: DirectorConfig,
  },
  activate(ctx) {
    const llm = ctx.service(LlmService);
    const speech = ctx.service(SpeechService);
    const candidates = ctx.service(CandidatesService);
    const clock = ctx.service(ClockService);
    const safety = ctx.service(SafetyService);
    const tracer = useTracer(ctx, 'director');
    const config = ctx.config;

    /** 排队的决策时机：在途调用结束后合并成一次调用。 */
    const pending = new Set<DecisionTrigger>();
    /** 刚结束、还没交给模型的投票。 */
    let endedVote: EndedVoteContext | undefined;
    /** 在途的调用：还没开口的闲聊调用可以被新到的候选或投票结束取消。 */
    let inflight: { cancellable: boolean; cancel(by: string): void } | undefined;
    let running = false;
    let failures = 0;
    /** 这一串连续失败里是否已播过过渡语。 */
    let fallbackPlayed = false;
    let fallbacks = 0;
    let driftStreak = 0;
    let calls = 0;
    /** 本插件最近交给发声的文本（漂移的重复检测用）。 */
    const outputs: string[] = [];
    let idleTimer: TimerHandle | undefined;

    /** 回应弹幕的发言以被回应的候选为父（链路起点不变），以 link 关联这次模型调用；其余以模型调用为父。 */
    const speechTrace = (call: Span, target: Candidate | undefined): TraceRef | undefined => {
      if (!target?.trace) return traceRef(call);
      const { traceparent, originAt } = target.trace;
      return {
        traceparent,
        ...(originAt === undefined ? {} : { originAt }),
        ...(call.traceparent ? { links: [call.traceparent] } : {}),
      };
    };

    const voteContext = (): VoteContext | null => {
      const status = ctx.optional(VoteService)?.current();
      if (!status) return null;
      return {
        phase: status.phase,
        question: status.question,
        options: status.options.map((text, i) => ({
          number: i + 1,
          text,
          votes: status.counts[i] ?? 0,
        })),
        remainingSec: status.remainingMs === null ? null : Math.ceil(status.remainingMs / 1000),
      };
    };

    /** 上一次用的人设的来源与版本：变了才记日志（不记正文）。 */
    let lastPersona: string | undefined;

    /**
     * 这次决策用的人设（见决策模型“人设”）：记忆插件拿到过 Iris 的人设就用最近一次的，否则用 profile 的。
     * 在召回之后选，这次召回带回的新版本立即生效。
     */
    const persona = () => {
      const chosen = choosePersona(ctx.optional(MemoryService), config.persona);
      const key = `${chosen.source}:${chosen.version}`;
      if (key !== lastPersona) {
        lastPersona = key;
        ctx.log('director.persona', { source: chosen.source, version: chosen.version });
      }
      return chosen;
    };

    const context = (
      triggers: DecisionTrigger[],
      taken: Candidate[],
      ended: EndedVoteContext | undefined,
      recall: MemoryRecall | undefined,
    ): DirectorContext => {
      const chosen = persona();
      return {
        persona: chosen.text,
        ...(chosen.source === 'iris'
          ? { personaSource: { from: 'iris' as const, version: chosen.version } }
          : {}),
        triggers,
        heard: lastOf(
          speech
            .heard()
            .map((utterance) => utterance.heard)
            .filter((text) => text !== ''),
          config.heardLimit,
        ),
        candidates: taken.map((c) => ({ id: c.id, name: c.name, text: c.text, count: c.count })),
        vote: voteContext(),
        endedVote: ended ?? null,
        memories: (recall?.memories ?? []).map((m) => ({ ...m })),
      };
    };

    /** 召回的查询提示：候选弹幕的净化文本与刚结束的投票题目；都没有（冷场）时省略，由 Iris 自己构造。 */
    const recallQuery = (taken: Candidate[], ended: EndedVoteContext | undefined) => {
      const parts = [...taken.map((c) => c.text), ...(ended ? [ended.question] : [])];
      const text = [...parts.join('\n')].slice(0, config.recallQueryChars).join('');
      return text === '' ? undefined : text;
    };

    /**
     * 召回记忆：带截止时间（`recallTimeoutMs`），到点、出错或记忆插件不在场都不带记忆继续。
     * 被取消（`cancelled` 拒绝）时抛出 {@link Cancelled}。
     */
    const recallMemories = async (
      query: string | undefined,
      call: Span,
      signal: AbortSignal,
      cancelled: Promise<never>,
    ): Promise<{ recall: MemoryRecall; memory: Memory } | undefined> => {
      const memory = ctx.optional(MemoryService);
      if (!memory) return undefined;
      const deadline = new AbortController();
      const reason = new DeadlineError(`召回未在 ${config.recallTimeoutMs}ms 内完成`);
      const timer = clock.setTimeout(() => deadline.abort(reason), config.recallTimeoutMs);
      // 记忆插件没有及时响应中止信号也照样到点就走。
      const expired = new Promise<RecallResult>((resolve) =>
        deadline.signal.addEventListener(
          'abort',
          () => resolve({ ok: false, kind: 'timeout', detail: reason.message }),
          { once: true },
        ),
      );
      try {
        const result = await Promise.race([
          memory
            .recall(
              {
                ...(query === undefined ? {} : { text: query }),
                ...(call.traceparent ? { traceparent: call.traceparent } : {}),
              },
              AbortSignal.any([deadline.signal, signal]),
            )
            .catch(
              (error: unknown): RecallResult => ({
                ok: false,
                kind: 'error',
                detail: message(error),
              }),
            ),
          expired,
          cancelled,
        ]);
        if (result.ok) {
          call.setAttributes({ 'bellis.director.memories': result.recall.memories.length });
          return { recall: result.recall, memory };
        }
        call.setAttributes({ 'bellis.director.recall': result.kind });
        ctx.log('director.recall-skipped', { kind: result.kind });
        return undefined;
      } finally {
        clock.clearTimeout(timer);
      }
    };

    /** 使用反馈：只回报本次召回给出的编号，其余忽略（记日志）。 */
    const usedMemories = (
      recall: MemoryRecall | undefined,
      used: readonly string[] | undefined,
    ) => {
      if (!recall || !used) return [];
      const given = new Set(recall.memories.map((m) => m.id));
      const known = [...new Set(used)].filter((id) => given.has(id));
      if (known.length < new Set(used).size) {
        ctx.log('director.memory-unknown', { count: new Set(used).size - known.length });
      }
      return known;
    };

    /** 告警（事实 `director.alarmed`，进操作台的近期告警）并请求安全核降级。 */
    const alarm = (cause: 'failures' | 'drift', count: number, detail: string) => {
      safety.record('director.alarmed', { cause, count, detail });
      const reason =
        cause === 'failures'
          ? `决策模型连续失败 ${count} 次（最近一次：${detail}）`
          : `决策输出连续 ${count} 次重复或漂移（${detail}）`;
      const mode = safety.requestDowngrade(reason);
      ctx.log('director.alarm', { cause, count, detail, mode });
    };

    /** 固定过渡语：每串连续失败至多一句，轮流取用。文本来自 profile，不含不可信输入。 */
    const playFallback = (call: Span) => {
      const { lines, ttlMs } = config.fallback;
      if (lines.length === 0 || fallbackPlayed) return;
      fallbackPlayed = true;
      const index = fallbacks % lines.length;
      fallbacks += 1;
      const trace = traceRef(call);
      ctx.log('director.fallback', { index });
      void speech.request({
        id: `director:${ctx.instanceId}:fallback:${fallbacks}`,
        source: 'chatter',
        text: lines[index] as string,
        expiresAt: clock.now() + ttlMs,
        preempt: 'immediate',
        inputs: [],
        untrusted: false,
        ...(trace ? { trace } : {}),
      });
    };

    /** 一次失败：超时、出错、非法输出、回应对象不在上下文中。 */
    const failed = (kind: string, reason: string, call: Span, waiting: boolean) => {
      failures += 1;
      ctx.log('director.output-dropped', { kind, reason, failures });
      // 超时与出错才播过渡语：非法输出照常丢弃，不当作“还在想”。
      const callFailed = kind !== 'invalid_output' && kind !== 'unknown_target';
      if (callFailed && waiting) playFallback(call);
      if (failures % config.alarmAfter === 0) alarm('failures', failures, kind);
    };

    const succeeded = () => {
      failures = 0;
      fallbackPlayed = false;
    };

    /** 漂移信号：命中时写日志、记在 span 上；有输出的决策连续命中每满阈值告警并请求降级。 */
    const noteDrift = (signals: DriftSignal[], call: Span) => {
      if (signals.length === 0) {
        driftStreak = 0;
        return;
      }
      driftStreak += 1;
      const joined = signals.join(',');
      call.setAttributes({ 'bellis.director.drift': joined });
      ctx.log('director.drift', { signals, streak: driftStreak });
      if (driftStreak % config.drift.alarmAfter === 0) alarm('drift', driftStreak, joined);
    };

    const recentTexts = () => [
      ...lastOf(
        speech
          .heard()
          .map((utterance) => utterance.heard)
          .filter((text) => text !== ''),
        config.drift.recent,
      ),
      ...lastOf(outputs, config.drift.recent),
    ];

    /** 记下交给发声的文本（漂移的重复检测用）。 */
    const remember = (text: string) => {
      outputs.push(text);
      if (outputs.length > config.drift.recent) outputs.shift();
    };

    /**
     * 把说话意图交给发声（整段解析与增量开口共用）：来源、可抢占点与输入按回应对象定，模型不能指定（D-33）；
     * 文本可以是流。
     */
    const say = (
      text: SpeechRequest['text'],
      target: Candidate | undefined,
      call: Span,
      untrusted: boolean,
    ): Promise<UtteranceOutcome> => {
      calls += 1;
      const trace = speechTrace(call, target);
      return speech.request({
        id: `director:${ctx.instanceId}:${calls}`,
        source: target ? 'danmaku-reply' : 'chatter',
        text,
        expiresAt: clock.now() + config.replyTtlMs,
        // 回应观众时在句边界才能被抢占；自主闲聊可以立即让位。
        preempt: target ? 'sentence' : 'immediate',
        inputs: target ? target.sources : [],
        untrusted,
        ...(trace ? { trace } : {}),
      });
    };

    /**
     * 发起投票：交给投票插件（`vote@1`），规则、计票与口播都在那里；优先级与发声来源也由那里的确定性代码决定，
     * 模型不能指定（D-33）。成功、被拒都记日志，不写题目与选项（模型输出可能复述弹幕）。
     */
    const startVote = (
      action: VoteAction,
      taken: Candidate[],
      id: string,
      trace: TraceRef | undefined,
      untrusted: boolean,
      started: (ok: boolean) => void,
    ) => {
      const votes = ctx.optional(VoteService);
      if (!votes) {
        ctx.log('director.vote-unavailable', { id, reason: '投票插件不在场' });
        started(false);
        return;
      }
      void votes
        .start({
          id,
          question: action.question,
          options: action.options,
          durationSec: action.durationSec,
          ...(action.decisionPoint === undefined ? {} : { decisionPoint: action.decisionPoint }),
          inputs: taken.flatMap((c) => c.sources),
          untrusted,
          ...(trace ? { trace } : {}),
        })
        .then((result) => {
          if (result.ok) ctx.log('director.vote-started', { id, voteId: result.voteId });
          else ctx.log('director.vote-refused', { id, reason: result.reason });
          started(result.ok);
        });
    };

    /** 一次决策：取候选、组装上下文、调用模型（可被取消）、解析并交出意图。 */
    const decide = async (triggers: DecisionTrigger[]) => {
      const taken = candidates.take(config.maxCandidates);
      const ended = endedVote;
      endedVote = undefined;
      // 写进上下文的时机只留实际带来了数据的；都没有时按冷场。
      const effective = triggers.filter(
        (t) =>
          (t !== 'candidates' || taken.length > 0) && (t !== 'vote-ended' || ended !== undefined),
      );
      const reasons: DecisionTrigger[] = effective.length > 0 ? effective : ['idle'];
      const model = llm.model ?? UNKNOWN_MODEL;
      const call = tracer.startSpan(`chat ${model.name}`, {
        kind: 'client',
        parent: taken[0]?.trace,
        links: taken.slice(1).map((c) => c.trace),
        attributes: {
          [GenAi.OperationName]: 'chat',
          [GenAi.ProviderName]: model.provider,
          [GenAi.RequestModel]: model.name,
          'bellis.director.candidates': taken.length,
          'bellis.director.trigger': reasons.join(','),
        },
      });
      /** 增量开口之后交给发声的文本流与已送出的文本（见下文 `open`）。 */
      let opened: OpenedSpeech | undefined;
      /** 结束这次调用的 span：记是否开口；出错时带上类别（不带模型输出）。 */
      const endCall = (errorType?: string) => {
        call.setAttributes({ 'bellis.director.streamed': opened !== undefined });
        if (errorType) call.fail(errorType);
        call.end();
      };
      const controller = new AbortController();
      let cancelledBy: string | undefined;
      // 取消时不等客户端收尾：客户端没有及时响应中止信号也照样结束这次调用。
      const cancelled = new Promise<never>((_, reject) =>
        controller.signal.addEventListener('abort', () => reject(new Cancelled()), { once: true }),
      );
      cancelled.catch(() => {});
      const current = {
        // 不带候选与投票结果的调用（闲聊）可以被新到的候选或投票结束取消，开口之后不再可以。
        cancellable: taken.length === 0 && ended === undefined,
        cancel: (by: string) => {
          cancelledBy ??= by;
          controller.abort();
        },
      };
      inflight = current;
      // 召回记忆（记忆插件在场时）：有截止时间，到点就不带记忆继续；被取消时这次时机结束。
      let recalled: { recall: MemoryRecall; memory: Memory } | undefined;
      try {
        recalled = await recallMemories(
          recallQuery(taken, ended),
          call,
          controller.signal,
          cancelled,
        );
      } catch (error) {
        if (!(error instanceof Cancelled)) throw error;
        inflight = undefined;
        endCall('cancelled');
        ctx.log('director.cancelled', { by: cancelledBy });
        return;
      }
      const recall = recalled?.recall;
      // 上下文里有弹幕或记忆，输出就受不可信输入影响。
      const untrusted = taken.length > 0 || (recall?.memories.length ?? 0) > 0;
      /**
       * 使用反馈：每次召回恰好回报一次。说话等发言结果（观众一个字也没听到就回报空集），发起投票等开票结果；
       * 失败、取消、沉默与非法输出（含开口之后最终校验不通过）回报空集。
       */
      let reported = false;
      const report = (used: readonly string[]) => {
        if (!recall || reported) return;
        reported = true;
        try {
          // 用召回时的那个记忆服务：之后它被替换或停用，回报就落空（由它自己核对）。
          recalled?.memory.feedback(recall.recallId, used);
        } catch (error) {
          ctx.log('director.feedback-failed', { error: message(error) });
        }
      };
      const startedAt = clock.now();
      /** 调用已有结果（含超时与取消）：之后客户端再报的用量与首块不记。 */
      let settled = false;
      let responseModel: string | undefined;
      /** 推理指标的属性：必填厂商，能拿到时加实际应答的型号，出错时加错误类别。 */
      const metricAttributes = (errorType?: string) => ({
        [GenAi.ProviderName]: model.provider,
        [GenAi.ResponseModel]: responseModel,
        [ErrorType]: errorType,
      });
      const recordDuration = (errorType?: string) =>
        tracer.record(
          GenAi.InferenceDuration,
          (clock.now() - startedAt) / 1000,
          's',
          metricAttributes(errorType),
          call,
        );
      /** 增量解析（`streamOutput` 时）：扫描流式客户端报来的正文增量。 */
      const scanner = config.streamOutput ? new IntentScanner() : undefined;
      /**
       * 说话的文本开始时决定是否开口：动作已确定为说话，回应对象已在文本之前出现（字符串或 null），是字符串时
       * 在本次上下文里。任一不满足就不提前开口，留给整段解析（判定与现在相同）。
       */
      const open = ({ action, replyTo }: Extract<ScanEvent, { type: 'text-start' }>) => {
        if (action?.kind !== 'string' || action.value !== 'speak') return;
        if (replyTo === undefined || replyTo.kind === 'other') return;
        const target =
          replyTo.kind === 'string' ? taken.find((c) => c.id === replyTo.value) : undefined;
        if (replyTo.kind === 'string' && !target) return;
        // 观众开始听到这段话之后，这次调用不再被新的时机取消。
        current.cancellable = false;
        call.addEvent('bellis.director.speech_started');
        const queue = new TextQueue();
        opened = {
          queue,
          replyTo: target?.id,
          text: '',
          chars: 0,
          outcome: say(queue, target, call, untrusted),
        };
      };
      /** 文本的增量：记下并送进文本流；超过说话文本的上限时文本流以错误结束（最终校验也不会通过）。 */
      const feed = (spoken: OpenedSpeech, delta: string) => {
        spoken.text += delta;
        spoken.chars += [...delta].length;
        if (spoken.chars > MAX_SPEAK_TEXT) {
          spoken.queue.fail(new Error(`说话的文本超过 ${MAX_SPEAK_TEXT} 字`));
        } else {
          spoken.queue.push(delta);
        }
      };
      const onOutput = (delta: string) => {
        if (settled || !scanner) return;
        for (const event of scanner.push(delta)) {
          if (event.type === 'text-start') open(event);
          else if (event.type === 'text' && opened) feed(opened, event.delta);
        }
      };
      const contextValue = context(reasons, taken, ended, recall);
      const request: LlmRequest = {
        messages: buildMessages(contextValue),
        output: INTENT_OUTPUT,
        context: contextValue,
        ...(call.traceparent ? { traceparent: call.traceparent } : {}),
      };
      let output: string;
      try {
        output = await withDeadline(
          clock,
          Promise.race([
            completeWith(llm, request, controller.signal, {
              onUsage: (usage) => {
                if (settled) return;
                responseModel = usage.responseModel ?? responseModel;
                call.setAttributes({
                  [GenAi.UsageInputTokens]: usage.inputTokens,
                  [GenAi.UsageOutputTokens]: usage.outputTokens,
                  [GenAi.UsageReasoningOutputTokens]: usage.reasoningOutputTokens,
                  [GenAi.ResponseModel]: usage.responseModel,
                });
              },
              onFirstChunk: () => {
                if (settled) return;
                tracer.record(
                  GenAi.InferenceTimeToFirstChunk,
                  (clock.now() - startedAt) / 1000,
                  's',
                  metricAttributes(),
                  call,
                );
              },
              onFirstOutput: () => {
                if (settled) return;
                tracer.record(
                  Metric.LlmFirstOutput,
                  (clock.now() - startedAt) / 1000,
                  's',
                  metricAttributes(),
                  call,
                );
              },
              onOutput,
            }),
            cancelled,
          ]),
          config.callTimeoutMs,
          '决策模型调用',
        );
      } catch (error) {
        settled = true;
        inflight = undefined;
        // 截止时间到点：以 DeadlineError 作中止原因，模型客户端据此把这次调用记为超时（就绪判定用）。
        controller.abort(error instanceof DeadlineError ? error : undefined);
        report([]);
        const kind = cancelledBy !== undefined ? 'cancelled' : failureKind(error);
        // 已经开口：文本流以错误结束，仲裁不再开始后续的句子（说明里只有类别）。
        opened?.queue.fail(new Error(`决策模型调用没有完成：${kind}`));
        if (cancelledBy !== undefined) {
          recordDuration('cancelled');
          endCall('cancelled');
          ctx.log('director.cancelled', { by: cancelledBy });
          return;
        }
        recordDuration(kind);
        endCall(kind);
        // 已经开口时不播过渡语：观众已经听到了这次回应的开头。
        failed(kind, message(error), call, taken.length > 0 && opened === undefined);
        return;
      }
      settled = true;
      inflight = undefined;
      recordDuration();
      const parsed = parseIntent(output);
      if (opened) {
        // 开口之后的最终校验：整段合法、仍是说话、回应对象与文本都与已交给发声的完全相同，文本流才正常结束。
        const final = parsed.ok ? parsed.action : undefined;
        if (
          final?.action !== 'speak' ||
          final.replyTo !== opened.replyTo ||
          final.text !== opened.text
        ) {
          opened.queue.fail(new Error('模型输出没有通过最终校验'));
          report([]);
          endCall('invalid_output');
          failed(
            'invalid_output',
            parsed.ok ? '最终输出与已交给发声的回应对象或文本不一致' : parsed.reason,
            call,
            taken.length > 0,
          );
          return;
        }
        call.setAttributes({ 'bellis.director.action': final.action });
        const used = usedMemories(recall, final.memories);
        noteDrift(driftSignals(final.text, recentTexts(), config.drift), call);
        endCall();
        succeeded();
        remember(final.text);
        opened.queue.end();
        // 观众一个字也没听到：记忆没有用上。
        void opened.outcome.then((outcome) => report(outcome.heard === '' ? [] : used));
        return;
      }
      if (!parsed.ok) {
        report([]);
        endCall('invalid_output');
        failed('invalid_output', parsed.reason, call, taken.length > 0);
        return;
      }
      const action = parsed.action;
      call.setAttributes({ 'bellis.director.action': action.action });
      if (action.action === 'speak') {
        const target =
          action.replyTo === undefined ? undefined : taken.find((c) => c.id === action.replyTo);
        if (action.replyTo !== undefined && !target) {
          report([]);
          endCall('unknown_target');
          failed(
            'unknown_target',
            `回应对象 ${action.replyTo} 不在本次上下文中`,
            call,
            taken.length > 0,
          );
          return;
        }
        const used = usedMemories(recall, action.memories);
        noteDrift(driftSignals(action.text, recentTexts(), config.drift), call);
        endCall();
        succeeded();
        remember(action.text);
        void say(action.text, target, call, untrusted)
          // 观众一个字也没听到：记忆没有用上。
          .then((outcome) => report(outcome.heard === '' ? [] : used));
      } else if (action.action === 'vote') {
        // 题目与选项也要说出口：查出戏用语与格式（各段分别查，不查重复）。
        const signals = new Set<DriftSignal>();
        for (const piece of [action.question, ...action.options]) {
          for (const signal of driftSignals(piece, [], config.drift)) signals.add(signal);
        }
        const used = usedMemories(recall, action.memories);
        noteDrift([...signals], call);
        endCall();
        succeeded();
        calls += 1;
        startVote(
          action,
          taken,
          `director:${ctx.instanceId}:${calls}`,
          traceRef(call),
          untrusted,
          (ok) => report(ok ? used : []),
        );
      } else {
        report([]);
        endCall();
        succeeded();
        ctx.log('director.silence', { ...action });
      }
    };

    /** 依次处理排队的时机，每轮把排队的全部合并成一次调用。 */
    const run = async () => {
      running = true;
      try {
        while (pending.size > 0 && !ctx.signal.aborted) {
          const triggers = TRIGGER_ORDER.filter((t) => pending.has(t));
          pending.clear();
          try {
            await decide(triggers);
          } catch (error) {
            // 本插件自己的错误（不是模型调用的失败）：记下后继续处理后面的时机。
            inflight = undefined;
            ctx.log('director.decide-failed', { error: message(error) });
          }
        }
      } finally {
        running = false;
        armIdle();
      }
    };

    /**
     * 新的决策时机：没有在途调用就立即开始；在途时冷场到期不另排，其余排队，在途的是可取消的闲聊调用就取消它。
     */
    const trigger = (t: DecisionTrigger) => {
      if (ctx.signal.aborted) return;
      if (inflight) {
        if (t === 'idle') return;
        pending.add(t);
        if (inflight.cancellable) inflight.cancel(t);
        return;
      }
      pending.add(t);
      if (!running) void run();
    };

    const armIdle = () => {
      if (idleTimer) clock.clearTimeout(idleTimer);
      idleTimer = undefined;
      if (config.idleMs > 0 && !ctx.signal.aborted) {
        idleTimer = clock.setTimeout(() => trigger('idle'), config.idleMs);
      }
    };

    const onVoteEnded = (notice: VoteEndedNotice) => {
      endedVote = {
        question: notice.question,
        options: notice.options.map((text, i) => ({
          number: i + 1,
          text,
          votes: notice.counts[i] ?? 0,
        })),
        outcome: notice.outcome,
        winners: [...notice.winners],
      };
      trigger('vote-ended');
    };

    ctx.register(candidates.onAvailable(() => trigger('candidates')));
    ctx.on(VoteEnded, onVoteEnded);
    ctx.register(() => {
      if (idleTimer) clock.clearTimeout(idleTimer);
      inflight?.cancel('unload');
    });
    armIdle();
  },
});

/** 调用模型；客户端同步抛错也当作这次调用失败。 */
function completeWith(
  llm: Llm,
  request: LlmRequest,
  signal: AbortSignal,
  options: Parameters<Llm['complete']>[2],
): Promise<string> {
  try {
    return llm.complete(request, signal, options);
  } catch (error) {
    return Promise.reject(error);
  }
}

/** 回放的模型输出（P0 用）：按顺序返回录好的输出，并记下收到的请求以便检查。 */
export interface ReplayLlm extends Llm {
  readonly requests: readonly LlmRequest[];
}

export const ReplayLlmService = defineService<ReplayLlm>('llm-replay', 1);

/** 回放能模拟的失败：模型客户端的失败类别（见 {@link LlmErrorKind}），取消（`aborted`）除外。 */
const ReplayFailure = Type.Union([
  Type.Literal('auth'),
  Type.Literal('rate_limit'),
  Type.Literal('server'),
  Type.Literal('request'),
  Type.Literal('timeout'),
  Type.Literal('network'),
  Type.Literal('protocol'),
  Type.Literal('incomplete'),
]);

/**
 * 一次调用的回放：字符串是这次的输出（耗时 `latencyMs`）；`error` 让这次调用以这类失败结束；
 * `output` 加 `afterMs` 给出这次的耗时（超过决策插件的截止时间即超时），`ignoreAbort` 时不理会中止信号、
 * 到点照样给出输出，模拟没有及时响应中止的客户端；`stream` 按块回放，模拟流式客户端：`afterMs`（缺省
 * `latencyMs`）后送出第一块，之后每隔 `chunkMs` 一块，每块 `chunkChars` 个字符（码点），经 `onOutput` 送出
 * （第一块时也报首块与第一个正文块），送完之后给出整段输出；给了 `error` 时送完改以这类失败结束（流到一半出错）。
 */
const ReplayOutput = Type.Union([
  Type.String(),
  Type.Object({
    stream: Type.String(),
    chunkChars: Type.Integer({ minimum: 1 }),
    chunkMs: Type.Integer({ minimum: 0 }),
    afterMs: Type.Optional(Type.Integer({ minimum: 0 })),
    error: Type.Optional(ReplayFailure),
  }),
  Type.Object({
    error: ReplayFailure,
    afterMs: Type.Optional(Type.Integer({ minimum: 0 })),
  }),
  Type.Object({
    output: Type.String(),
    afterMs: Type.Integer({ minimum: 0 }),
    ignoreAbort: Type.Optional(Type.Boolean()),
  }),
]);
type ReplayOutput = Static<typeof ReplayOutput>;

/** 回放一次调用的计划：第一块（不分块时为结局）之前的耗时、依次送出的块与间隔，以及结局。 */
interface ReplayPlan {
  afterMs: number;
  chunks: string[];
  chunkMs: number;
  ending: { output: string; ignoreAbort: boolean } | { error: Static<typeof ReplayFailure> };
}

function replayPlan(item: ReplayOutput, latencyMs: number): ReplayPlan {
  if (typeof item === 'string') {
    return {
      afterMs: latencyMs,
      chunks: [],
      chunkMs: 0,
      ending: { output: item, ignoreAbort: false },
    };
  }
  if ('stream' in item) {
    const chars = [...item.stream];
    const chunks: string[] = [];
    for (let i = 0; i < chars.length; i += item.chunkChars) {
      chunks.push(chars.slice(i, i + item.chunkChars).join(''));
    }
    return {
      afterMs: item.afterMs ?? latencyMs,
      chunks,
      chunkMs: item.chunkMs,
      ending: item.error ? { error: item.error } : { output: item.stream, ignoreAbort: false },
    };
  }
  if ('error' in item) {
    return {
      afterMs: item.afterMs ?? latencyMs,
      chunks: [],
      chunkMs: 0,
      ending: { error: item.error },
    };
  }
  return {
    afterMs: item.afterMs,
    chunks: [],
    chunkMs: 0,
    ending: { output: item.output, ignoreAbort: item.ignoreAbort ?? false },
  };
}

/** 回调调用方：调用方自己出错不影响这次调用（与流式客户端相同）。 */
function notify(callback: () => void): void {
  try {
    callback();
  } catch {
    // 回调只用于遥测与增量解析。
  }
}

/**
 * 回放模型（仿真与测试用）。在仿真里把每次调用写进追踪（`llm.request`：调用序号与上下文里的候选编号；
 * 按块回放时每一块 `llm.chunk`（这一块的内容，先于交给调用方）；结局 `llm.output`、`llm.error`，以及先于结局到达的
 * 中止 `llm.aborted`，带是否因截止时间；失败给出之后、决策插件处理之前到达的取消带 `afterResult`），不变量据此
 * 独立推出每次调用对决策插件意味着什么。中止之后不再送出块。
 */
export const replayLlm = definePlugin({
  manifest: {
    id: 'llm-replay',
    version: '0.4.0',
    tier: 'ordinary',
    provides: [LlmService.ref, ReplayLlmService.ref],
    inject: [ClockService.ref, `${TraceService.ref}?`],
    permissions: [],
    process: 'in-process',
    config: Type.Object({
      outputs: Type.Array(ReplayOutput),
      /** 每次调用的模拟耗时（没有单独给出时）。 */
      latencyMs: Type.Integer({ minimum: 0, default: 0 }),
    }),
  },
  activate(ctx) {
    const clock = ctx.service(ClockService);
    const trace = ctx.optional(TraceService);
    const requests: LlmRequest[] = [];
    let next = 0;
    const replay: ReplayLlm = {
      // 遥测里填回放的标识，不冒充真实的厂商与型号。
      model: { provider: 'bellis.replay', name: 'replay' },
      // 回放没有要连接的端点：恒为就绪。
      ready: true,
      status: '回放',
      requests,
      complete(request, signal, options) {
        requests.push(structuredClone(request));
        const call = next;
        const item = ctx.config.outputs[call] ?? '{"action":"silence","reason":"回放结束"}';
        next += 1;
        trace?.record('llm.request', {
          call,
          candidates: request.context.candidates.map((c) => c.id),
        });
        const plan = replayPlan(item, ctx.config.latencyMs);
        const { ending } = plan;
        return new Promise((resolve, reject) => {
          let settled = false;
          /** 中止之后不再送出块（`ignoreAbort` 的输出照样到点给出）。 */
          let aborted = false;
          const onAbort = () => {
            if (settled) return;
            trace?.record('llm.aborted', {
              call,
              deadline: signal.reason instanceof DeadlineError,
            });
            aborted = true;
            if ('output' in ending && ending.ignoreAbort) return;
            settled = true;
            clock.clearTimeout(timer);
            reject(new LlmError('aborted', '已取消'));
          };
          let sent = 0;
          /** 送出下一块；送完（或不分块）时给出结局。 */
          const step = () => {
            const delta = plan.chunks[sent];
            if (delta !== undefined && !aborted) {
              sent += 1;
              trace?.record('llm.chunk', { call, delta });
              if (sent === 1) {
                notify(() => options?.onFirstChunk?.());
                notify(() => options?.onFirstOutput?.());
              }
              notify(() => options?.onOutput?.(delta));
              if (settled) return;
              if (sent < plan.chunks.length) {
                timer = clock.setTimeout(step, plan.chunkMs);
                return;
              }
            }
            finish();
          };
          const finish = () => {
            signal.removeEventListener('abort', onAbort);
            settled = true;
            if ('error' in ending) {
              trace?.record('llm.error', { call, kind: ending.error });
              reject(new LlmError(ending.error, `回放的失败：${ending.error}`));
              // 失败已经给出、决策插件还没处理（处理在微任务里）时，同一时刻别的定时器触发的取消先到：
              // 决策插件把这次调用当作取消。仿真里只有这种中止发生在任何微任务运行之前，记下它；
              // 决策插件处理失败时自己发的中止在微任务里，不记。
              let drained = false;
              queueMicrotask(() => {
                drained = true;
              });
              signal.addEventListener(
                'abort',
                () => {
                  if (!drained)
                    trace?.record('llm.aborted', { call, deadline: false, afterResult: true });
                },
                { once: true },
              );
            } else {
              trace?.record('llm.output', { call, output: ending.output });
              resolve(ending.output);
            }
          };
          let timer = clock.setTimeout(step, plan.afterMs);
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
        });
      },
    };
    ctx.provide(LlmService, replay);
    ctx.provide(ReplayLlmService, replay);
  },
});
