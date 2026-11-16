import type { Clock, TimerHandle } from '@bellis/kernel';
import {
  type GameActionCommitted,
  type GameDecisionPointOpened,
  type GameDecisionResolveParams,
  GameBridgeMethod as Method,
} from '@bellis/protocol';
import {
  Metric,
  NOOP_SPAN,
  parseTraceparent,
  type Span,
  type SpanOptions,
  type Tracer,
  traceparentOf,
} from '@bellis/telemetry';
import type { GameCommand } from './service.ts';

// 无计时选择没有执行截止线，限制的只是遥测等候动作证据的时间。
const UNTIMED_ACTION_WAIT_MS = 30_000;
// 动作的核验和送达可能发生在实际执行的截止线之后。
const ACTION_REPORT_GRACE_MS = 2_000;
const MAX_TIMER_MS = 2_147_483_647;

type Failure =
  | 'connection_changed'
  | 'duplicate'
  | 'expired'
  | 'ignored_update'
  | 'invalid_time'
  | 'missing_action'
  | 'mismatched_action'
  | 'replaced'
  | 'refused'
  | 'runtime_default'
  | 'stale'
  | 'stopped'
  | 'telemetry_unavailable'
  | 'unknown'
  | 'unloaded'
  | 'unmatched_action'
  | 'withdrawn';

type CommandOutcome = 'accepted' | 'refused' | 'unknown';
type DecisionTiming = GameDecisionPointOpened['timing'];

interface Opening {
  run: string;
  id: string;
  firstAtMs: number;
  resolveByMs: number | undefined;
  span: Span;
}

interface CommandTrace {
  span: Span;
  opening: Opening | undefined;
  traceparent: string | null;
}

interface Attempt {
  key: string;
  run: string;
  method: GameCommand['method'];
  sentAtMs: number;
  executionDeadlineMs: number | undefined;
  observeUntilMs: number;
  span: Span;
  choice?: Pick<GameDecisionResolveParams, 'optionId' | 'source'>;
  accepted: boolean;
  actionAtMs?: number;
}

function keyFor(run: string, method: GameCommand['method'], id: string): string {
  return JSON.stringify([run, method, id]);
}

// 记录器及其 span 都可能在运行中失效。遥测的异常只丢掉派生数据。
function emit(write: () => void): void {
  try {
    write();
  } catch {
    // 保留运行动作和持久事实的结果。
  }
}

function end(span: Span, failure?: Failure): void {
  if (failure) emit(() => span.fail(failure));
  emit(() => span.end());
}

/** 只关联已发送的命令和已持久化的事实。这里维护的状态不参与授权和执行。 */
export class GameTelemetry {
  readonly #tracer: Tracer;
  readonly #clock: Clock;
  readonly #wireNowMs: () => number;
  readonly #attempts = new Map<string, Attempt>();
  #opening: Opening | undefined;
  #timer: TimerHandle | undefined;

  constructor(tracer: Tracer, clock: Clock, wireNowMs: () => number) {
    this.#tracer = tracer;
    this.#clock = clock;
    this.#wireNowMs = wireNowMs;
  }

  #start(name: string, options: SpanOptions): Span {
    try {
      return this.#tracer.startSpan(name, options);
    } catch {
      return NOOP_SPAN;
    }
  }

  discarded(
    name: 'game.command' | 'game.action' | 'game.decision',
    traceparent: string | null,
    failure: Failure,
  ): void {
    end(this.#start(name, { parent: traceparent ?? undefined }), failure);
  }

  opened(run: string, point: GameDecisionPointOpened, update: boolean): void {
    if (update) {
      const opening = this.#opening;
      if (!opening || opening.run !== run || opening.id !== point.decisionPointId) return;
      opening.resolveByMs = point.timing?.resolveByMs;
    } else {
      this.#closeOpening('replaced');
      for (const attempt of this.#attempts.values()) {
        if (attempt.method === Method.DecisionResolve && attempt.actionAtMs === undefined)
          this.#finish(attempt, 'replaced');
      }
      const span = this.#start('game.decision', {
        parent: point.traceparent ?? undefined,
        kind: 'consumer',
      });
      if (span !== NOOP_SPAN) {
        this.#opening = {
          run,
          id: point.decisionPointId,
          firstAtMs: point.atMs,
          resolveByMs: point.timing?.resolveByMs,
          span,
        };
      }
    }
    this.#refresh();
  }

  withdrew(): void {
    // 发送后的动作事实可能晚于决策点关闭的健康上报，继续等它自己的截止线。
    this.#closeOpening('withdrawn');
    this.#refresh();
  }

  /** 发送前取得命令 span 的上下文。派发时刻仍由实际 RPC 调用记下。 */
  prepare(run: string, command: GameCommand): CommandTrace {
    const { method, payload } = command;
    const point = this.#opening;
    const opening =
      method === Method.DecisionResolve &&
      point?.run === run &&
      point.id === command.payload.decisionPointId
        ? point
        : undefined;
    const parent = payload.traceparent ?? opening?.span;
    const span = this.#start('game.command', {
      parent,
      kind: 'client',
      attributes: { 'bellis.game.command': method },
    });
    let traceparent = payload.traceparent;
    emit(() => {
      const context = span.traceparent;
      const current = parseTraceparent(context);
      const upstream = parseTraceparent(traceparentOf(parent));
      if (
        context?.startsWith('00-') &&
        current &&
        (!upstream || current.traceId === upstream.traceId)
      )
        traceparent = context;
    });
    return { span, opening, traceparent };
  }

  unsent({ span }: CommandTrace, failure: 'expired' | 'stale'): void {
    end(span, failure);
  }

  sent(
    run: string,
    command: GameCommand,
    prepared: CommandTrace,
    sentAtMs: number,
    timing: DecisionTiming | undefined,
  ): ((outcome: CommandOutcome) => void) | undefined {
    const { method, payload } = command;
    const { span } = prepared;
    const opening = this.#opening === prepared.opening ? prepared.opening : undefined;
    if (opening) {
      this.#opening = undefined;
      if (span === NOOP_SPAN) {
        end(opening.span, 'telemetry_unavailable');
      } else {
        if (payload.traceparent) emit(() => opening.span.addLink(span));
        emit(() =>
          opening.span.addEvent('game.resolve.dispatched', { 'bellis.game.wire_ms': sentAtMs }),
        );
      }
    }
    if (span === NOOP_SPAN) {
      this.#refresh();
      return;
    }

    const executionDeadlineMs =
      method === Method.GoalSubmit ? command.payload.expiresAtMs : timing?.deadlineMs;
    const observeUntilMs =
      executionDeadlineMs === undefined
        ? sentAtMs + UNTIMED_ACTION_WAIT_MS
        : executionDeadlineMs + ACTION_REPORT_GRACE_MS;
    const key = keyFor(
      run,
      method,
      method === Method.GoalSubmit ? command.payload.goalId : command.payload.decisionPointId,
    );
    const attempt: Attempt = {
      key,
      run,
      method,
      sentAtMs,
      executionDeadlineMs,
      observeUntilMs,
      span,
      accepted: false,
    };
    if (method === Method.DecisionResolve)
      attempt.choice = { optionId: command.payload.optionId, source: command.payload.source };
    this.#attempts.set(key, attempt);
    emit(() => span.addEvent('game.command.dispatched', { 'bellis.game.wire_ms': sentAtMs }));
    let invalid: Failure | undefined;
    if (opening && sentAtMs < opening.firstAtMs) invalid = 'invalid_time';
    else if (
      (timing && sentAtMs >= timing.resolveByMs) ||
      (executionDeadlineMs !== undefined && sentAtMs >= executionDeadlineMs)
    )
      invalid = 'expired';
    if (invalid) this.#finish(attempt, invalid);
    this.#refresh();

    return (outcome) => {
      if (opening) {
        const durationMs = sentAtMs - opening.firstAtMs;
        emit(() =>
          opening.span.setAttributes({
            'bellis.game.outcome': outcome,
            'bellis.game.decision_ms': durationMs >= 0 ? durationMs : undefined,
          }),
        );
        // 接纳证实命令已发送。动作核验独立，不能让它筛掉已接纳决定的耗时。
        if (outcome === 'accepted' && !invalid)
          emit(() =>
            this.#tracer.record(
              Metric.GameDecisionDuration,
              durationMs / 1000,
              's',
              undefined,
              opening.span,
            ),
          );
        end(opening.span, invalid ?? (outcome === 'accepted' ? undefined : outcome));
      }
      if (this.#attempts.get(key) !== attempt) {
        if (outcome !== 'accepted') this.discarded('game.command', payload.traceparent, outcome);
        return;
      }
      if (outcome !== 'accepted') {
        this.#finish(attempt, outcome);
      } else {
        attempt.accepted = true;
        emit(() => span.addEvent('game.command.accepted'));
        if (method === Method.GoalSubmit) {
          for (const older of this.#attempts.values()) {
            if (older !== attempt && older.run === run && older.method === method)
              this.#finish(older, 'replaced');
          }
        }
        this.#complete(attempt);
      }
      this.#refresh();
    };
  }

  action(run: string, action: GameActionCommitted): void {
    const { goalId, selection, traceparent } = action;
    const goal =
      goalId === null ? undefined : this.#attempts.get(keyFor(run, Method.GoalSubmit, goalId));
    const choice = selection
      ? this.#attempts.get(keyFor(run, Method.DecisionResolve, selection.decisionPointId))
      : undefined;
    const opening = this.#opening;
    const openedHere = opening?.run === run && opening.id === selection?.decisionPointId;
    if (openedHere) {
      emit(() => opening.span.addLink(traceparent ?? undefined));
      this.#closeOpening(selection?.source === 'default' ? 'runtime_default' : 'unmatched_action');
    }
    if (goal) this.#match(goal, action);
    if (choice && selection) {
      if (selection.source === 'default') this.#finish(choice, 'runtime_default');
      else if (
        selection.optionId !== choice.choice?.optionId ||
        selection.source !== choice.choice?.source
      ) {
        this.#finish(choice, 'mismatched_action');
      } else this.#match(choice, action);
    }
    if (!choice && !openedHere && selection?.source === 'default')
      this.discarded('game.action', traceparent, 'runtime_default');
    else if (!goal && !choice && !openedHere && this.#attempts.size > 0)
      this.discarded('game.action', traceparent, 'unmatched_action');
    this.#refresh();
  }

  #match(attempt: Attempt, { atMs, traceparent }: GameActionCommitted): void {
    if (attempt.actionAtMs !== undefined) return;
    if (atMs < attempt.sentAtMs) {
      this.discarded('game.action', traceparent, 'invalid_time');
      return;
    }
    if (attempt.executionDeadlineMs !== undefined && atMs >= attempt.executionDeadlineMs) {
      this.discarded('game.action', traceparent, 'expired');
      return;
    }
    if (this.#wireNowMs() >= attempt.observeUntilMs) {
      this.#finish(attempt, 'missing_action');
      return;
    }
    attempt.actionAtMs = atMs;
    emit(() => attempt.span.addLink(traceparent ?? undefined));
    emit(() => attempt.span.addEvent('game.action.committed', { 'bellis.game.wire_ms': atMs }));
    this.#complete(attempt);
  }

  #complete(attempt: Attempt): void {
    const { actionAtMs, sentAtMs, span, method } = attempt;
    if (!attempt.accepted || actionAtMs === undefined) return;
    emit(() =>
      this.#tracer.record(
        Metric.GameFirstAction,
        (actionAtMs - sentAtMs) / 1000,
        's',
        { 'bellis.game.command': method },
        span,
      ),
    );
    this.#finish(attempt);
  }

  #finish(attempt: Attempt, failure?: Failure): void {
    this.#attempts.delete(attempt.key);
    end(attempt.span, failure);
  }

  #closeOpening(failure: Failure): void {
    const opening = this.#opening;
    this.#opening = undefined;
    if (opening) end(opening.span, failure);
  }

  reset(failure: 'connection_changed' | 'stopped' | 'unloaded'): void {
    this.#closeOpening(failure);
    for (const attempt of this.#attempts.values()) this.#finish(attempt, failure);
    this.#refresh();
  }

  #refresh(): void {
    if (this.#timer) this.#clock.clearTimeout(this.#timer);
    this.#timer = undefined;
    if (!this.#opening && this.#attempts.size === 0) return;
    const now = this.#wireNowMs();
    if (this.#opening?.resolveByMs !== undefined && now >= this.#opening.resolveByMs)
      this.#closeOpening('expired');
    let deadline = this.#opening?.resolveByMs ?? Infinity;
    for (const attempt of this.#attempts.values()) {
      if (attempt.actionAtMs !== undefined) continue;
      if (now >= attempt.observeUntilMs) this.#finish(attempt, 'missing_action');
      else deadline = Math.min(deadline, attempt.observeUntilMs);
    }
    if (Number.isFinite(deadline)) {
      this.#timer = this.#clock.setTimeout(
        () => this.#refresh(),
        Math.min(MAX_TIMER_MS, Math.max(1, deadline - now)),
      );
    }
  }
}
