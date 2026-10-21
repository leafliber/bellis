import { OBS_EXTERNAL_REASON } from '@bellis/safety';
import type { History } from './invariants.ts';

/** 监督模式的高低：安全停止最低；M0 只在仿真里出现，比安全停止高。 */
export const MODE_RANK: Readonly<Record<string, number>> = {
  'safe-stop': 0,
  M0: 0.5,
  M1: 1,
  M2: 2,
  M3: 3,
};

/** 真实输出模式：OBS 的外部变化只在这些模式下按急停处理。 */
const REAL_OUTPUT: ReadonlySet<string> = new Set(['M1', 'M2', 'M3']);

type Change = keyof typeof OBS_EXTERNAL_REASON;

/** 一次 OBS 外部变化，与同一时刻它同步引起的事（下一个操作员动作之前）。 */
interface External {
  seq: number;
  at: number;
  change: Change;
  /** OBS 的状态真的变了（没变时 OBS 不发事件）。 */
  changed: boolean;
  /** 当时的模式。 */
  mode: string;
  fact: boolean;
  stopped: boolean;
  ignored: boolean;
}

/**
 * 监督模式与 OBS 外部变化的不变量（含跨重启）：
 * 1. 安全核自动的模式变化（降级、急停）只降不升；离开安全停止只能由操作员；
 * 2. OBS 外部变化（R-27）：真实输出模式（M1–M3）下切到安全场景或静音 Stage 源，同一时刻记事实
 *    `safety.obs-external`、以对应的原因急停并进入安全停止；在 M0 或安全停止中只写日志
 *    （`safety.obs-external-ignored`），不记事实、不急停；OBS 本来就在那个状态时什么也不发生。
 *    每条 `safety.obs-external` 与以外部变化为原因的急停都对得上这样一次外部变化。
 * 与“安全停止期间 Stage 没有播出任何采样”合起来：外部变化之后直到操作员重新升级，Stage 不再播出。
 */
export function checkSupervision(history: History): string[] {
  const violations: string[] = [];

  for (const event of history.events) {
    if (event.type !== 'supervision.changed') continue;
    const { from, to, by } = event.data as { from: string; to: string; by: string };
    const rank = (mode: string) => MODE_RANK[mode] ?? Number.NaN;
    if (by !== 'operator' && !(rank(to) < rank(from)))
      violations.push(
        `安全核把模式从 ${from} 改成了 ${to}（第 ${event.seq} 条事件），自动变化只能降级`,
      );
    if (from === 'safe-stop' && by !== 'operator')
      violations.push(`第 ${event.seq} 条事件：不是操作员却解除了安全停止（到 ${to}）`);
  }

  let mode = 'safe-stop';
  let external: External | undefined;
  const close = () => {
    if (!external) return;
    const { seq, change, changed } = external;
    const what = `第 ${seq} 条追踪的 OBS 外部变化（${change}，当时 ${external.mode}）`;
    if (changed && REAL_OUTPUT.has(external.mode)) {
      if (!external.fact) violations.push(`${what}没有记 safety.obs-external`);
      if (!external.stopped) violations.push(`${what}没有以“${OBS_EXTERNAL_REASON[change]}”急停`);
      if (mode !== 'safe-stop') violations.push(`${what}之后没有进入安全停止（${mode}）`);
    } else if (changed && !external.ignored) {
      violations.push(`${what}没有写日志 safety.obs-external-ignored`);
    }
    external = undefined;
  };
  /** 这条事实或急停是否属于真实输出模式下一次真的改变了 OBS 的外部变化。 */
  const matches = (change: unknown) =>
    external?.changed === true && REAL_OUTPUT.has(external.mode) && external.change === change;

  for (const entry of history.trace) {
    if (
      external &&
      (entry.at !== external.at || entry.kind === 'operator.action' || entry.kind === 'world.start')
    )
      close();
    switch (entry.kind) {
      case 'world.start':
        mode = 'safe-stop';
        break;
      case 'control.mode':
        mode = String(entry.data.mode);
        break;
      case 'operator.action': {
        const action = entry.data.action;
        if (action !== 'obs-scene' && action !== 'obs-mute') break;
        external = {
          seq: entry.seq,
          at: entry.at,
          change: action === 'obs-scene' ? 'scene' : 'mute',
          changed: entry.data.changed === true,
          mode,
          fact: false,
          stopped: false,
          ignored: false,
        };
        break;
      }
      case 'fact.safety.obs-external':
        if (external && matches(entry.data.change)) external.fact = true;
        else
          violations.push(`第 ${entry.seq} 条追踪：没有对应的外部变化却记了 safety.obs-external`);
        break;
      case 'control.stop': {
        const reason = entry.data.reason;
        const change = (Object.keys(OBS_EXTERNAL_REASON) as Change[]).find(
          (key) => OBS_EXTERNAL_REASON[key] === reason,
        );
        if (change === undefined) break;
        if (external && matches(change)) external.stopped = true;
        else violations.push(`第 ${entry.seq} 条追踪：没有对应的外部变化却以“${reason}”急停`);
        break;
      }
      case 'log.safety.obs-external-ignored':
        if (external && !REAL_OUTPUT.has(external.mode) && entry.data.change === external.change)
          external.ignored = true;
        break;
    }
  }
  close();
  return violations;
}
