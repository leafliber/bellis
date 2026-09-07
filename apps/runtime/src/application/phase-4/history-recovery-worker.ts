import type {
  Phase4HistoryRevalidator,
  HistoryRevalidationProgress,
} from "./history-revalidator.js";

export interface HistoryRecoveryWorkerOptions {
  readonly intervalMs?: number;
  readonly timeoutMs?: number;
}
export interface HistoryRecoveryWorkerStatus {
  readonly stopped: boolean;
  readonly pending: boolean;
  readonly attempts: number;
  readonly outcome:
    | "idle"
    | "running"
    | "no_gap"
    | "incomplete"
    | "unavailable"
    | "attention"
    | "stopped";
  /** Historical last result, never permission to resume a blocked provider. */
  readonly lastResult?: HistoryRevalidationProgress;
}

/** One bounded maintenance attempt at a time, including cancelled underlying
 * work. No catch-up bursts, implicit gap release or raw error-body diagnostics. */
export class HistoryRecoveryWorker {
  readonly #create: () => Phase4HistoryRevalidator;
  readonly #intervalMs: number;
  readonly #timeoutMs: number;
  readonly #lifetime = new AbortController();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #pending: Promise<void> | undefined;
  #coordinator: Phase4HistoryRevalidator | undefined;
  #attempts = 0;
  #outcome: HistoryRecoveryWorkerStatus["outcome"] = "idle";
  #lastResult: HistoryRevalidationProgress | undefined;

  constructor(create: () => Phase4HistoryRevalidator, options: HistoryRecoveryWorkerOptions = {}) {
    this.#create = create;
    this.#intervalMs = options.intervalMs ?? 30000;
    this.#timeoutMs = options.timeoutMs ?? 60000;
    if (
      !Number.isSafeInteger(this.#intervalMs) ||
      this.#intervalMs < 100 ||
      this.#intervalMs > 60000 ||
      !Number.isSafeInteger(this.#timeoutMs) ||
      this.#timeoutMs < 1 ||
      this.#timeoutMs > 60000
    )
      throw new RangeError("history recovery interval/timeout invalid");
    this.#schedule(0);
  }

  get status(): HistoryRecoveryWorkerStatus {
    return {
      stopped: this.#lifetime.signal.aborted,
      pending: this.#pending !== undefined,
      attempts: this.#attempts,
      outcome: this.#outcome,
      ...(this.#lastResult === undefined ? {} : { lastResult: structuredClone(this.#lastResult) }),
    };
  }

  stop(): void {
    this.#lifetime.abort(new Error("history_recovery_worker_stopped"));
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#coordinator?.stop();
    this.#outcome = "stopped";
  }

  #schedule(delayMs: number): void {
    if (this.#lifetime.signal.aborted) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      const pending = this.#attempt();
      this.#pending = pending;
      void pending
        .finally(() => {
          if (this.#pending === pending) this.#pending = undefined;
          this.#schedule(this.#intervalMs);
        })
        .catch(() => {});
    }, delayMs);
    this.#timer.unref();
  }

  async #attempt(): Promise<void> {
    this.#attempts = Math.min(Number.MAX_SAFE_INTEGER, this.#attempts + 1);
    this.#outcome = "running";
    try {
      this.#coordinator = this.#create();
      const result = await this.#coordinator.resume(this.#lifetime.signal, this.#timeoutMs);
      this.#lifetime.signal.throwIfAborted();
      this.#lastResult = structuredClone(result);
      this.#outcome = "incomplete";
    } catch (error) {
      const detail = error as { code?: unknown; retryable?: unknown; message?: unknown } | null;
      if (this.#lifetime.signal.aborted) this.#outcome = "stopped";
      else if (detail?.message === "history_revalidation_not_required") this.#outcome = "no_gap";
      else if (
        (detail?.retryable === false && detail.code !== "idempotency_conflict") ||
        (typeof detail?.message === "string" &&
          [
            "history_revalidation_response_mismatch",
            "history_revalidation_request_identity_mismatch",
            "history_revalidation_discovery_identity_mismatch",
            "history_revalidation_gap_identity_mismatch",
            "history_revalidation_request_changed",
          ].includes(detail.message))
      ) {
        this.stop();
        this.#outcome = "attention";
      } else this.#outcome = "unavailable";
    } finally {
      // Do not construct another coordinator while old work is still live.
      await this.#coordinator?.whenSettled();
      this.#coordinator?.stop();
      this.#coordinator = undefined;
    }
  }
}
