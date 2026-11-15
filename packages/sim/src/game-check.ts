import { isDeepStrictEqual } from 'node:util';
import {
  type GameActionCommitted,
  GameBridgeRole,
  type GameDecisionPointOpened,
  type GameDecisionResolveParams,
  type GameGoalSubmitParams,
  type GameInputReleased,
} from '@bellis/protocol';
import type { History } from './invariants.ts';

interface Lease {
  token: number;
  expiresAtMs: number;
}

interface Release extends GameInputReleased {
  held: string[];
  remaining: string[];
}

const instanceKey = (runtimeId: unknown, id: unknown) => JSON.stringify([runtimeId, id]);

/** 用宿主的授权、设备的实际账目及持久事实检查游戏链路。 */
export function checkGame(history: History): string[] {
  const violations: string[] = [];
  const held = new Set<string>();
  const holds = new Map<string, number>();
  const inputs = new Map<string, GameActionCommitted>();
  const durable = new Map(history.events.map((event) => [event.seq, event]));
  const authorized = new Map<number, string>();
  const executing = new Set<string>();
  const committed = new Set<string>();
  const resolved = new Map<string, GameDecisionResolveParams>();
  const selected = new Set<string>();
  const voting = new Set<string>();
  const votesEnded = new Map<string, string | undefined>();
  let bootFactSeq = 0;
  let intentFactSeq = 0;
  let host: Lease | undefined;
  let device: Lease | undefined;
  let goal: Pick<GameGoalSubmitParams, 'goalId' | 'expiresAtMs' | 'mode'> | undefined;
  let waiting: Pick<GameGoalSubmitParams, 'goalId' | 'expiresAtMs' | 'decisionPointId'> | undefined;
  let point: { key: string; factSeq: number; payload: GameDecisionPointOpened } | undefined;
  let resumeAt: number | undefined;
  let ttlMs = 0;
  let stopDue: number | undefined;
  let expiryRelease: { lease: Lease; dueAt: number } | undefined;
  const expiryViolation = '许可到期后超过许可时长仍有模拟输入未释放';

  const permitAt = (at: number): number | undefined =>
    host &&
    device &&
    host.token === device.token &&
    at < Math.min(host.expiresAtMs, device.expiresAtMs)
      ? device.token
      : undefined;
  const liveGoal = (at: number) => goal?.mode === 'autonomous' && at < goal.expiresAtMs;
  const canAdvance = (at: number) =>
    liveGoal(at) &&
    permitAt(at) !== undefined &&
    !waiting &&
    (!point || (point.payload.timing && at >= point.payload.timing.resolveByMs));
  const checkPacing = (at: number, includeNow = false) => {
    const reached = (due: number) => due < at || (includeNow && due === at);
    for (const [id, expiry] of holds) {
      if (!reached(expiry)) continue;
      violations.push(`模拟 hold 已过绝对到期时刻仍无解除证据 ${id}`);
      holds.delete(id);
    }
    if (resumeAt !== undefined && reached(resumeAt)) {
      if (canAdvance(resumeAt)) violations.push(`到 ${resumeAt}ms 仍未恢复等待 hold 解除的推进`);
      resumeAt = undefined;
    }
  };
  const checkCommand = (method: string, runtimeId: unknown, id: unknown, at: number) => {
    const key = JSON.stringify(['game', method, runtimeId, id]);
    if (!executing.delete(key)) violations.push(`游戏命令缺少本次启动中未使用的执行授权 ${key}`);
    if (permitAt(at) === undefined) violations.push(`没有双方有效许可却送达游戏命令 ${key}`);
  };
  const checkFact = (kind: string, { factSeq, ...traced }: Record<string, unknown>) => {
    const event = durable.get(Number(factSeq));
    if (
      event &&
      event.seq > bootFactSeq &&
      event.type === kind.slice(5) &&
      isDeepStrictEqual(event.data, traced)
    )
      return true;
    violations.push(`游戏追踪 ${kind} 缺少本次启动中相符的持久事实 ${factSeq}`);
    return false;
  };

  for (const { at, data, kind, seq } of history.trace) {
    checkPacing(at);
    if (stopDue !== undefined && at > stopDue) {
      violations.push('急停后超过许可时长仍有模拟输入未释放');
      stopDue = undefined;
    }
    if (expiryRelease && held.size > 0 && at > expiryRelease.dueAt) {
      violations.push(expiryViolation);
      expiryRelease = undefined;
    }
    if (kind.startsWith('fact.intent.')) {
      const event = durable.get(Number(data.factSeq));
      if (!event || event.seq <= intentFactSeq || event.type !== kind.slice(5)) {
        violations.push(`本次启动缺少顺序相符的游戏意图事实 ${data.factSeq}`);
        continue;
      }
      intentFactSeq = event.seq;
      const intent = event.data as {
        id: number;
        key: string;
        type: string;
        target: string;
        capabilities: string[];
      };
      if (event.type === 'intent.authorized') {
        if (
          intent.target.startsWith('game:') &&
          intent.capabilities.includes('game.goal') &&
          (intent.type === 'goal.submit' || intent.type === 'decision.resolve')
        )
          authorized.set(intent.id, intent.key);
      } else {
        const key = authorized.get(intent.id);
        if (key !== undefined) {
          if (event.type === 'intent.started') executing.add(key);
          else executing.delete(key);
        }
      }
      continue;
    }
    switch (kind) {
      case 'world.start':
        bootFactSeq = Number(data.factSeq ?? 0);
        intentFactSeq = bootFactSeq;
        authorized.clear();
        executing.clear();
        host = undefined;
        goal = undefined;
        waiting = undefined;
        point = undefined;
        resumeAt = undefined;
        break;
      case 'fact.decision_point.opened': {
        if (checkFact(kind, data)) {
          const payload = data.payload as GameDecisionPointOpened;
          const key = instanceKey(data.runtimeId, payload.decisionPointId);
          const factSeq = Number(data.factSeq);
          if (point?.key === key && factSeq <= point.factSeq)
            violations.push(`决策候选快照没有按持久化顺序观察 ${key}`);
          else point = { key, factSeq, payload };
        }
        break;
      }
      case 'game.candidates-unavailable': {
        if (point?.key === instanceKey(data.runtimeId, data.decisionPointId)) {
          point = { ...point, payload: { ...point.payload, candidates: [] } };
        }
        break;
      }
      case 'game.host-lease':
        host = typeof data.token === 'number' ? (data as unknown as Lease) : undefined;
        if (host) ttlMs = Number(data.ttlMs);
        break;
      case 'game.lease': {
        const received = data as unknown as Lease;
        if (!host || host.token !== received.token || host.expiresAtMs < received.expiresAtMs)
          violations.push(`模拟实时核收到安全核未授予的许可（追踪 ${seq}）`);
        const renewal =
          device &&
          expiryRelease?.lease === device &&
          device.token === received.token &&
          at < device.expiresAtMs;
        if (held.size === 0 || renewal) {
          expiryRelease = { lease: received, dueAt: received.expiresAtMs + ttlMs };
        } else {
          violations.push(`旧许可的模拟输入尚未释放就接纳了新许可（追踪 ${seq}）`);
        }
        device = received;
        break;
      }
      case 'control.stop':
        if (held.size > 0) stopDue ??= at + ttlMs;
        break;
      case 'game.device-release': {
        const release = data as unknown as Release;
        if (release.held.length !== held.size || release.held.some((key) => !held.has(key)))
          violations.push(`模拟释放与设备账目不符（追踪 ${seq}）`);
        if ((release.verification === 'verified') !== (release.remaining.length === 0))
          violations.push(`模拟释放核验与实际残留不符（追踪 ${seq}）`);
        if (
          release.reason === 'lease_expired' &&
          device &&
          (at < device.expiresAtMs || at > device.expiresAtMs + ttlMs)
        )
          violations.push(`模拟许可到期后未按时释放（追踪 ${seq}）`);
        held.clear();
        for (const key of release.remaining) held.add(key);
        if (held.size === 0) stopDue = undefined;
        if (release.reason !== 'deadline_expired') {
          device = undefined;
          goal = undefined;
          waiting = undefined;
          resumeAt = undefined;
          if (held.size === 0) expiryRelease = undefined;
        }
        break;
      }
      case 'game.input': {
        const { runtimeId, token, ...payload } = data;
        const action = payload as GameActionCommitted;
        const permit = permitAt(at);
        if (permit === undefined || permit !== token)
          violations.push(`没有有效许可却执行了模拟游戏输入（追踪 ${seq}）`);
        if (action.atMs !== Math.floor(at)) violations.push(`模拟输入时刻与设备动作不符 ${seq}`);
        const select = action.category === 'select';
        if (!select && [...holds.values()].some((expires) => expires > at))
          violations.push(`有效 hold 期间推进了模拟游戏（追踪 ${seq}）`);
        const active = select && waiting ? waiting : goal;
        if (
          !liveGoal(at) ||
          !active ||
          at >= active.expiresAtMs ||
          action.goalId !== active.goalId ||
          (!select && waiting)
        ) {
          violations.push(`没有有效目标却执行了模拟游戏输入（追踪 ${seq}）`);
        }
        const { selection } = action;
        if (select !== (selection !== null)) violations.push(`模拟输入与选择载荷不符 ${seq}`);
        if (select && selection) {
          const { decisionPointId, optionId, source } = selection;
          const key = instanceKey(runtimeId, decisionPointId);
          const decision = point?.key === key ? point.payload : undefined;
          if (selected.has(key)) violations.push(`设备重复执行决策选择 ${key}`);
          selected.add(key);
          if (!decision?.options.some((option) => option.id === optionId))
            violations.push(`设备选择不属于当前决策点 ${key}`);
          const timing = decision?.timing;
          if (source === 'default') {
            if (!timing || at < timing.resolveByMs || at >= timing.deadlineMs)
              violations.push(`设备默认选择不在计时余量窗口内 ${key}`);
            const first = decision?.candidates[0];
            if (first?.rank !== 1 || first.optionId !== optionId)
              violations.push(`设备默认选择不符合当前决策的首位候选 ${key}`);
          } else {
            const request = resolved.get(key);
            if (
              request?.source !== source ||
              request.optionId !== optionId ||
              (timing && at >= timing.resolveByMs)
            )
              violations.push(`设备选择没有相符且及时的 resolve ${key}`);
          }
          if (voting.has(key) && !votesEnded.has(key))
            violations.push(`绑定投票结束前设备已执行选择 ${key}`);
          if (
            source === 'vote' &&
            (timing ||
              waiting?.decisionPointId !== decisionPointId ||
              votesEnded.get(key) !== optionId)
          )
            violations.push(`设备选择不符合已结束的绑定投票 ${key}`);
          waiting = undefined;
          if (point?.key === key) point = undefined;
        }
        if (action.category === 'advance') resumeAt = undefined;
        held.add(action.category);
        const id = instanceKey(runtimeId, action.actionId);
        if (inputs.has(id)) violations.push(`设备动作编号被重复执行 ${id}`);
        inputs.set(id, action);
        break;
      }
      case 'game.goal': {
        checkCommand('goal.submit', data.runtimeId, data.goalId, at);
        if (data.accepted !== true) break;
        const submitted = data as unknown as GameGoalSubmitParams;
        if (submitted.mode === 'waiting_vote') {
          const key = instanceKey(data.runtimeId, submitted.decisionPointId);
          if (point?.key !== key || point.payload.timing || !liveGoal(at))
            violations.push(`投票等待缺少有效目标或无计时决策点 ${key}`);
          voting.add(key);
          waiting = submitted;
        } else {
          goal = submitted;
          waiting = undefined;
        }
        break;
      }
      case 'game.goal-expired':
        goal = undefined;
        waiting = undefined;
        resumeAt = undefined;
        break;
      case 'fact.vote.started': {
        const binding = data.game as { runtimeId: string } | undefined;
        if (binding && checkFact(kind, data))
          voting.add(instanceKey(binding.runtimeId, data.decisionPoint));
        break;
      }
      case 'fact.vote.ended': {
        const binding = data.game as { runtimeId: string; optionIds: string[] } | undefined;
        if (!binding || !checkFact(kind, data)) break;
        const key = instanceKey(binding.runtimeId, data.decisionPoint);
        const [winner] = data.winners as number[];
        votesEnded.set(
          key,
          data.outcome === 'winner' && winner !== undefined
            ? binding.optionIds[winner - 1]
            : undefined,
        );
        break;
      }
      case 'game.resolve': {
        checkCommand('decision.resolve', data.runtimeId, data.decisionPointId, at);
        const request = data as unknown as GameDecisionResolveParams;
        const key = instanceKey(data.runtimeId, request.decisionPointId);
        const decision = point?.key === key ? point.payload : undefined;
        if (!decision?.options.some((option) => option.id === request.optionId))
          violations.push(`resolve 不属于当前决策点和选项 ${key}`);
        if (decision?.timing && (request.source === 'vote' || at >= decision.timing.resolveByMs))
          violations.push(`resolve 不符合计时决策点的余量线 ${key}`);
        if (resolved.has(key)) violations.push(`决策实例重复收到 resolve ${key}`);
        resolved.set(key, request);
        if (voting.has(key) && !votesEnded.has(key)) violations.push(`投票结束前已发送决定 ${key}`);
        if (request.source === 'vote' && votesEnded.get(key) !== request.optionId)
          violations.push(`收到的决定与绑定投票的胜出选项不符 ${key}`);
        break;
      }
      case 'fact.action.committed': {
        const action = data.payload as GameActionCommitted;
        const id = `game:${data.runtimeId}:${action.actionId}:comment`;
        const actual = inputs.get(instanceKey(data.runtimeId, action.actionId));
        if (
          !checkFact(kind, data) ||
          data.role !== GameBridgeRole.Main ||
          !isDeepStrictEqual(actual, action) ||
          committed.has(id)
        )
          violations.push(`已确认动作与先前设备输入不符 ${action.actionId}`);
        else committed.add(id);
        break;
      }
      case 'speech.requested': {
        const id = String(data.id);
        if (id.startsWith('game:') && id.endsWith(':comment') && !committed.has(id))
          violations.push(`已确认动作事实之前请求了解说 ${id}`);
        break;
      }
      case 'game.hold':
        holds.set(String(data.holdId), Number(data.expiresAtMs));
        if (resumeAt !== undefined) resumeAt = Math.max(resumeAt, Number(data.expiresAtMs));
        break;
      case 'game.advance-requested':
        if (canAdvance(at) && [...holds.values()].some((expiry) => expiry > at))
          resumeAt = Math.max(...holds.values());
        break;
      case 'game.hold-end': {
        const id = String(data.holdId);
        if (data.reason === 'expired' && at !== holds.get(id))
          violations.push(`hold 未在绝对到期时刻解除 ${id}`);
        holds.delete(id);
        if (resumeAt !== undefined) resumeAt = Math.max(at, ...holds.values());
        break;
      }
    }
  }
  const endAt = history.trace.at(-1)?.at ?? 0;
  checkPacing(endAt, true);
  if (stopDue !== undefined) violations.push('急停后缺少释放模拟输入的证据');
  if (expiryRelease && held.size > 0 && endAt >= expiryRelease.dueAt)
    violations.push(expiryViolation);
  return violations;
}
