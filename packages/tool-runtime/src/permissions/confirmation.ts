import type { MonotonicClock } from "@bellis/contracts";
import type { ConfirmationPort, ToolConfirmationRequest } from "./gate.js";

export type ConfirmationOutcome =
  | "approved"
  | "rejected"
  | "cancelled"
  | "timeout"
  | "busy"
  | "failed";

/** One retained UI request per Runtime; a cancelled but uncooperative Port cannot accumulate prompts. */
export class BoundedToolConfirmation {
  #pending: Promise<boolean> | undefined;
  constructor(
    readonly port: ConfirmationPort,
    readonly clock: MonotonicClock,
  ) {}

  async confirm(
    request: Omit<ToolConfirmationRequest, "signal">,
    parent: AbortSignal,
  ): Promise<ConfirmationOutcome> {
    if (parent.aborted) return "cancelled";
    if (this.clock.nowUs() >= request.deadlineUs) return "timeout";
    if (this.#pending !== undefined) return "busy";
    const controller = new AbortController();
    const signal = AbortSignal.any([parent, controller.signal]);
    const operation = Promise.resolve().then(() => {
      signal.throwIfAborted();
      return this.port.confirm(Object.freeze({ ...request, signal }));
    });
    this.#pending = operation;
    void operation
      .finally(() => {
        if (this.#pending === operation) this.#pending = undefined;
      })
      .catch(() => undefined);
    const waiting = this.clock.sleepUntil(request.deadlineUs, signal).then(
      () => "timeout" as const,
      () => "cancelled" as const,
    );
    try {
      const outcome = await Promise.race([
        operation.then(
          (value) => (value === true ? ("approved" as const) : ("rejected" as const)),
          () => "failed" as const,
        ),
        waiting,
      ]);
      if (parent.aborted) return "cancelled";
      if (this.clock.nowUs() >= request.deadlineUs) return "timeout";
      return outcome;
    } finally {
      controller.abort(new Error("confirmation_finished"));
    }
  }
}
