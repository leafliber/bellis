import { createHash, createHmac } from 'node:crypto';

/** 开放平台的访问密钥（`secret:bilibili`，JSON `{"accessKeyId": "…", "accessKeySecret": "…"}`）。 */
export interface Credentials {
  accessKeyId: string;
  accessKeySecret: string;
}

/** 参与签名的头，按键名字典序排列。 */
export const SIGNED_HEADERS = [
  'x-bili-accesskeyid',
  'x-bili-content-md5',
  'x-bili-signature-method',
  'x-bili-signature-nonce',
  'x-bili-signature-version',
  'x-bili-timestamp',
] as const;

/** 待签名串：参与签名的头按键名字典序拼成 `键:值`，以 `\n` 连接，首尾不加换行。 */
export function canonicalString(headers: Readonly<Record<string, string>>): string {
  return Object.keys(headers)
    .sort()
    .map((key) => `${key}:${headers[key]}`)
    .join('\n');
}

export function md5Hex(body: string): string {
  return createHash('md5').update(body, 'utf8').digest('hex');
}

/**
 * 按开放平台的签名鉴权给一个请求生成请求头：六个 `x-bili-*` 头参与签名，用 access_key_secret 做 HMAC-SHA256，
 * 小写十六进制放进 `Authorization`；另带 `Accept` 与 `Content-Type`（不参与签名）。
 *
 * `x-bili-timestamp` 按文档用**秒**（官方 JS 示例用了毫秒，与文档矛盾；社区实现用秒。真机核对前 PENDING）。
 * 与服务器的时间差不能超过 10 分钟。`nonce` 每次请求唯一。
 *
 * 返回的头含签名与访问密钥 ID：只用于发出请求，不写日志。
 */
export function signedHeaders(
  body: string,
  credentials: Credentials,
  timestampSeconds: number,
  nonce: string,
): Record<string, string> {
  const signed: Record<(typeof SIGNED_HEADERS)[number], string> = {
    'x-bili-accesskeyid': credentials.accessKeyId,
    'x-bili-content-md5': md5Hex(body),
    'x-bili-signature-method': 'HMAC-SHA256',
    'x-bili-signature-nonce': nonce,
    'x-bili-signature-version': '1.0',
    'x-bili-timestamp': String(Math.floor(timestampSeconds)),
  };
  const signature = createHmac('sha256', credentials.accessKeySecret)
    .update(canonicalString(signed), 'utf8')
    .digest('hex');
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    ...signed,
    Authorization: signature,
  };
}
