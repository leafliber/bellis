import type { Clock } from './clock.ts';
import type { Random } from './random.ts';
import { defineService } from './service.ts';

/** 宿主提供的时钟。插件的一切计时都经过它，`sim` profile 换成确定性的时钟（R-07）。 */
export const ClockService = defineService<Clock>('clock', 1);

/** 宿主提供的随机数，`sim` profile 换成由种子驱动的实现（R-07）。 */
export const RandomService = defineService<Random>('random', 1);

/**
 * 仿真追踪：确定性仿真里各部分按发生顺序写入同一条追踪，供不变量检查。
 * 只在仿真中提供；插件以可选依赖使用，真实运行时不存在。
 */
export interface Trace {
  record(kind: string, data: Record<string, unknown>): void;
}

export const TraceService = defineService<Trace>('trace', 1);

/**
 * 宿主提供给插件的凭据（按实例隔离）：插件只能读写 profile 授予它的条目，权限写成 `secret:<名字>`。
 * 值不写日志、不进事件。按 Rule of Two，解读观众输入或据此作决定的插件不授予任何凭据；
 * 只负责收发的接入插件只授予它自己那一家服务的凭据（见插件内核“权限”）。
 */
export interface PluginSecrets {
  /** 条目不存在时返回 undefined；没有授权时抛错。 */
  read(name: string): Promise<string | undefined>;
  write(name: string, value: string): Promise<void>;
  delete(name: string): Promise<boolean>;
}

export const SecretsService = defineService<PluginSecrets>('secrets', 1);

/** 授予凭据条目的权限名。 */
export function secretPermission(name: string): string {
  return `secret:${name}`;
}

const EGRESS = 'net.egress:';

/** 外发到某个主机的权限名；`*.<域名>` 授予该域名下的全部子域名（见 {@link egressAllowed}）。 */
export function egressPermission(host: string): string {
  return `${EGRESS}${host}`;
}

/** 主机名不分大小写，末尾的点（完全限定写法）不影响比较。 */
function normalizeHost(host: string): string {
  const lower = host.toLowerCase();
  return lower.endsWith('.') ? lower.slice(0, -1) : lower;
}

/**
 * 主机是否已被授予外发。`net.egress:<主机>` 精确匹配；`net.egress:*.<域名>` 匹配该域名下任意层级的子域名，
 * 不匹配域名本身。`*` 只在最前面、后跟一个点时表示通配，其它位置的 `*` 按字面比较（任何主机名都不含 `*`，
 * 所以等于不匹配）。
 */
export function egressAllowed(host: string, permissions: Iterable<string>): boolean {
  const target = normalizeHost(host);
  if (target === '' || target.includes('*')) return false;
  for (const permission of permissions) {
    if (!permission.startsWith(EGRESS)) continue;
    const pattern = normalizeHost(permission.slice(EGRESS.length));
    if (!pattern.startsWith('*.')) {
      if (pattern === target) return true;
      continue;
    }
    const suffix = pattern.slice(1);
    if (suffix.length < 2 || suffix.includes('*') || !target.endsWith(suffix)) continue;
    const labels = target.slice(0, -suffix.length).split('.');
    if (labels.every((label) => label.length > 0)) return true;
  }
  return false;
}
