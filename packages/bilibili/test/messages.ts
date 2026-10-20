import assert from 'node:assert/strict';
import { ANCHOR_NAME, AUTH_MARKER, type Command } from './fake-platform.ts';
import { ACCESS_KEY_ID, ACCESS_KEY_SECRET, IDENTITY_CODE } from './helpers.ts';

/** 观众昵称、弹幕正文、头像里带的标记：核对它们不出现在日志里。 */
export const NICK = 'NICKMARK观众';
export const TEXT = 'TEXTMARK弹幕';
export const FACE = 'https://i0.hdslb.com/bfs/face/FACEMARK.jpg';

export function dm(n: number, extra: Record<string, unknown> = {}): Command {
  return {
    cmd: 'LIVE_OPEN_PLATFORM_DM',
    data: {
      room_id: 1001,
      open_id: `viewer-${n}`,
      uid: 0,
      uname: `${NICK}${n}`,
      uface: FACE,
      msg: `${TEXT}${n}`,
      msg_id: `msg-${n}`,
      timestamp: 1_700_000_000 + n,
      dm_type: 0,
      emoji_img_url: '',
      guard_level: 0,
      fans_medal_level: 3,
      fans_medal_name: 'MEDAL',
      fans_medal_wearing_status: true,
      ...extra,
    },
  };
}

export function command(cmd: string, data: Record<string, unknown>): Command {
  return { cmd: `LIVE_OPEN_PLATFORM_${cmd}`, data };
}

/** 日志里不得出现弹幕正文、昵称、头像、auth_body、签名、身份码与密钥。 */
export function assertCleanLogs(logs: ReadonlyArray<{ event: string; fields: unknown }>): void {
  const text = JSON.stringify(logs);
  for (const marker of [
    NICK,
    TEXT,
    'FACEMARK',
    ACCESS_KEY_ID,
    ACCESS_KEY_SECRET,
    IDENTITY_CODE,
    AUTH_MARKER,
    ANCHOR_NAME,
  ]) {
    assert.ok(!text.includes(marker), `日志里出现了 ${marker}`);
  }
  assert.doesNotMatch(text, /[0-9a-f]{64}/, '日志里出现了疑似签名');
}
