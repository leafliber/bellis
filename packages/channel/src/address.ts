import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelError } from './errors.ts';

/** 本次会话的通道地址与共享密钥（R-05）。子进程经环境变量获得，非子进程从 SecretStore 读取（R-23）。 */
export interface ChannelCredentials {
  path: string;
  key: Uint8Array;
}

export const SESSION_KEY_BYTES = 32;
const SESSION_ID = /^[a-z0-9]{1,16}$/;
/** macOS 的 sun_path 为 104 字节（含结尾 NUL），取各平台中最小者。 */
const MAX_UDS_PATH_BYTES = 103;
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** RFC 4648 base32，小写、无填充。Windows 管道名与 macOS 文件名不区分大小写，所以不用 base64。 */
function base32(bytes: Uint8Array): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/**
 * 生成本次会话的通道地址：`bellis-<会话>-<128 位随机数>`。
 * Windows 为命名管道 `\\.\pipe\…`，其它平台为系统临时目录下的 UDS。
 */
export function createChannelPath(sessionId: string, platform = process.platform): string {
  if (!SESSION_ID.test(sessionId)) {
    throw new ChannelError('address-invalid', `会话编号须匹配 ${SESSION_ID}`);
  }
  const name = `bellis-${sessionId}-${base32(randomBytes(16))}`;
  if (platform === 'win32') return `\\\\.\\pipe\\${name}`;
  const path = join(tmpdir(), `${name}.sock`);
  if (Buffer.byteLength(path) > MAX_UDS_PATH_BYTES) {
    throw new ChannelError('address-invalid', `UDS 路径超过 ${MAX_UDS_PATH_BYTES} 字节：${path}`);
  }
  return path;
}

export function createSessionKey(): Buffer {
  return randomBytes(SESSION_KEY_BYTES);
}

export function encodeSessionKey(key: Uint8Array): string {
  return Buffer.from(key).toString('base64url');
}

export function decodeSessionKey(text: string): Buffer {
  const key = Buffer.from(text, 'base64url');
  if (key.length !== SESSION_KEY_BYTES || encodeSessionKey(key) !== text) {
    throw new ChannelError('address-invalid', '会话密钥格式不正确');
  }
  return key;
}
