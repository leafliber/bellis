import { IrisBoundaryError } from "./http.js";

/** Caller deadlines do not release an operation still running in an uncooperative client. */
export class BoundedIrisCalls {
  readonly #busy = new Set<string>();

  async run<T>(
    key: string,
    parent: AbortSignal,
    timeoutMs: number,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    parent.throwIfAborted();
    if (this.#busy.has(key)) throw new IrisBoundaryError("operation_busy", true);
    const deadline = new AbortController();
    const timer = setTimeout(
      () => deadline.abort(new IrisBoundaryError("request_timeout", true)),
      timeoutMs,
    );
    timer.unref();
    const signal = AbortSignal.any([parent, deadline.signal]);
    this.#busy.add(key);
    const delivery = Promise.resolve().then(() => {
      signal.throwIfAborted();
      return operation(signal);
    });
    void delivery.finally(() => this.#busy.delete(key)).catch(() => {});
    let onAbort: (() => void) | undefined;
    try {
      const result = await Promise.race([
        delivery,
        new Promise<never>((_, reject) => {
          onAbort = () => reject(signal.reason);
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
        }),
      ]);
      signal.throwIfAborted();
      return result;
    } finally {
      clearTimeout(timer);
      if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
    }
  }
}
