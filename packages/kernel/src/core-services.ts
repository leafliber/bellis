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
