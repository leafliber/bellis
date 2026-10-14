import type { Clock } from './clock.ts';
import { defineService } from './service.ts';

/** 宿主提供的时钟。插件的一切计时都经过它，`sim` profile 换成确定性的时钟（R-07）。 */
export const ClockService = defineService<Clock>('clock', 1);
