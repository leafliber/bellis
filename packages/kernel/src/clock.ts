/**
 * 时钟。内核与插件的计时都经过它，`sim` profile 用种子驱动的模拟时钟替换（R-07）。
 * 时间一律用单调时钟的毫秒数，不依赖墙钟。
 */
export interface Clock {
  now(): number;
  setTimeout(callback: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

export interface TimerHandle {
  readonly id: number;
}

/** 真实时钟：`performance.now()` 与 Node 定时器。 */
export function systemClock(): Clock {
  const timers = new Map<number, NodeJS.Timeout>();
  let next = 1;
  return {
    now: () => performance.now(),
    setTimeout(callback, ms) {
      const id = next++;
      timers.set(
        id,
        setTimeout(() => {
          timers.delete(id);
          callback();
        }, ms),
      );
      return { id };
    },
    clearTimeout(handle) {
      clearTimeout(timers.get(handle.id));
      timers.delete(handle.id);
    },
  };
}

/** 在时钟上等待一段时间。 */
export function sleep(clock: Clock, ms: number): Promise<void> {
  return new Promise((resolve) => clock.setTimeout(resolve, ms));
}

/** 截止时间内未完成则以 DeadlineError 失败；原任务不会被取消，调用方需自行处理。 */
export function withDeadline<T>(
  clock: Clock,
  work: Promise<T> | T,
  ms: number,
  what: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const handle = clock.setTimeout(
      () => reject(new DeadlineError(`${what} 未在 ${ms}ms 内完成`)),
      ms,
    );
    Promise.resolve(work).then(
      (value) => {
        clock.clearTimeout(handle);
        resolve(value);
      },
      (error: unknown) => {
        clock.clearTimeout(handle);
        reject(error);
      },
    );
  });
}

export class DeadlineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeadlineError';
  }
}

/**
 * 手动推进的时钟：测试与确定性仿真用。`advance` 按到期先后（同时到期按设定顺序）触发定时器，
 * 包括推进过程中新设的定时器。
 */
export class ManualClock implements Clock {
  #now = 0;
  #next = 1;
  readonly #timers = new Map<number, { at: number; callback: () => void }>();

  now(): number {
    return this.#now;
  }

  setTimeout(callback: () => void, ms: number): TimerHandle {
    const id = this.#next++;
    this.#timers.set(id, { at: this.#now + Math.max(0, ms), callback });
    return { id };
  }

  clearTimeout(handle: TimerHandle): void {
    this.#timers.delete(handle.id);
  }

  /** 距下一个定时器到期的时间；没有定时器时为 undefined。 */
  nextDue(): number | undefined {
    let earliest: number | undefined;
    for (const timer of this.#timers.values()) {
      if (earliest === undefined || timer.at < earliest) earliest = timer.at;
    }
    return earliest === undefined ? undefined : earliest - this.#now;
  }

  advance(ms: number): void {
    const target = this.#now + ms;
    for (;;) {
      let due: [number, { at: number; callback: () => void }] | undefined;
      for (const entry of this.#timers) {
        if (entry[1].at <= target && (!due || entry[1].at < due[1].at)) due = entry;
      }
      if (!due) break;
      this.#timers.delete(due[0]);
      this.#now = due[1].at;
      due[1].callback();
    }
    this.#now = target;
  }
}
