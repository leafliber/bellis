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
