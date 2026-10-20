import { type Candidate, CandidatesService, VoteService } from '@bellis/audience';
import {
  ClockService,
  definePlugin,
  defineService,
  type TimerHandle,
  withDeadline,
} from '@bellis/kernel';
import { SpeechService } from '@bellis/speech';
import Type from 'typebox';
import { parseAction, type VoteAction } from './output.ts';

/**
 * 交给决策模型的上下文。只含人设、观众实际听到的近期发言、分诊后净化过的候选。
 * 不含凭据、OBS 与游戏的控制能力、私密记忆、未净化的原始昵称与原文（Rule of Two）。
 */
export interface DirectorContext {
  persona: string;
  heard: string[];
  candidates: Array<{ id: string; name: string; text: string; count: number }>;
}

export interface LlmRequest {
  context: DirectorContext;
}

export interface Llm {
  complete(request: LlmRequest, signal: AbortSignal): Promise<string>;
}

export const LlmService = defineService<Llm>('llm', 1);

/**
 * 决策模型（普通插件）：在决策时机到来时组装上下文、调用模型、把输出解析成枚举的意图。
 * 时机：新一批候选到达、冷场计时到期。同时只有一个在途调用，每次调用都有截止时间。
 * 发起投票交给投票插件（可选依赖，不在场时只记日志）；游戏目标在后续阶段接入。
 */
export const director = definePlugin({
  manifest: {
    id: 'director',
    version: '0.1.0',
    tier: 'ordinary',
    provides: [],
    inject: [
      LlmService.ref,
      SpeechService.ref,
      CandidatesService.ref,
      ClockService.ref,
      `${VoteService.ref}?`,
    ],
    permissions: [],
    process: 'in-process',
    config: Type.Object({
      persona: Type.String({ default: '' }),
      maxCandidates: Type.Integer({ minimum: 1, default: 5 }),
      callTimeoutMs: Type.Integer({ minimum: 1, default: 8_000 }),
      replyTtlMs: Type.Integer({ minimum: 1, default: 20_000 }),
      /** 冷场多久后自主发言；0 表示不闲聊。 */
      idleMs: Type.Integer({ minimum: 0, default: 0 }),
      /** 连续这么多次失败后告警。 */
      alarmAfter: Type.Integer({ minimum: 1, default: 3 }),
    }),
  },
  activate(ctx) {
    const llm = ctx.service(LlmService);
    const speech = ctx.service(SpeechService);
    const candidates = ctx.service(CandidatesService);
    const clock = ctx.service(ClockService);
    const config = ctx.config;
    let inflight = false;
    let again = false;
    let failures = 0;
    let calls = 0;
    let idleTimer: TimerHandle | undefined;

    const context = (taken: Candidate[]): DirectorContext => ({
      persona: config.persona,
      heard: speech.heard().map((utterance) => utterance.heard),
      candidates: taken.map((c) => ({ id: c.id, name: c.name, text: c.text, count: c.count })),
    });

    /**
     * 发起投票：交给投票插件（`vote@1`），规则、计票与口播都在那里；优先级与发声来源也由那里的确定性代码决定，
     * 模型不能指定（D-33）。成功、被拒都记日志，不写题目与选项（模型输出可能复述弹幕）。
     */
    const startVote = (action: VoteAction, taken: Candidate[], id: string) => {
      const votes = ctx.optional(VoteService);
      if (!votes) {
        ctx.log('director.vote-unavailable', { id, reason: '投票插件不在场' });
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
          untrusted: taken.length > 0,
        })
        .then((result) =>
          result.ok
            ? ctx.log('director.vote-started', { id, voteId: result.voteId })
            : ctx.log('director.vote-refused', { id, reason: result.reason }),
        );
    };

    const failed = (reason: string) => {
      failures += 1;
      ctx.log('director.output-dropped', { reason, failures });
      if (failures >= config.alarmAfter) ctx.log('director.alarm', { failures });
    };

    const decide = async () => {
      if (inflight) {
        again = true;
        return;
      }
      inflight = true;
      try {
        do {
          again = false;
          if (ctx.signal.aborted) return;
          const taken = candidates.take(config.maxCandidates);
          const request = { context: context(taken) };
          const controller = new AbortController();
          let output: string;
          try {
            output = await withDeadline(
              clock,
              llm.complete(request, controller.signal),
              config.callTimeoutMs,
              '决策模型调用',
            );
          } catch (error) {
            controller.abort();
            failed((error as Error).message);
            continue;
          }
          const parsed = parseAction(output);
          if (!parsed.ok) {
            failed(parsed.reason);
            continue;
          }
          const action = parsed.action;
          if (action.action === 'speak') {
            const target =
              action.replyTo === undefined ? undefined : taken.find((c) => c.id === action.replyTo);
            if (action.replyTo !== undefined && !target) {
              failed(`回应对象 ${action.replyTo} 不在本次上下文中`);
              continue;
            }
            failures = 0;
            calls += 1;
            void speech.request({
              id: `director:${ctx.instanceId}:${calls}`,
              source: target ? 'danmaku-reply' : 'chatter',
              text: action.text,
              expiresAt: clock.now() + config.replyTtlMs,
              // 回应观众时在句边界才能被抢占；自主闲聊可以立即让位。
              preempt: target ? 'sentence' : 'immediate',
              inputs: target ? target.sources : [],
              // 上下文里有弹幕，输出就受不可信输入影响。
              untrusted: taken.length > 0,
            });
          } else if (action.action === 'vote') {
            failures = 0;
            calls += 1;
            startVote(action, taken, `director:${ctx.instanceId}:${calls}`);
          } else {
            failures = 0;
            ctx.log('director.silence', { ...action });
          }
        } while (again);
      } finally {
        inflight = false;
        armIdle();
      }
    };

    const armIdle = () => {
      if (idleTimer) clock.clearTimeout(idleTimer);
      idleTimer = undefined;
      if (config.idleMs > 0 && !ctx.signal.aborted) {
        idleTimer = clock.setTimeout(() => void decide(), config.idleMs);
      }
    };

    ctx.register(candidates.onAvailable(() => void decide()));
    ctx.register(() => {
      if (idleTimer) clock.clearTimeout(idleTimer);
    });
    armIdle();
  },
});

/** 回放的模型输出（P0 用）：按顺序返回录好的输出，并记下收到的上下文以便检查。 */
export interface ReplayLlm extends Llm {
  readonly requests: readonly LlmRequest[];
}

export const ReplayLlmService = defineService<ReplayLlm>('llm-replay', 1);

export const replayLlm = definePlugin({
  manifest: {
    id: 'llm-replay',
    version: '0.1.0',
    tier: 'ordinary',
    provides: [LlmService.ref, ReplayLlmService.ref],
    inject: [ClockService.ref],
    permissions: [],
    process: 'in-process',
    config: Type.Object({
      outputs: Type.Array(Type.String()),
      /** 每次调用的模拟耗时。 */
      latencyMs: Type.Integer({ minimum: 0, default: 0 }),
    }),
  },
  activate(ctx) {
    const clock = ctx.service(ClockService);
    const requests: LlmRequest[] = [];
    let next = 0;
    const replay: ReplayLlm = {
      requests,
      complete(request) {
        requests.push(structuredClone(request));
        const output = ctx.config.outputs[next] ?? '{"action":"silence","reason":"回放结束"}';
        next += 1;
        return new Promise((resolve) =>
          clock.setTimeout(() => resolve(output), ctx.config.latencyMs),
        );
      },
    };
    ctx.provide(LlmService, replay);
    ctx.provide(ReplayLlmService, replay);
  },
});
