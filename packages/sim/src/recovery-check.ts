import type { History } from './invariants.ts';

/** 授权时记下的意图（`intent.authorized`）：类型、目标与能力。 */
interface Authorized {
  type: string;
  target: string;
  capabilities: string[];
}

const isSpeech = (intent: Authorized | undefined) =>
  intent?.type === 'speech.play' &&
  intent.target === 'stage' &&
  intent.capabilities.length === 1 &&
  intent.capabilities[0] === 'speech.output';

/** 一次恢复在同一个事务里连着写的事实。 */
const RECOVERY = new Set(['intent.abandoned', 'intent.orphaned', 'intent.interrupted']);

/**
 * 重启与结案的不变量（见状态存储“重启”，含跨重启）：
 * 1. 重启时停在执行中的 Stage 发言在恢复时当场结案（同一次恢复里 `intent.orphaned` 之后有同一意图的
 *    `intent.interrupted`），不再停在结果未知；别的意图不会被这样结案。所以重启后发言能恢复：从没有发言因为
 *    Stage 目标被隔离而被拒；
 * 2. 其余结果未知的意图在对账或操作员结案（`intent.reconciled`）之前，它的目标上没有新的意图被授权或开始执行。
 */
export function checkRecovery(history: History): string[] {
  const violations: string[] = [];
  const intents = new Map<number, Authorized>();
  /** 每个目标上结果未知、还没结案的意图。 */
  const unknown = new Map<string, Set<number>>();
  /** 这一次恢复里标为结果未知、还要看有没有当场结案的发言意图。 */
  const orphanedSpeech = new Set<number>();
  const busy = (target: string | undefined) =>
    target !== undefined && (unknown.get(target)?.size ?? 0) > 0;

  for (const event of history.events) {
    const data = event.data as Record<string, unknown>;
    const id = Number(data.id);
    // 恢复的事实连着写；之后的第一条别的事实之前，停在执行中的发言意图都应已结案。
    if (!RECOVERY.has(event.type) && orphanedSpeech.size > 0) {
      const ids = [...orphanedSpeech].join('、');
      violations.push(
        `重启时停在执行中的发言意图 ${ids} 没有当场结案（第 ${event.seq} 条事件之前）`,
      );
      orphanedSpeech.clear();
    }
    switch (event.type) {
      case 'intent.authorized': {
        const target = String(data.target);
        intents.set(id, {
          type: String(data.type),
          target,
          capabilities: (data.capabilities as string[] | undefined) ?? [],
        });
        if (busy(target))
          violations.push(
            `目标 ${target} 有结果未知的意图，却授权了意图 ${id}（第 ${event.seq} 条事件）`,
          );
        break;
      }
      case 'intent.started': {
        const target = intents.get(id)?.target;
        if (busy(target))
          violations.push(
            `目标 ${target} 有结果未知的意图，却开始执行了意图 ${id}（第 ${event.seq} 条事件）`,
          );
        break;
      }
      case 'intent.orphaned': {
        const target = String(data.target);
        const set = unknown.get(target) ?? new Set<number>();
        set.add(id);
        unknown.set(target, set);
        if (isSpeech(intents.get(id))) orphanedSpeech.add(id);
        break;
      }
      case 'intent.interrupted':
        if (!orphanedSpeech.delete(id))
          violations.push(
            `意图 ${id} 不是重启时停在执行中的发言，却被自动结案（第 ${event.seq} 条事件）`,
          );
        unknown.get(String(data.target))?.delete(id);
        break;
      case 'intent.reconciled': {
        const target = intents.get(id)?.target;
        if (target !== undefined) unknown.get(target)?.delete(id);
        break;
      }
      case 'intent.denied':
        if (data.target === 'stage' && String(data.reason ?? '').includes('隔离'))
          violations.push(
            `发言因 Stage 目标被隔离而被拒（第 ${event.seq} 条事件）：重启后发言没有恢复`,
          );
        break;
    }
  }
  if (orphanedSpeech.size > 0)
    violations.push(`重启时停在执行中的发言意图 ${[...orphanedSpeech].join('、')} 没有当场结案`);
  return violations;
}
