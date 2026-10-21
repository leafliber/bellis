/**
 * 时钟。内核与插件的计时都经过它，`sim` profile 用种子驱动的模拟时钟替换（R-07）。
 * 时间一律用单调时钟的毫秒数，不依赖墙钟。
 */
export interface Clock {
  now(): number;
  /**
   * 单调时钟零点对应的 Unix 毫秒。只用来给可以丢失的派生数据（遥测）打墙钟时间戳：Unix 时刻为
   * `epochMs + now()`；计时与截止时间仍只用 `now()`。不提供时按 0。
   */
  readonly epochMs?: number;
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
    epochMs: performance.timeOrigin,
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

/** 在时钟上等待一段时间，可被中止：到时返回 true，中止时立即返回 false（已中止时不等待）。 */
export function sleepUnlessAborted(
  clock: Clock,
  ms: number,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const onAbort = () => {
      clock.clearTimeout(timer);
      resolve(false);
    };
    const timer = clock.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
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
  readonly epochMs: number;
  #now: number;
  #next = 1;
  readonly #timers = new Map<number, { at: number; callback: () => void }>();
  readonly #shuffle: ((count: number) => number) | undefined;

  /**
   * @param start 起始时刻。
   * @param shuffle 同时到期的多个定时器的选择方式（返回下标）；缺省按设定顺序。确定性仿真用它探索交错。
   * @param epochMs 零点对应的 Unix 毫秒（见 {@link Clock.epochMs}）。
   */
  constructor(start = 0, shuffle?: (count: number) => number, epochMs = 0) {
    this.epochMs = epochMs;
    this.#now = start;
    this.#shuffle = shuffle;
  }

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
      let earliest = Number.POSITIVE_INFINITY;
      for (const timer of this.#timers.values()) earliest = Math.min(earliest, timer.at);
      if (earliest > target) break;
      const due = [...this.#timers].filter(([, timer]) => timer.at === earliest);
      const pick = due[this.#shuffle && due.length > 1 ? this.#shuffle(due.length) : 0] ?? due[0];
      if (!pick) break;
      this.#timers.delete(pick[0]);
      this.#now = pick[1].at;
      pick[1].callback();
    }
    this.#now = target;
  }
}
