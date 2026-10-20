import {
  ClockService,
  defineExtension,
  definePlugin,
  defineService,
  type TimerHandle,
} from '@bellis/kernel';
import { SafetyService } from '@bellis/safety';
import { SpeechService, type UtteranceOutcome } from '@bellis/speech';
import type { Projection } from '@bellis/store';
import type { TraceRef } from '@bellis/telemetry';
import Type from 'typebox';
import {
  ballotKeys,
  decide,
  freezeRules,
  matchBallot,
  openingText,
  resultText,
  type VoteOutcome,
  type VoteRules,
} from './ballot.ts';
import { type Danmaku, DanmakuService } from './triage.ts';

/** 发起投票所需的能力（执行闸门）。不在 Rule of Two 的禁止清单里：来源含不可信输入也可以申请。 */
export const VOTE_START = 'vote.start';
/** 发起投票的意图目标：同时只有一个进行中的投票。 */
export const VOTE_TARGET = 'vote';

/** 投票的事实类型。 */
export const VoteFact = {
  /** 开票：冻结的规则（{@link VoteRules}）。 */
  Started: 'vote.started',
  /** 开票说明已完整播出，倒计时开始：截止时刻 = 这条事实的记录时刻 + 时长。 */
  Announced: 'vote.announced',
  /** 截止：各项票数、有效票、忽略的弹幕、平台缺口与结果。 */
  Ended: 'vote.ended',
  /** 中止：不出结果、不播报。 */
  Aborted: 'vote.aborted',
  /** 发起被拒（已有进行中的投票、参数不合法、执行闸门拒绝、重复发起）。 */
  Rejected: 'vote.rejected',
} as const;

/** 中止的原因类别。 */
export type AbortCause = 'opening' | 'stopped' | 'restart' | 'unloaded';

/** 发起投票的意图幂等键：同一次发起只开一次票（含跨重启）。 */
export function voteIntentKey(voteId: string): string {
  return `vote:${voteId}`;
}

/** 开票说明与结果播报的发声去重键：同一投票各只播一次。 */
export function voteSpeechId(voteId: string, part: 'opening' | 'result'): string {
  return `vote:${voteId}:${part}`;
}

export interface VoteRequest {
  /** 发起方给的编号，也是投票编号与幂等键的来源：同一编号只开一次票。 */
  id: string;
  question: string;
  options: readonly string[];
  durationSec: number;
  decisionPoint?: string;
  /** 产生这次发起的输入（例如候选弹幕编号），记进意图来源。 */
  inputs: readonly string[];
  /** 发起方的上下文里是否有不可信输入：题目与选项来自模型，开票说明据此标记。 */
  untrusted: boolean;
  /** 发起它的链路（例如模型调用的 span），开票说明的发言以它为父；没有遥测时不出现。 */
  trace?: TraceRef;
}

export type VoteStartResult = { ok: true; voteId: string } | { ok: false; reason: string };

/** 给操作员看的进行中的投票。 */
export interface VoteStatus {
  voteId: string;
  question: string;
  options: string[];
  counts: number[];
  valid: number;
  /** announcing：开票说明还没播完，倒计时没开始；open：倒计时中。 */
  phase: 'announcing' | 'open';
  durationMs: number;
  /** 倒计时剩余；还没开始时为 null。 */
  remainingMs: number | null;
  decisionPoint: string | null;
  /** 此刻弹幕接收是否在缺口中。 */
  gap: boolean;
}

export interface Votes {
  /** 发起投票：同时最多一个；经执行闸门授权，规则在这时冻结。被拒时返回原因并记 `vote.rejected`。 */
  start(request: VoteRequest): Promise<VoteStartResult>;
  /** 进行中的投票；没有时为 undefined。 */
  current(): VoteStatus | undefined;
}

export const VoteService = defineService<Votes>('vote', 1);

/** 投票正常结束的通知：题目与选项来自模型（受不可信输入影响），只当数据用。 */
export interface VoteEndedNotice {
  voteId: string;
  question: string;
  options: string[];
  /** 按选项顺序的票数。 */
  counts: number[];
  valid: number;
  outcome: VoteOutcome;
  /** 胜出（或并列最多）的选项编号，从 1 起。 */
  winners: number[];
  decisionPoint: string | null;
}

/**
 * 扩展点 `vote.ended`（观察）：投票正常结束时分发，在记下 `vote.ended` 之后、请求播报结果之前；
 * 中止的投票不分发。决策插件据此把“投票结束”作为决策时机。监听者按扩展点注册，投票插件重新加载后照样收到。
 */
export const VoteEnded = defineExtension<'observe', VoteEndedNotice>('vote.ended', 'observe');

/** 投票账本：进行中的投票（有 `vote.started`，还没有 `vote.ended` 或 `vote.aborted`）。 */
export interface VoteLedger {
  open: VoteRules | null;
}

/**
 * 投票账本的投影（状态存储）：由投票的事实归约，宿主打开状态存储时注册，重启时从事件重建。
 * 投票插件激活时据此先查状态再补记：对账结果未知的开票意图，把上次没结束的投票记为中止。
 */
export const voteLedger: Projection<VoteLedger> = {
  name: 'vote.ledger',
  initial: { open: null },
  reduce(state, event) {
    const data = event.data as { voteId?: unknown } | null;
    const voteId = typeof data?.voteId === 'string' ? data.voteId : undefined;
    if (voteId === undefined) return state;
    if (event.type === VoteFact.Started) return { open: event.data as VoteRules };
    if (
      (event.type === VoteFact.Ended || event.type === VoteFact.Aborted) &&
      state.open?.voteId === voteId
    ) {
      return { open: null };
    }
    return state;
  },
};

interface Running {
  rules: VoteRules;
  keys: ReadonlyMap<string, number>;
  startedAt: number;
  /** 截止时刻（时钟）：开票说明完整播出后才确定。 */
  deadlineAt: number | undefined;
  counts: number[];
  voters: Set<string>;
  ignored: { unmatched: number; repeat: number; late: number };
  gaps: Array<{ start: number; end: number | undefined; reason: string }>;
  timer: TimerHandle | undefined;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describe(outcome: UtteranceOutcome): string {
  if (outcome.end === 'complete') return `有 ${outcome.skipped.length} 句被跳过`;
  return outcome.reason ? `${outcome.end}：${outcome.reason}` : outcome.end;
}

/**
 * 投票（普通插件，`vote@1`）：决策模型发起，观众经弹幕投票，题目、选项与结果由角色口播。
 * 解读观众输入，按 Rule of Two 不持有任何凭据；订阅原始弹幕（`danmaku@1`，不经分诊的合并与降权），
 * 正文只当数据与选项比较。
 *
 * - 发起：同时最多一个；规则冻结后经执行闸门授权（能力 `vote.start`，幂等键 `vote:<编号>`），记 `vote.started`，
 *   以“弹幕回复”来源请求开票说明。开票说明完整播出后才开始倒计时（`vote.announced`），没完整播出就中止。
 * - 计票：从开票起到截止前收到的弹幕，规范化后是选项编号或选项文本才算一票，每个观众只计第一张。
 * - 截止：按冻结的规则判定（平票不判胜者），记 `vote.ended`（含与投票时段重叠的平台缺口），
 *   以“投票结果”来源播报一次结果。
 * - 安全停止、插件停用时中止进行中的投票；重启后先对账结果未知的开票意图，再把上次没结束的投票记为中止。
 */
export const vote = definePlugin({
  manifest: {
    id: 'audience-vote',
    version: '0.1.0',
    tier: 'ordinary',
    provides: [VoteService.ref],
    inject: [SafetyService.ref, ClockService.ref, DanmakuService.ref, SpeechService.ref],
    permissions: [VOTE_START],
    process: 'in-process',
    config: Type.Object({
      /** 开票说明在发起后这么久内还没开始播就过期，投票随之中止。 */
      openingTtlMs: Type.Integer({ minimum: 1, default: 20_000 }),
      /** 结果播报在截止后这么久内还没开始播就过期。 */
      resultTtlMs: Type.Integer({ minimum: 1, default: 30_000 }),
    }),
  },
  activate(ctx) {
    const safety = ctx.service(SafetyService);
    const clock = ctx.service(ClockService);
    const source = ctx.service(DanmakuService);
    const speech = ctx.service(SpeechService);
    const config = ctx.config;
    /** 本实例处理过的发起编号：同一次发起只处理一次（跨重启由意图的幂等键保证）。 */
    const handled = new Set<string>();
    let starting: string | undefined;
    let running: Running | undefined;

    /** 账本上这次投票还开着：别的实例（插件替换时的新实例）已经把它记为中止的，不再记结果。 */
    const stillOpen = (vote: Running) => safety.view(voteLedger).open?.voteId === vote.rules.voteId;

    // 先查状态再补记：重启时停在执行中的开票意图已标为结果未知，按账本上有没有开票记录对账；
    // 上次没结束的投票（倒计时被重启打断、缺口里的弹幕也收不到）记为中止，不出结果、不播报。
    const ledger = safety.view(voteLedger);
    for (const intent of safety.unresolved(VOTE_START)) {
      const open = ledger.open;
      const started = open !== null && voteIntentKey(open.voteId) === intent.key;
      safety.reconcile(
        intent,
        started
          ? { ok: true, result: { voteId: open.voteId } }
          : { ok: false, error: '重启后查无开票记录，这次发起没有开票' },
      );
      ctx.log('vote.reconciled', { key: intent.key, started });
    }
    if (ledger.open) {
      const reason = '投票插件激活时这次投票还没有结束（宿主重启或插件替换），不出结果、不播报';
      safety.record(VoteFact.Aborted, {
        voteId: ledger.open.voteId,
        decisionPoint: ledger.open.decisionPoint,
        cause: 'restart' satisfies AbortCause,
        reason,
      });
      ctx.log('vote.aborted', { voteId: ledger.open.voteId, cause: 'restart' });
    }

    const abort = (current: Running | undefined, cause: AbortCause, reason: string) => {
      if (!current || running !== current) return;
      running = undefined;
      if (current.timer) clock.clearTimeout(current.timer);
      if (!stillOpen(current)) return;
      safety.record(VoteFact.Aborted, {
        voteId: current.rules.voteId,
        decisionPoint: current.rules.decisionPoint,
        cause,
        reason,
      });
      ctx.log('vote.aborted', { voteId: current.rules.voteId, cause });
    };

    /** 与投票时段（开票到截止）重叠的缺口：只算有重叠的部分。 */
    const gapSummary = (current: Running, end: number) => {
      let durationMs = 0;
      let count = 0;
      const reasons = new Set<string>();
      for (const gap of current.gaps) {
        const from = Math.max(gap.start, current.startedAt);
        const to = Math.min(gap.end ?? end, end);
        if (to <= from) continue;
        count += 1;
        durationMs += to - from;
        reasons.add(gap.reason);
      }
      return { count, durationMs: Math.round(durationMs), reasons: [...reasons] };
    };

    const close = (current: Running) => {
      if (running !== current) return;
      running = undefined;
      current.timer = undefined;
      if (!stillOpen(current)) return;
      const { rules, counts } = current;
      const valid = counts.reduce((sum, n) => sum + n, 0);
      const { outcome, winners } = decide(counts);
      const gaps = gapSummary(current, current.deadlineAt ?? clock.now());
      safety.record(VoteFact.Ended, {
        voteId: rules.voteId,
        decisionPoint: rules.decisionPoint,
        counts: [...counts],
        valid,
        ignored: { ...current.ignored },
        outcome: outcome satisfies VoteOutcome,
        // 选项编号从 1 起，与观众投的编号一致。
        winners: winners.map((index) => index + 1),
        gaps,
      });
      ctx.log('vote.ended', { voteId: rules.voteId, valid, outcome, gaps: gaps.count });
      ctx.extensions.observe(VoteEnded, {
        voteId: rules.voteId,
        question: rules.question,
        options: [...rules.options],
        counts: [...counts],
        valid,
        outcome,
        winners: winners.map((index) => index + 1),
        decisionPoint: rules.decisionPoint,
      });
      // 先记结果再播报：重启后账本上没有进行中的投票，不会再播一次。
      void speech
        .request({
          id: voteSpeechId(rules.voteId, 'result'),
          source: 'vote-result',
          text: resultText(rules, { outcome, winners, counts, valid, gapMs: gaps.durationMs }),
          expiresAt: clock.now() + config.resultTtlMs,
          preempt: 'sentence',
          inputs: [voteIntentKey(rules.voteId)],
          // 选项文本来自模型，票来自弹幕。
          untrusted: true,
        })
        .then((played) => ctx.log('vote.result-played', { voteId: rules.voteId, end: played.end }));
    };

    /** 开票说明的结果：完整播出才开始倒计时，否则中止。 */
    const announced = (current: Running, outcome: UtteranceOutcome) => {
      if (running !== current) return;
      if (outcome.end !== 'complete' || outcome.skipped.length > 0) {
        abort(current, 'opening', `开票说明没有完整播出（${describe(outcome)}）`);
        return;
      }
      const { durationMs, voteId } = current.rules;
      current.deadlineAt = clock.now() + durationMs;
      safety.record(VoteFact.Announced, { voteId, durationMs });
      current.timer = clock.setTimeout(() => close(current), durationMs);
    };

    const open = (rules: VoteRules, request: VoteRequest): Running => {
      const startedAt = clock.now();
      const current: Running = {
        rules,
        keys: freezeKeys(rules),
        startedAt,
        deadlineAt: undefined,
        counts: rules.options.map(() => 0),
        voters: new Set(),
        ignored: { unmatched: 0, repeat: 0, late: 0 },
        gaps: [],
        timer: undefined,
      };
      const gap = source.gap?.();
      if (gap) current.gaps.push({ start: startedAt, end: undefined, reason: gap.reason });
      running = current;
      safety.record(VoteFact.Started, { ...rules });
      ctx.log('vote.started', {
        voteId: rules.voteId,
        options: rules.options.length,
        durationMs: rules.durationMs,
      });
      void speech
        .request({
          id: voteSpeechId(rules.voteId, 'opening'),
          // 开票说明含模型给的题目与选项：与回应观众同级，不借投票抬高优先级（D-33）。
          source: 'danmaku-reply',
          text: openingText(rules),
          expiresAt: startedAt + config.openingTtlMs,
          preempt: 'sentence',
          inputs: [...request.inputs],
          untrusted: request.untrusted,
          ...(request.trace ? { trace: request.trace } : {}),
        })
        .then((outcome) => announced(current, outcome));
      return current;
    };

    const onDanmaku = (danmaku: Danmaku) => {
      const current = running;
      if (!current) return;
      if (current.deadlineAt !== undefined && clock.now() >= current.deadlineAt) {
        current.ignored.late += 1;
        return;
      }
      const option = matchBallot(danmaku.text, current.keys);
      if (option === undefined) {
        current.ignored.unmatched += 1;
      } else if (current.voters.has(danmaku.viewer)) {
        current.ignored.repeat += 1;
      } else {
        current.voters.add(danmaku.viewer);
        current.counts[option] = (current.counts[option] ?? 0) + 1;
      }
    };

    ctx.register(source.subscribe(onDanmaku));
    if (source.onGap) {
      ctx.register(
        source.onGap((gap) => {
          const current = running;
          if (!current) return;
          const last = current.gaps.at(-1);
          if (gap) {
            if (!last || last.end !== undefined)
              current.gaps.push({ start: clock.now(), end: undefined, reason: gap.reason });
          } else if (last && last.end === undefined) {
            last.end = clock.now();
          }
        }),
      );
    }
    ctx.register(
      safety.onControl((signal) => {
        if (signal.kind === 'stop' || (signal.kind === 'mode' && signal.mode === 'safe-stop')) {
          abort(running, 'stopped', `安全停止：${signal.reason}`);
        }
      }),
    );
    ctx.register(() => abort(running, 'unloaded', '投票插件停用'));

    const reject = (request: VoteRequest, reason: string): VoteStartResult => {
      safety.record(VoteFact.Rejected, { voteId: request.id, reason });
      ctx.log('vote.rejected', { voteId: request.id, reason });
      return { ok: false, reason };
    };

    ctx.provide(VoteService, {
      async start(request) {
        if (ctx.signal.aborted) return reject(request, '投票插件停用');
        if (handled.has(request.id)) return reject(request, '同一次发起已经处理过');
        handled.add(request.id);
        const busy = running?.rules.voteId ?? starting;
        if (busy !== undefined) return reject(request, `已有进行中的投票 ${busy}`);
        const frozen = freezeRules({
          voteId: request.id,
          question: request.question,
          options: request.options,
          durationSec: request.durationSec,
          decisionPoint: request.decisionPoint,
        });
        if (!frozen.ok) return reject(request, `参数不合法：${frozen.reason}`);
        const rules = frozen.rules;
        starting = rules.voteId;
        try {
          const decision = await safety.authorize({
            key: voteIntentKey(rules.voteId),
            type: VOTE_START,
            target: VOTE_TARGET,
            payload: rules,
            // 投票据弹幕计票，来源总含不可信输入。
            source: { origin: 'vote', inputs: [...request.inputs], untrusted: true },
            capabilities: [VOTE_START],
            timeSensitive: false,
          });
          if (!decision.allowed) return reject(request, `执行闸门拒绝：${decision.reason}`);
          if (decision.duplicate) return reject(request, '同一次发起已经开过票');
          let opened: Running | undefined;
          // 授权之后立即执行，中间没有等待：意图不会停在待执行。
          const intent = await safety.execute(decision.intent, rules, async (payload) => {
            if (ctx.signal.aborted) throw new Error('投票插件停用');
            if (safety.mode === 'safe-stop') throw new Error('安全停止中');
            opened = open(payload, request);
            return { voteId: payload.voteId };
          });
          if (intent.state !== 'succeeded' || !opened) {
            return reject(request, `开票失败：${intent.error ?? '未知原因'}`);
          }
          return { ok: true, voteId: rules.voteId };
        } catch (error) {
          return reject(request, `开票失败：${message(error)}`);
        } finally {
          starting = undefined;
        }
      },
      current() {
        const current = running;
        if (!current) return undefined;
        const { rules, counts, deadlineAt } = current;
        return {
          voteId: rules.voteId,
          question: rules.question,
          options: [...rules.options],
          counts: [...counts],
          valid: counts.reduce((sum, n) => sum + n, 0),
          phase: deadlineAt === undefined ? 'announcing' : 'open',
          durationMs: rules.durationMs,
          remainingMs: deadlineAt === undefined ? null : Math.max(0, deadlineAt - clock.now()),
          decisionPoint: rules.decisionPoint,
          gap: source.gap?.() !== undefined,
        };
      },
    });
  },
});

/** 冻结时已核对过投法不冲突，这里只是重新生成对照表。 */
function freezeKeys(rules: VoteRules): ReadonlyMap<string, number> {
  const keys = ballotKeys(rules.options);
  if (typeof keys === 'string') throw new Error(keys);
  return keys;
}
