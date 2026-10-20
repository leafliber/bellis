import { egressAllowed, egressPermission } from '@bellis/kernel';

/** 本机回环地址：只有这些主机可以不加密（本机测试用）。 */
const LOOPBACK = new Set(['127.0.0.1', '[::1]', 'localhost']);

function blocker(
  address: string,
  secure: string,
  plain: string,
  permissions: ReadonlySet<string>,
): string | undefined {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return '地址不合法';
  }
  if (url.protocol !== secure && !(url.protocol === plain && LOOPBACK.has(url.hostname))) {
    return `须为 ${secure}//（本机测试除外）`;
  }
  if (!egressAllowed(url.hostname, permissions)) {
    return `未授予权限 ${egressPermission(url.hostname)}`;
  }
  return undefined;
}

/** 接口基址为什么不能连；能连时返回 undefined。须为 https://（本机回环除外），主机已授予外发。 */
export function endpointBlocker(
  endpoint: string,
  permissions: ReadonlySet<string>,
): string | undefined {
  return blocker(endpoint, 'https:', 'http:', permissions);
}

/** 长连接地址为什么不能连；能连时返回 undefined。须为 wss://（本机回环除外），主机已授予外发（可用子域名通配）。 */
export function linkBlocker(link: string, permissions: ReadonlySet<string>): string | undefined {
  return blocker(link, 'wss:', 'ws:', permissions);
}

/** 写日志用的主机名（含端口）；地址不合法时为 `?`。 */
export function hostOf(address: string): string {
  try {
    return new URL(address).host.slice(0, 255);
  } catch {
    return '?';
  }
}
