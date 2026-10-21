import { createHash } from 'node:crypto';
import type { Projection, StoredEvent } from '@bellis/store';

/** 记忆的事实类型。 */
export const MemoryFact = {
  /** 本状态存储的去重键前缀（随机，记一次）：换了数据库、序号从头开始，也不会撞上 Iris 里旧的去重键。 */
  Epoch: 'memory.epoch',
  /** 进入待发队列：一条要写入 Iris 的消息（已过隐私网关）。去重键由这条事实确定地派生（{@link dedupeKey}）。 */
  Queued: 'memory.queued',
  /** Iris 已接收（含按去重键返回原消息的重试）：从待发队列移除。 */
  Written: 'memory.written',
  /** 不写了：队列满时丢弃最旧的（`overflow`）、Iris 拒收这一条（`rejected`）、隐私规则改了之后拦下（`privacy`）。 */
  Dropped: 'memory.dropped',
  /** 没进队列：隐私网关或注入检测拦下。只记类别与来源编号，不记内容。 */
  Filtered: 'memory.filtered',
  /** 操作员登记的本地墓碑：这名观众的待发写入立即移除，此后不写入、相关的召回不用。 */
  Tombstoned: 'memory.tombstoned',
} as const;

export type QueuedKind = 'message' | 'self_output';

/** 待发队列里的一条。 */
export interface QueuedItem {
  /** `memory.queued` 的序号。 */
  seq: number;
  /** 记下的时刻（墙钟毫秒），写入时作 `occurred_at`。 */
  at: number;
  kind: QueuedKind;
  /** 来源：弹幕的平台消息编号，或发言编号。 */
  ref: string;
  /** 观众的平台稳定 ID；角色自己的发言为 null。 */
  account: string | null;
  sender: string;
  content: string;
}

/** 记忆账本：由记忆的事实归约，宿主与仿真打开状态存储时注册，重启时从事件重建。 */
export interface MemoryLedger {
  epoch: string | null;
  /** 待发队列，按序号先后。 */
  outbox: readonly QueuedItem[];
  /** 登记了墓碑的观众（平台稳定 ID），排好序。 */
  tombstones: readonly string[];
  /** 累计写入与丢弃的条数（不含墓碑移除的）。 */
  written: number;
  dropped: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const seqsOf = (data: Record<string, unknown>): Set<number> =>
  new Set(Array.isArray(data.seqs) ? data.seqs.filter((s) => typeof s === 'number') : []);

/** 平台稳定 ID 是否像样：1–128 个可打印 ASCII，不含空白。墓碑与写入都只认这种写法。 */
export function validAccount(account: string): boolean {
  return /^[\x21-\x7e]{1,128}$/.test(account);
}

function queued(event: StoredEvent): QueuedItem | undefined {
  const d = event.data;
  if (!isRecord(d)) return undefined;
  const { kind, ref, account, sender, content } = d;
  if (kind !== 'message' && kind !== 'self_output') return undefined;
  if (typeof ref !== 'string' || typeof sender !== 'string' || typeof content !== 'string')
    return undefined;
  if (account !== null && (typeof account !== 'string' || !validAccount(account))) return undefined;
  return { seq: event.seq, at: event.recordedAt, kind, ref, account, sender, content };
}

export const memoryLedger: Projection<MemoryLedger> = {
  name: 'memory.ledger',
  initial: { epoch: null, outbox: [], tombstones: [], written: 0, dropped: 0 },
  reduce(state, event) {
    const data = isRecord(event.data) ? event.data : {};
    switch (event.type) {
      case MemoryFact.Epoch:
        return state.epoch === null && typeof data.id === 'string'
          ? { ...state, epoch: data.id }
          : state;
      case MemoryFact.Queued: {
        const item = queued(event);
        if (!item || (item.account !== null && state.tombstones.includes(item.account)))
          return state;
        return { ...state, outbox: [...state.outbox, item] };
      }
      case MemoryFact.Written:
      case MemoryFact.Dropped: {
        const seqs = seqsOf(data);
        const outbox = state.outbox.filter((item) => !seqs.has(item.seq));
        const removed = state.outbox.length - outbox.length;
        if (removed === 0) return state;
        return event.type === MemoryFact.Written
          ? { ...state, outbox, written: state.written + removed }
          : { ...state, outbox, dropped: state.dropped + removed };
      }
      case MemoryFact.Tombstoned: {
        const account = data.account;
        if (typeof account !== 'string' || !validAccount(account)) return state;
        const tombstones = state.tombstones.includes(account)
          ? state.tombstones
          : [...state.tombstones, account].sort();
        return {
          ...state,
          tombstones,
          outbox: state.outbox.filter((item) => item.account !== account),
        };
      }
      default:
        return state;
    }
  },
};

/**
 * 去重键，由排队的事实确定地派生，重试与重启后补发沿用同一个键：
 * - 观众的弹幕：本状态存储的前缀加平台消息编号（`bellis:<前缀>:m:<编号>`）。平台重发同一条弹幕
 *   （断线重连、宿主重启之后）得到同一个键，Iris 按键返回原消息，不会写两次；
 * - 角色的发言（以及编号太长或含空白、控制字符的弹幕）：前缀加 `memory.queued` 的序号
 *   （`bellis:<前缀>:<序号>`）。同一句话说了两次是两段发言，各写一次。
 */
export function dedupeKey(epoch: string, item: Pick<QueuedItem, 'seq' | 'kind' | 'ref'>): string {
  if (item.kind === 'message' && /^[\x21-\x7e]{1,200}$/.test(item.ref)) {
    return `bellis:${epoch}:m:${item.ref}`;
  }
  return `bellis:${epoch}:${item.seq}`;
}

/**
 * 观众写进 Iris 的显示名：由平台稳定 ID 派生的代号（`观众` 加 8 位十六进制），不用昵称。
 * Iris 的记忆按写入时的显示名记说话人与涉及的人，墓碑据此认出这名观众的记忆。
 */
export function pseudonym(account: string): string {
  return `观众${pseudonymCode(account)}`;
}

/** 代号里的 8 位十六进制（小写）。 */
export function pseudonymCode(account: string): string {
  return createHash('sha256').update(`bellis.viewer:${account}`).digest('hex').slice(0, 8);
}

/** 操作员登记墓碑的事实（宿主与仿真共用）；平台稳定 ID 不像样时为 undefined。 */
export function tombstoneFact(
  account: string,
  platform?: string,
): { type: string; data: Record<string, unknown> } | undefined {
  if (!validAccount(account)) return undefined;
  return {
    type: MemoryFact.Tombstoned,
    data: { account, ...(platform === undefined ? {} : { platform }), by: 'operator' },
  };
}
