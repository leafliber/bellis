import type {
  GameActionResolveOutcomeParams,
  GameMainHealthV2,
  GameOutcomeResolution,
  GamePendingActionOutcome,
  GameTaskOpenParams,
} from '@bellis/protocol';
import type { Projection, StoredEvent } from '@bellis/store';

export const GameAuthorityFact = {
  Bound: 'game.authority-bound',
  TaskDispatched: 'game.task-open-dispatched',
  OutcomeDispatched: 'game.action-resolution-dispatched',
  TaskRetired: 'game.task-retired',
} as const;

export interface AuthorityTask {
  request: GameTaskOpenParams;
  runtimeId: string;
  hostSessionId: string;
  dispatches: readonly number[];
  accepted: boolean;
  observedActive: boolean;
  ended: boolean;
}

export interface AuthorityPending {
  outcome: GamePendingActionOutcome;
  conflict?: boolean;
  resolution?: {
    outcome: GamePendingActionOutcome;
    request: GameActionResolveOutcomeParams;
    dispatches: readonly number[];
  };
}

interface SettledOutcome {
  outcome: GamePendingActionOutcome;
  resolution: GameOutcomeResolution;
}

export interface AuthoritySlot {
  adapterId: string;
  task: AuthorityTask | null;
  pending: readonly AuthorityPending[];
  settled: Readonly<Record<string, SettledOutcome>>;
}

export const authoritySlotKey = (id: string) => `slot:${id}`;
const attemptKey = (id: string) => `attempt:${id}`;

export function settledOutcome(slot: AuthoritySlot, attemptId: string): SettledOutcome | undefined {
  return slot.settled[attemptKey(attemptId)];
}

export function sameAttempt(left: GamePendingActionOutcome, right: GamePendingActionOutcome) {
  return (
    left.attemptId === right.attemptId &&
    left.runtimeId === right.runtimeId &&
    left.sessionId === right.sessionId &&
    left.goalId === right.goalId &&
    left.actionId === right.actionId &&
    left.decisionPointId === right.decisionPointId
  );
}

function observeOutcome(
  slot: AuthoritySlot,
  outcome: GamePendingActionOutcome,
): readonly AuthorityPending[] {
  const settled = settledOutcome(slot, outcome.attemptId);
  if (settled && sameAttempt(settled.outcome, outcome)) return slot.pending;
  const previous = slot.pending.find((item) => item.outcome.attemptId === outcome.attemptId);
  if (!previous) {
    return [...slot.pending, { outcome, ...(settled ? { conflict: true } : {}) }];
  }
  if (previous.conflict || sameAttempt(previous.outcome, outcome)) return slot.pending;
  return slot.pending.map((item) => (item === previous ? { ...item, conflict: true } : item));
}

function observe(slot: AuthoritySlot, runtimeId: string, health: GameMainHealthV2): AuthoritySlot {
  let { task } = slot;
  const pending = health.pendingActionOutcome
    ? observeOutcome(slot, health.pendingActionOutcome)
    : slot.pending;

  if (task && !task.ended) {
    if (
      runtimeId !== task.runtimeId ||
      health.atMs >= task.request.expiresAtMs ||
      (task.observedActive && health.activeTaskId === null) ||
      (health.activeTaskId !== null && health.activeTaskId !== task.request.taskId)
    ) {
      task = { ...task, ended: true };
    } else if (!task.observedActive && health.activeTaskId === task.request.taskId) {
      task = { ...task, observedActive: true };
    }
  }
  return task === slot.task && pending === slot.pending ? slot : { ...slot, task, pending };
}

/**
 * 用已核对的回执完成意图，SQLite 在同一事务里提交成功事实与业务投影。
 * 通用操作员意图结案是 intent.reconciled，不能代替这份回执。
 */
function finishDispatch(slotKey: string, slot: AuthoritySlot, event: StoredEvent): AuthoritySlot {
  const { id, result } = event.data as { id: number; result?: unknown };
  const succeeded = event.type === 'intent.succeeded';
  const { task, pending } = slot;
  if (task?.dispatches.at(-1) === id) {
    const dispatches = succeeded ? [] : task.dispatches.slice(0, -1);
    return {
      ...slot,
      task: succeeded || dispatches.length ? { ...task, accepted: succeeded, dispatches } : null,
    };
  }
  const index = pending.findIndex(({ resolution }) => resolution?.dispatches.at(-1) === id);
  if (index < 0) return slot;
  const item = pending[index] as AuthorityPending;
  const resolution = item.resolution as NonNullable<AuthorityPending['resolution']>;
  if (succeeded) {
    const receipt = result as
      | Partial<{
          method: string;
          controlTargetId: string;
          attemptId: string;
          resolution: GameOutcomeResolution;
        }>
      | null
      | undefined;
    if (
      item.conflict ||
      !sameAttempt(item.outcome, resolution.outcome) ||
      receipt?.method !== 'action.resolve_outcome' ||
      typeof receipt.controlTargetId !== 'string' ||
      authoritySlotKey(receipt.controlTargetId) !== slotKey ||
      receipt.attemptId !== resolution.request.attemptId ||
      receipt.resolution !== resolution.request.resolution
    )
      return slot;
    return {
      ...slot,
      pending: pending.filter((_, i) => i !== index),
      settled: {
        ...slot.settled,
        [attemptKey(item.outcome.attemptId)]: {
          outcome: item.outcome,
          resolution: resolution.request.resolution,
        },
      },
    };
  }
  const dispatches = resolution.dispatches.slice(0, -1);
  return {
    ...slot,
    pending: pending.with(index, {
      outcome: item.outcome,
      ...(item.conflict ? { conflict: item.conflict } : {}),
      ...(dispatches.length ? { resolution: { ...resolution, dispatches } } : {}),
    }),
  };
}

type Slots = Readonly<Record<string, AuthoritySlot>>;

function reduceSlot(slot: AuthoritySlot, event: StoredEvent): AuthoritySlot {
  switch (event.type) {
    case 'health.reported': {
      const { runtimeId, payload } = event.data as { runtimeId: string; payload: GameMainHealthV2 };
      return observe(slot, runtimeId, payload);
    }
    case GameAuthorityFact.TaskDispatched: {
      const { request, runtimeId, hostSessionId, intentId } = event.data as {
        request: GameTaskOpenParams;
        runtimeId: string;
        hostSessionId: string;
        intentId: number;
      };
      const old = slot.task?.request.taskId === request.taskId ? slot.task : null;
      return {
        ...slot,
        task: {
          request,
          runtimeId,
          hostSessionId,
          dispatches: [...(old?.dispatches ?? []), intentId],
          observedActive: old?.observedActive ?? false,
          ended: old?.ended ?? false,
          accepted: false,
        },
      };
    }
    case GameAuthorityFact.OutcomeDispatched: {
      const { request, intentId } = event.data as {
        request: GameActionResolveOutcomeParams;
        intentId: number;
      };
      return {
        ...slot,
        pending: slot.pending.map((item) =>
          item.outcome.attemptId === request.attemptId &&
          item.outcome.sessionId === request.sessionId &&
          !item.conflict &&
          (!item.resolution ||
            (sameAttempt(item.outcome, item.resolution.outcome) &&
              item.resolution.request.resolution === request.resolution))
            ? {
                ...item,
                resolution: {
                  outcome: item.outcome,
                  request,
                  dispatches: [...(item.resolution?.dispatches ?? []), intentId],
                },
              }
            : item,
        ),
      };
    }
    case GameAuthorityFact.TaskRetired:
      return { ...slot, task: null };
    default:
      return slot;
  }
}

export const gameAuthorityLedger: Projection<Slots> = {
  name: 'game.authority',
  initial: {},
  reduce(state, event) {
    if (event.type === 'intent.succeeded' || event.type === 'intent.failed') {
      for (const [key, slot] of Object.entries(state)) {
        const next = finishDispatch(key, slot, event);
        if (next !== slot) return { ...state, [key]: next };
      }
      return state;
    }
    if (
      event.type !== 'health.reported' &&
      event.type !== GameAuthorityFact.Bound &&
      event.type !== GameAuthorityFact.TaskDispatched &&
      event.type !== GameAuthorityFact.OutcomeDispatched &&
      event.type !== GameAuthorityFact.TaskRetired
    )
      return state;
    const { controlTargetId } = event.data as { controlTargetId?: string };
    if (!controlTargetId) return state;
    const key = authoritySlotKey(controlTargetId);
    if (event.type === GameAuthorityFact.Bound && !state[key]) {
      const { adapterId } = event.data as { adapterId: string };
      return { ...state, [key]: { adapterId, task: null, pending: [], settled: {} } };
    }
    const slot = state[key];
    if (!slot) return state;
    const next = reduceSlot(slot, event);
    return next === slot ? state : { ...state, [key]: next };
  },
};
