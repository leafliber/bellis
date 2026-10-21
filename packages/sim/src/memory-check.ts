import { dedupeKey, MemoryFact, type QueuedKind, type SimIrisMessage } from '@bellis/memory';
import type { History } from './invariants.ts';

interface Queued {
  seq: number;
  kind: QueuedKind;
  ref: string;
  account: string | null;
  content: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

const numbers = (value: unknown): number[] =>
  Array.isArray(value) ? value.filter((v): v is number => typeof v === 'number') : [];

/**
 * 记忆的不变量（见记忆、运维“确定性仿真”）。没有启用记忆的场景（没有 `memory.epoch`）不检查。
 *
 * 1. 写入的发言恰好是写回的部分：Iris 存下的每条角色发言，内容等于同一发言编号的 `utterance.played` 里观众
 *    听到的部分；反过来，每段有人听到的发言恰好排队一次或被隐私网关拦下一次。Iris 存下的每条消息都对得上
 *    `memory.queued`（去重键由它确定地派生），内容、类型与平台 ID 一致。
 * 2. 同一事实不重复写入（含跨重启）：同一个去重键在 Iris 里至多一条消息；同一条弹幕（平台消息编号）在 Iris 里
 *    至多一条消息，平台重发也一样；同一段发言至多排队一次；记为已写入的都真的在 Iris 里。
 * 3. 墓碑：登记之后，这名观众的消息不再排队、不再发出；召回进入上下文的记忆不含他写入 Iris 的消息。
 */
export function checkMemory(history: History): string[] {
  const violations: string[] = [];
  const epochEvent = history.events.find((e) => e.type === MemoryFact.Epoch);
  if (!epochEvent) return violations;
  const epoch = isRecord(epochEvent.data) ? String(epochEvent.data.id) : '';

  /** 去重键 → 排队的事实（平台重发的同一条弹幕共用一个键）。 */
  const byKey = new Map<string, Queued[]>();
  const keyOfSeq = new Map<number, string>();
  const heard = new Map<string, string[]>();
  const filteredSpeech = new Map<string, number>();
  const written = new Set<number>();
  for (const event of history.events) {
    const data = isRecord(event.data) ? event.data : {};
    if (event.type === MemoryFact.Queued) {
      const item: Queued = {
        seq: event.seq,
        kind: data.kind === 'self_output' ? 'self_output' : 'message',
        ref: String(data.ref),
        account: typeof data.account === 'string' ? data.account : null,
        content: String(data.content),
      };
      const key = dedupeKey(epoch, item);
      keyOfSeq.set(event.seq, key);
      byKey.set(key, [...(byKey.get(key) ?? []), item]);
    } else if (event.type === 'utterance.played' && typeof data.heard === 'string') {
      if (data.heard !== '') {
        const id = String(data.id);
        heard.set(id, [...(heard.get(id) ?? []), data.heard]);
      }
    } else if (event.type === MemoryFact.Filtered && data.source === 'speech') {
      const ref = String(data.ref);
      filteredSpeech.set(ref, (filteredSpeech.get(ref) ?? 0) + 1);
    } else if (event.type === MemoryFact.Written) {
      for (const seq of numbers(data.seqs)) written.add(seq);
    }
  }

  // Iris 存下的消息（模拟 Iris 在存下时写进追踪）。
  const stored: SimIrisMessage[] = history.trace
    .filter((entry) => entry.kind === 'iris.write')
    .flatMap((entry) =>
      Array.isArray(entry.data.stored) ? (entry.data.stored as SimIrisMessage[]) : [],
    );
  const storedKeys = new Map<string, number>();
  const storedDanmaku = new Map<string, number>();
  const accountOfMessage = new Map<number, string | null>();
  for (const message of stored) {
    accountOfMessage.set(message.id, message.account);
    storedKeys.set(message.dedupeKey, (storedKeys.get(message.dedupeKey) ?? 0) + 1);
    const source = byKey.get(message.dedupeKey)?.[0];
    if (!source) {
      violations.push(`Iris 存下的消息 ${message.dedupeKey} 对不上任何 memory.queued`);
      continue;
    }
    if (
      message.content !== source.content ||
      message.kind !== source.kind ||
      message.account !== source.account
    ) {
      violations.push(`Iris 存下的消息 ${message.dedupeKey} 与排队时的内容、类型或平台 ID 不一致`);
    }
    if (source.kind === 'self_output' && !(heard.get(source.ref) ?? []).includes(source.content)) {
      violations.push(`写入的发言 ${source.ref} 不是观众实际听到的部分（写回）`);
    }
    if (source.kind === 'message') {
      storedDanmaku.set(source.ref, (storedDanmaku.get(source.ref) ?? 0) + 1);
    }
  }

  // 每段有人听到的发言恰好排队一次或被拦下一次。
  const queuedSpeech = new Map<string, number>();
  for (const list of byKey.values()) {
    for (const item of list) {
      if (item.kind === 'self_output') {
        queuedSpeech.set(item.ref, (queuedSpeech.get(item.ref) ?? 0) + 1);
      }
    }
  }
  for (const [id, list] of heard) {
    const handled = (queuedSpeech.get(id) ?? 0) + (filteredSpeech.get(id) ?? 0);
    if (handled !== list.length) {
      violations.push(`发言 ${id} 有 ${list.length} 段写回，排队与拦下共 ${handled} 次`);
    }
  }
  for (const id of queuedSpeech.keys()) {
    if (!heard.has(id)) violations.push(`排队写入的发言 ${id} 没有人听到`);
  }
  for (const [key, count] of storedKeys) {
    if (count > 1) violations.push(`去重键 ${key} 在 Iris 里存了 ${count} 条`);
  }
  for (const [ref, count] of storedDanmaku) {
    if (count > 1) violations.push(`弹幕 ${ref} 在 Iris 里存了 ${count} 条`);
  }
  for (const seq of written) {
    const key = keyOfSeq.get(seq);
    if (key === undefined || !storedKeys.has(key)) {
      violations.push(`memory.queued ${seq} 记为已写入，Iris 里却没有`);
    }
  }

  // 墓碑：按追踪的先后。
  const tombstoned = new Set<string>();
  for (const entry of history.trace) {
    if (entry.kind === `fact.${MemoryFact.Tombstoned}` && typeof entry.data.account === 'string') {
      tombstoned.add(entry.data.account);
    } else if (entry.kind === `fact.${MemoryFact.Queued}`) {
      const account = entry.data.account;
      if (typeof account === 'string' && tombstoned.has(account)) {
        violations.push(
          `登记墓碑之后，观众 ${account} 的弹幕仍进了待发队列（第 ${entry.seq} 条追踪）`,
        );
      }
    } else if (entry.kind === 'memory.write-sent') {
      for (const key of strings(entry.data.keys)) {
        for (const item of byKey.get(key) ?? []) {
          if (item.account !== null && tombstoned.has(item.account)) {
            violations.push(
              `登记墓碑之后，观众 ${item.account} 的消息仍发给了 Iris（第 ${entry.seq} 条追踪）`,
            );
          }
        }
      }
    } else if (entry.kind === 'memory.recalled') {
      for (const id of numbers(entry.data.irisIds)) {
        const account = accountOfMessage.get(id) ?? null;
        if (account !== null && tombstoned.has(account)) {
          violations.push(
            `登记墓碑之后，观众 ${account} 的记忆仍进了上下文（第 ${entry.seq} 条追踪）`,
          );
        }
      }
    }
  }
  return violations;
}
