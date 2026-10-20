import type { Danmaku } from '@bellis/audience';
import type { LinkCommand } from './link.ts';

/** 开放平台长连接的消息命令（场次失效 `INTERACTION_END` 由客户端处理，见 client.ts）。 */
export const Cmd = {
  Danmaku: 'LIVE_OPEN_PLATFORM_DM',
  Gift: 'LIVE_OPEN_PLATFORM_SEND_GIFT',
  SuperChat: 'LIVE_OPEN_PLATFORM_SUPER_CHAT',
  SuperChatDeleted: 'LIVE_OPEN_PLATFORM_SUPER_CHAT_DEL',
  Guard: 'LIVE_OPEN_PLATFORM_GUARD',
  Like: 'LIVE_OPEN_PLATFORM_LIKE',
  RoomEnter: 'LIVE_OPEN_PLATFORM_LIVE_ROOM_ENTER',
  LiveStart: 'LIVE_OPEN_PLATFORM_LIVE_START',
  LiveEnd: 'LIVE_OPEN_PLATFORM_LIVE_END',
} as const;

/** 接入插件写的持久事实。 */
export const FactType = {
  Danmaku: 'danmaku.received',
  Gift: 'gift.received',
  SuperChat: 'superchat.received',
  SuperChatDeleted: 'superchat.deleted',
  Guard: 'guard.bought',
  Like: 'like.received',
  LiveStarted: 'live.started',
  LiveEnded: 'live.ended',
  GapStarted: 'danmaku.gap-started',
  GapEnded: 'danmaku.gap-ended',
} as const;

export const PLATFORM = 'bilibili';

/** 弹幕类型：0 普通弹幕，1 表情包弹幕。 */
export const DanmakuType = { Text: 0, Emoji: 1 } as const;

export type IntakeKind =
  | 'danmaku'
  | 'emoji'
  | 'gift'
  | 'superchat'
  | 'superchat-deleted'
  | 'guard'
  | 'like'
  | 'enter'
  | 'live-start'
  | 'live-end'
  | 'duplicate'
  | 'malformed'
  | 'unknown';

export interface Fact {
  type: string;
  data: Record<string, unknown>;
}

export interface IntakeResult {
  kind: IntakeKind;
  /** 要写的持久事实。 */
  fact?: Fact;
  /** 要交给分诊的弹幕。 */
  danmaku?: Danmaku;
}

/** 存进事实的不可信文本（昵称、弹幕正文）的上限（码点）。 */
const MAX_TEXT = 500;
const MAX_ID = 128;

function text(value: unknown): string {
  if (typeof value !== 'string') return '';
  const points = [...value];
  return points.length > MAX_TEXT ? points.slice(0, MAX_TEXT).join('') : value;
}

function id(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string' || value === '' || value.length > MAX_ID) return undefined;
  return value;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * 把长连接的消息转成持久事实与要交给分诊的弹幕。消息里的昵称、头像、正文都是不可信输入，只作数据存，
 * 不解析；头像、粉丝勋章等用不到的字段不存。
 *
 * - 按平台消息编号 `msg_id` 去重（重连后平台可能重发），只记得最近 `capacity` 条。
 * - 普通弹幕（`dm_type` 为 0 或缺失）写 `danmaku.received` 后交给分诊；表情包弹幕（1）与未知类型只写事实
 *   （`delivered: false`）：分诊与投票的输入是观众打出的文字，表情包的 `msg` 是表情的名称。
 * - 礼物、SC、SC 删除、大航海、点赞、开播、下播只写事实，不交给分诊；进入房间只计数。
 */
export class Intake {
  readonly #capacity: number;
  readonly #seen = new Set<string>();

  constructor(capacity: number) {
    this.#capacity = capacity;
  }

  accept(command: LinkCommand, receivedAt: number): IntakeResult {
    const data = record(command.data);
    const msgId = id(data.msg_id);
    if (msgId !== undefined) {
      if (this.#seen.has(msgId)) return { kind: 'duplicate' };
    }
    const result = this.#interpret(command.cmd, data, msgId, receivedAt);
    if (msgId !== undefined && result.kind !== 'malformed' && result.kind !== 'unknown') {
      this.#remember(msgId);
    }
    return result;
  }

  #remember(msgId: string): void {
    this.#seen.add(msgId);
    if (this.#seen.size <= this.#capacity) return;
    const oldest = this.#seen.values().next().value;
    if (oldest !== undefined) this.#seen.delete(oldest);
  }

  #interpret(
    cmd: string,
    data: Record<string, unknown>,
    msgId: string | undefined,
    receivedAt: number,
  ): IntakeResult {
    const common = {
      platform: PLATFORM,
      msgId,
      platformTimestamp: num(data.timestamp),
      receivedAt,
    };
    switch (cmd) {
      case Cmd.Danmaku: {
        const openId = id(data.open_id);
        if (msgId === undefined || openId === undefined) return { kind: 'malformed' };
        const dmType = num(data.dm_type) ?? DanmakuType.Text;
        const delivered = dmType === DanmakuType.Text;
        const nickname = text(data.uname);
        const body = text(data.msg);
        const fact: Fact = {
          type: FactType.Danmaku,
          data: { ...common, openId, nickname, text: body, dmType, delivered },
        };
        if (!delivered) return { kind: 'emoji', fact };
        return {
          kind: 'danmaku',
          fact,
          danmaku: { id: msgId, viewer: openId, nickname, text: body },
        };
      }
      case Cmd.Gift:
        return {
          kind: 'gift',
          fact: {
            type: FactType.Gift,
            data: {
              ...common,
              openId: id(data.open_id),
              giftId: num(data.gift_id),
              giftName: text(data.gift_name),
              count: num(data.gift_num),
              /** 实际价值（单价，1000 = 1 元）。 */
              unitPrice: num(data.r_price),
              paid: data.paid === true,
            },
          },
        };
      case Cmd.SuperChat:
        return {
          kind: 'superchat',
          fact: {
            type: FactType.SuperChat,
            data: {
              ...common,
              openId: id(data.open_id),
              superChatId: id(data.message_id),
              /** 支付金额（元）。 */
              rmb: num(data.rmb),
            },
          },
        };
      case Cmd.SuperChatDeleted: {
        const ids = Array.isArray(data.message_ids)
          ? data.message_ids.map(id).filter((v) => v !== undefined)
          : [];
        return {
          kind: 'superchat-deleted',
          fact: { type: FactType.SuperChatDeleted, data: { ...common, superChatIds: ids } },
        };
      }
      case Cmd.Guard:
        return {
          kind: 'guard',
          fact: {
            type: FactType.Guard,
            data: {
              ...common,
              openId: id(record(data.user_info).open_id),
              guardLevel: num(data.guard_level),
              count: num(data.guard_num),
              unit: text(data.guard_unit).slice(0, 16),
              /** 金瓜子（1000 = 1 元）。 */
              price: num(data.price),
            },
          },
        };
      case Cmd.Like:
        return {
          kind: 'like',
          fact: {
            type: FactType.Like,
            data: { ...common, openId: id(data.open_id), count: num(data.like_count) },
          },
        };
      case Cmd.LiveStart:
        return {
          kind: 'live-start',
          fact: { type: FactType.LiveStarted, data: { ...common, roomId: num(data.room_id) } },
        };
      case Cmd.LiveEnd:
        return {
          kind: 'live-end',
          fact: { type: FactType.LiveEnded, data: { ...common, roomId: num(data.room_id) } },
        };
      case Cmd.RoomEnter:
        return { kind: 'enter' };
      default:
        return { kind: 'unknown' };
    }
  }
}
