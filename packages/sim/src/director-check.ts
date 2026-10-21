import { parseIntent } from '@bellis/director';
import type { History } from './invariants.ts';
import { ALARM_AFTER, FALLBACK_LINE, LATE_TEXT } from './scenario.ts';
import { MODE_RANK } from './supervision-check.ts';

/** 决策插件对一次模型调用的结局，由回放模型写进追踪的事独立推出。 */
type Outcome =
  | { kind: 'cancelled' }
  | { kind: 'success'; speech: string | undefined }
  | { kind: 'failure'; failure: string; callFailed: boolean };

/** 一次有结局的调用应当带来的：交给发声的文本、过渡语、告警（连续失败的次数）。 */
interface Expected {
  call: number;
  speech: string | undefined;
  fallback: boolean;
  alarm: number | undefined;
}

const FALLBACK_ID = /^director:.+:fallback:\d+$/u;

/** 模型给出了输出：按决策插件的规则（整段解析、回应对象须在本次上下文里）推出结局。 */
function classify(output: string, candidates: readonly string[]): Outcome {
  const parsed = parseIntent(output);
  if (!parsed.ok) return { kind: 'failure', failure: 'invalid_output', callFailed: false };
  const action = parsed.action;
  if (action.action !== 'speak') return { kind: 'success', speech: undefined };
  if (action.replyTo !== undefined && !candidates.includes(action.replyTo))
    return { kind: 'failure', failure: 'unknown_target', callFailed: false };
  return { kind: 'success', speech: action.text };
}

/**
 * 决策模型失败的不变量（见决策模型“失败与降级”）。每次调用的结局由回放模型的记录独立推出：先到的中止
 * （截止时间到点算超时，否则是取消）、出错，或给出的输出（非法、回应对象不在上下文中算失败）。出错给出之后、
 * 决策插件处理之前到达的取消（同一时刻别的定时器触发）让这次调用算作取消；给出输出之后再到的取消不改变结局。
 * 1. 失败与取消的调用不产生任何发言；超时的调用晚到的输出（{@link LATE_TEXT}）从不交给发声；成功的说话意图
 *    恰好交给发声一次，文本不变；
 * 2. 过渡语只在超时或出错、且这次取到了候选时播，每一串连续失败至多一句（成功才清零，取消不算）；
 * 3. 连续失败每满 {@link ALARM_AFTER} 次记一次告警（`director.alarmed`），告警（含漂移告警）之后安全核随即收到
 *    降级请求，模式随之下降（已在安全停止时不变）。
 * 各次启动分别计（新进程里的决策插件从零开始）。
 */
export function checkDirector(history: History): string[] {
  const violations: string[] = [];
  let candidates = new Map<number, readonly string[]>();
  let decided = new Set<number>();
  let streak = 0;
  let fallbackUsed = false;
  let mode = 'safe-stop';
  let expected: Expected | undefined;
  /** 告警之后等降级请求；降级请求之后等模式下降（请求时的模式）。 */
  let awaitingDowngrade = false;
  let downgradeFrom: string | undefined;
  /** 已经出错、还要看决策插件处理之前有没有取消先到的调用。 */
  let failedCall: { call: number; kind: string } | undefined;

  /** 上一次有结局的调用应当带来的都已出现（下一次调用、重启与结束时核对）。 */
  const settle = () => {
    if (expected) {
      const { call } = expected;
      if (expected.speech !== undefined)
        violations.push(`第 ${call} 次调用成功的说话意图没有交给发声`);
      if (expected.fallback)
        violations.push(`第 ${call} 次调用超时或出错、有观众在等，却没有请求过渡语`);
      if (expected.alarm !== undefined)
        violations.push(`第 ${call} 次调用后连续失败 ${expected.alarm} 次，没有告警`);
    }
    expected = undefined;
    if (awaitingDowngrade) violations.push('决策插件告警之后安全核没有收到降级请求');
    awaitingDowngrade = false;
    if (downgradeFrom !== undefined)
      violations.push(`降级请求之后模式没有从 ${downgradeFrom} 下降`);
    downgradeFrom = undefined;
  };

  /** 出错的调用：之后没有取消先到，就是一次失败。 */
  const commitError = () => {
    const pending = failedCall;
    failedCall = undefined;
    if (pending) decide(pending.call, { kind: 'failure', failure: pending.kind, callFailed: true });
  };

  const decide = (call: number, outcome: Outcome) => {
    if (decided.has(call)) return;
    decided.add(call);
    if (outcome.kind === 'cancelled') return;
    if (outcome.kind === 'success') {
      streak = 0;
      fallbackUsed = false;
      expected = { call, speech: outcome.speech, fallback: false, alarm: undefined };
      return;
    }
    streak += 1;
    const waiting = (candidates.get(call)?.length ?? 0) > 0;
    const fallback = outcome.callFailed && waiting && !fallbackUsed;
    if (fallback) fallbackUsed = true;
    expected = {
      call,
      speech: undefined,
      fallback,
      alarm: streak % ALARM_AFTER === 0 ? streak : undefined,
    };
  };

  for (const entry of history.trace) {
    const call = Number(entry.data.call);
    // 决策插件处理出错的结果（发言、告警）或开始下一次调用之前，先定下那次出错的结局。
    if (
      entry.kind === 'world.start' ||
      entry.kind === 'llm.request' ||
      (entry.kind === 'speech.requested' && String(entry.data.id).startsWith('director:')) ||
      entry.kind === 'fact.director.alarmed'
    )
      commitError();
    switch (entry.kind) {
      case 'world.start':
        settle();
        candidates = new Map();
        decided = new Set();
        streak = 0;
        fallbackUsed = false;
        mode = 'safe-stop';
        break;
      case 'control.mode': {
        const next = String(entry.data.mode);
        if (downgradeFrom !== undefined) {
          if (!((MODE_RANK[next] ?? 0) < (MODE_RANK[downgradeFrom] ?? 0)))
            violations.push(`降级请求之后模式从 ${downgradeFrom} 变成了 ${next}`);
          downgradeFrom = undefined;
        }
        mode = next;
        break;
      }
      case 'llm.request':
        settle();
        candidates.set(call, (entry.data.candidates as string[] | undefined) ?? []);
        break;
      case 'llm.aborted':
        if (entry.data.afterResult === true) {
          if (failedCall?.call === call) {
            failedCall = undefined;
            decide(call, { kind: 'cancelled' });
          }
          break;
        }
        decide(
          call,
          entry.data.deadline === true
            ? { kind: 'failure', failure: 'timeout', callFailed: true }
            : { kind: 'cancelled' },
        );
        break;
      case 'llm.error':
        commitError();
        failedCall = { call, kind: String(entry.data.kind) };
        break;
      case 'llm.output':
        decide(call, classify(String(entry.data.output), candidates.get(call) ?? []));
        break;
      case 'speech.requested': {
        const id = String(entry.data.id);
        const text = entry.data.text;
        if (typeof text === 'string' && text.includes(LATE_TEXT))
          violations.push(`超时的调用晚到的输出交给了发声（${id}，第 ${entry.seq} 条追踪）`);
        if (FALLBACK_ID.test(id)) {
          if (expected?.fallback) expected.fallback = false;
          else
            violations.push(
              `过渡语 ${id} 不在一串连续失败里第一次超时或出错之后（第 ${entry.seq} 条追踪）`,
            );
          if (text !== FALLBACK_LINE) violations.push(`过渡语 ${id} 不是配置的那一句`);
        } else if (id.startsWith('director:')) {
          if (expected !== undefined && expected.speech === text) expected.speech = undefined;
          else violations.push(`发言 ${id} 不来自一次成功的模型调用（第 ${entry.seq} 条追踪）`);
        }
        break;
      }
      case 'fact.director.alarmed': {
        if (entry.data.cause === 'failures') {
          if (expected?.alarm !== undefined && expected.alarm === entry.data.count)
            expected.alarm = undefined;
          else
            violations.push(
              `连续失败的告警（${String(entry.data.count)} 次）与推算的连续失败对不上（第 ${entry.seq} 条追踪）`,
            );
        }
        awaitingDowngrade = true;
        break;
      }
      case 'fact.safety.downgrade-requested': {
        awaitingDowngrade = false;
        const from = String(entry.data.mode);
        if (from !== mode) violations.push(`降级请求记下的模式 ${from} 不是当时的模式 ${mode}`);
        // 已在安全停止时只记事实，模式不变。
        downgradeFrom = from === 'safe-stop' ? undefined : from;
        break;
      }
    }
  }
  commitError();
  settle();
  return violations;
}
