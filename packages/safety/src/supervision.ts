/**
 * 监督模式（D-32）。M0 只在 `sim` profile 下可用；升级只能由操作员显式执行，安全核可以自动降级。
 */
export type Mode = 'M0' | 'M1' | 'M2' | 'M3' | 'safe-stop';

const RANK: Record<Mode, number> = { 'safe-stop': 0, M0: 1, M1: 1, M2: 2, M3: 3 };

export function producesOutput(mode: Mode): boolean {
  return mode !== 'safe-stop';
}

export interface UpgradeContext {
  simulation: boolean;
  maintenance: boolean;
  storeHealthy: boolean;
  /** 安全核的 OBS 应急连接可用。 */
  emergencyReady: boolean;
  watchdogConnected: boolean;
  presenceValid: boolean;
  /** 审核插件是否在 profile 中显式启用；未显式设置为 undefined。 */
  moderationEnabled: boolean | undefined;
  /** 进入无人值守的其余门槛（红队召回、演练、累计时长、平台规则、值班呼叫）是否已登记满足。 */
  unattendedGatesSatisfied: boolean;
}

/** 检查目标模式的前置条件；满足时返回 undefined，否则返回原因。 */
export function upgradeBlocker(
  current: Mode,
  target: Mode,
  ctx: UpgradeContext,
): string | undefined {
  if (target === current) return '已经处于该模式';
  if (target === 'safe-stop' || RANK[target] < RANK[current]) return undefined;
  if (ctx.maintenance) return '维护态中不能进入输出模式';
  if (ctx.simulation && target !== 'M0') return 'sim profile 下只允许 M0';
  if (!ctx.simulation && target === 'M0') return 'M0 只在 sim profile 下可用';
  if (!ctx.storeHealthy) return '状态存储不可用';
  if (!ctx.emergencyReady) return 'OBS 应急连接不可用';
  if (target === 'M0') return undefined;
  if (!ctx.watchdogConnected) return '外部看门狗未连接';
  if (target === 'M2' && !ctx.presenceValid) return '在场确认无效';
  if (target === 'M3') {
    if (ctx.moderationEnabled !== true) return '审核插件未启用，不允许进入无人值守';
    if (!ctx.unattendedGatesSatisfied) return '无人值守门槛尚未满足';
  }
  return undefined;
}

/** 自动降级的目标：在场确认仍有效时从 M2/M3 降到 M1，否则进入安全停止。 */
export function downgradeTarget(current: Mode, presenceValid: boolean): Mode {
  if ((current === 'M2' || current === 'M3') && presenceValid) return 'M1';
  return 'safe-stop';
}
