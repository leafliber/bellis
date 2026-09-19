import type { MonotonicClock } from "./clock.ts";
import { RuntimeRejection, reject } from "./errors.ts";

export type WorkReply = {
  success: (value: unknown) => void;
  failure: (error: unknown) => void;
  detach: () => void;
};

/** P0Service's finite outstanding calls, not a queue or a cancellation facility.
 * A deadline returns the live slot only. The original Promise retains one bounded
 * cell until it really settles; after detachment that cell has no reply/connection.
 */
export class ServiceWorkPool {
  readonly clock: MonotonicClock;
  readonly limit: number;
  #live = 0;
  #cells = new Set<ServiceWorkCell>();
  #closed = false;
  constructor(clock: MonotonicClock, limit: number) {
    this.clock = clock;
    this.limit = limit;
  }
  reserve(deadline: number, reply: WorkReply): ServiceWorkCell {
    for (const cell of this.#cells) cell.expire();
    if (this.#closed) reject("SERVICE_NOT_READY");
    if (this.clock.now() >= deadline) reject("COMMAND_DEADLINE_MISSED");
    if (this.#live >= this.limit || this.#cells.size >= 2 * this.limit)
      reject("QUEUE_LIMIT_EXCEEDED");
    const cell = new ServiceWorkCell(this, deadline, reply);
    this.#live++;
    this.#cells.add(cell);
    return cell;
  }
  releaseLive(): void {
    this.#live--;
  }
  settled(cell: ServiceWorkCell): void {
    this.#cells.delete(cell);
  }
  close(): void {
    this.#closed = true;
    for (const cell of this.#cells) cell.close();
  }
}

export class ServiceWorkCell {
  readonly #pool: ServiceWorkPool;
  readonly #deadline: number;
  #reply: WorkReply | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #live = true;
  #settled = false;
  constructor(pool: ServiceWorkPool, deadline: number, reply: WorkReply) {
    this.#pool = pool;
    this.#deadline = deadline;
    this.#reply = reply;
    this.#timer = setTimeout(() => this.expire(), Math.max(0, deadline - pool.clock.now()));
  }
  #release(): void {
    if (!this.#live) return;
    this.#live = false;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#pool.releaseLive();
  }
  dropReply(): void {
    const reply = this.#reply;
    this.#reply = undefined;
    reply?.detach();
  }
  expire(): void {
    if (!this.#live || this.#pool.clock.now() < this.#deadline) return;
    this.#release();
    const reply = this.#reply;
    this.dropReply();
    reply?.failure(new RuntimeRejection("COMMAND_DEADLINE_MISSED"));
  }
  close(): void {
    this.#release();
    this.dropReply();
  }
  #finish(value: unknown, failed: boolean): void {
    if (this.#settled) return;
    this.#settled = true;
    // Timer scheduling is not the deadline authority.
    this.expire();
    this.#release();
    this.#pool.settled(this);
    const reply = this.#reply;
    this.dropReply();
    if (failed) reply?.failure(value);
    else reply?.success(value);
  }
  fulfill = (value: unknown): void => this.#finish(value, false);
  fail = (error: unknown): void => this.#finish(error, true);
  start(run: () => unknown): void {
    try {
      const result = run();
      if (result instanceof Promise) void result.then(this.fulfill, this.fail);
      else this.fulfill(result);
    } catch (error) {
      this.fail(error);
    }
  }
}
