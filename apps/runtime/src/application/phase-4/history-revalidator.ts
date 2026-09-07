import { randomUUID } from "node:crypto";
import {
  MemoryRecallVerificationSchema,
  type MemoryRecallRequest,
  type MemoryRecallVerifier,
} from "@bellis/contracts";
import type {
  PersistenceClient,
  HistoryInventoryBegin,
  HistoryInventoryPage,
} from "@bellis/persistence";

type Storage = Pick<
  PersistenceClient,
  | "phase4ReadHistoryRecoveryState"
  | "phase4BeginHistoryInventory"
  | "phase4ReadHistoryVerificationPage"
  | "phase4ReadRevalidationRequest"
  | "phase4RecordHistoryVerification"
>;
type Descriptor = HistoryInventoryPage["items"][number];
export interface HistoryRevalidationProgress {
  readonly runId: string;
  readonly inventoryDigest: string;
  readonly validRequests: number;
  readonly unavailableRequests: number;
  readonly uncheckedItems: number;
  readonly status: "incomplete";
}

/** Explicit maintenance lifecycle: normal MemoryHost can remain stopped. */
export class Phase4HistoryRevalidator {
  readonly #storage: Storage;
  readonly #verifier: MemoryRecallVerifier;
  readonly #identity: { scopeKey: string; providerId: string; agentId: string; spaceId: string };
  readonly #lifetime = new AbortController();
  readonly #ownerSignal: AbortSignal;
  #pending: Promise<HistoryRevalidationProgress> | undefined;

  constructor(
    storage: Storage,
    verifier: MemoryRecallVerifier,
    identity: { scopeKey: string; providerId: string; agentId: string; spaceId: string },
    ownerSignal: AbortSignal = new AbortController().signal,
  ) {
    if (verifier.id !== identity.providerId) throw new Error("history_verifier_identity_mismatch");
    this.#storage = storage;
    this.#verifier = verifier;
    this.#identity = { ...identity };
    this.#ownerSignal = ownerSignal;
  }

  stop(): void {
    this.#lifetime.abort(new Error("history_revalidator_stopped"));
  }

  /** A caller timeout may precede settlement of an uncooperative storage/HTTP
   * operation. Background owners must retain capacity until this resolves. */
  async whenSettled(): Promise<void> {
    await this.#pending?.catch(() => {});
  }

  async run(
    input: HistoryInventoryBegin,
    parent: AbortSignal,
    timeoutMs = 60000,
  ): Promise<HistoryRevalidationProgress> {
    if (
      input.scopeKey !== this.#identity.scopeKey ||
      input.providerId !== this.#identity.providerId
    )
      throw new Error("history_revalidation_scope_mismatch");
    return this.#runOperation((signal) => this.#execute({ ...input }, signal), parent, timeoutMs);
  }

  async resume(parent: AbortSignal, timeoutMs = 60000): Promise<HistoryRevalidationProgress> {
    return this.#runOperation(
      async (signal) => {
        signal.throwIfAborted();
        const state = await this.#storage.phase4ReadHistoryRecoveryState({
          scopeKey: this.#identity.scopeKey,
          providerId: this.#identity.providerId,
        });
        signal.throwIfAborted();
        if (
          state.scopeKey !== this.#identity.scopeKey ||
          state.policy.scopeKey !== this.#identity.scopeKey ||
          state.providerId !== this.#identity.providerId
        )
          throw new Error("history_revalidation_discovery_identity_mismatch");
        if (state.transmissionBlocked) throw new Error("history_revalidation_privacy_blocked");
        if (state.gap === null) throw new Error("history_revalidation_not_required");
        if (state.gap.agentId !== this.#identity.agentId)
          throw new Error("history_revalidation_gap_identity_mismatch");
        const input = {
          runId: state.inventoryStatus === "current" ? state.inventory!.runId : randomUUID(),
          scopeKey: state.scopeKey,
          providerId: state.providerId,
          gapId: state.gap.gapId,
          generation: state.policy.generation,
        };
        return this.#execute(input, signal);
      },
      parent,
      timeoutMs,
    );
  }

  async #runOperation(
    operation: (signal: AbortSignal) => Promise<HistoryRevalidationProgress>,
    parent: AbortSignal,
    timeoutMs: number,
  ): Promise<HistoryRevalidationProgress> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000)
      throw new Error("history_revalidation_timeout_invalid");
    if (this.#pending !== undefined) throw new Error("history_revalidation_busy");
    const signal = AbortSignal.any([
      parent,
      this.#ownerSignal,
      this.#lifetime.signal,
      AbortSignal.timeout(timeoutMs),
    ]);
    signal.throwIfAborted();
    const pending = operation(signal);
    this.#pending = pending;
    // Cancellation does not release the slot until uncooperative work settles.
    void pending
      .finally(() => {
        if (this.#pending === pending) this.#pending = undefined;
      })
      .catch(() => {});
    let onAbort: (() => void) | undefined;
    try {
      return await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          onAbort = () => reject(signal.reason);
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
        }),
      ]);
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  }

  async #execute(
    input: HistoryInventoryBegin,
    signal: AbortSignal,
  ): Promise<HistoryRevalidationProgress> {
    const step = async <T>(operation: () => Promise<T>): Promise<T> => {
      signal.throwIfAborted();
      const result = await operation();
      signal.throwIfAborted();
      return result;
    };
    const inventory = await step(() => this.#storage.phase4BeginHistoryInventory(input));
    let pending: { descriptor: Descriptor; request: MemoryRecallRequest }[] = [],
      bytes = 0;
    const flush = async () => {
      if (!pending.length) return;
      // Recheck transmission admission after constructing the batch. The caller
      // also aborts this maintenance operation before changing live privacy.
      for (const entry of pending) {
        const admitted = await step(() =>
          this.#storage.phase4ReadRevalidationRequest({
            runId: input.runId,
            ordinal: entry.descriptor.ordinal,
          }),
        );
        if (JSON.stringify(admitted) !== JSON.stringify(entry.request))
          throw new Error("history_revalidation_request_changed");
      }
      const response = MemoryRecallVerificationSchema.parse(
        await step(() =>
          this.#verifier.verify(structuredClone(pending.map((p) => p.request)), signal),
        ),
      );
      if (
        new Set(response.results.map((r) => r.requestId)).size !== response.results.length ||
        response.results.length !== pending.length ||
        response.results.some((r) => !pending.some((p) => p.request.requestId === r.requestId))
      )
        throw new Error("history_revalidation_response_mismatch");
      const batch = {
        batchId: randomUUID(),
        runId: inventory.runId,
        inventoryDigest: inventory.inventoryDigest,
        scheme: "recall-current-v1" as const,
        checkedAt: response.checkedAt,
        results: pending.map(({ descriptor, request }) => ({
          ordinal: descriptor.ordinal,
          digest: descriptor.digest,
          requestId: request.requestId,
          status: response.results.find((r) => r.requestId === request.requestId)!.status,
        })),
      };
      await step(() => this.#storage.phase4RecordHistoryVerification(batch));
      pending = [];
      bytes = 0;
    };
    for (let after = 0; after < inventory.itemCount;) {
      const page = await step(() =>
        this.#storage.phase4ReadHistoryVerificationPage({ runId: input.runId, after, limit: 64 }),
      );
      if (page.inventory.inventoryDigest !== inventory.inventoryDigest || !page.items.length)
        throw new Error("history_revalidation_inventory_changed");
      for (const descriptor of page.items) {
        if (descriptor.kind !== "recall_request" || descriptor.verification !== null) continue;
        const request = await step(() =>
          this.#storage.phase4ReadRevalidationRequest({
            runId: input.runId,
            ordinal: descriptor.ordinal,
          }),
        );
        if (request === null) continue;
        if (
          request.attemptId !== descriptor.id ||
          request.agentId !== this.#identity.agentId ||
          request.spaceId !== this.#identity.spaceId
        )
          throw new Error("history_revalidation_request_identity_mismatch");
        const size = Buffer.byteLength(JSON.stringify(request.body));
        if (
          pending.length >= 16 ||
          bytes + size > 900000 ||
          pending.some((p) => p.request.requestId === request.requestId)
        )
          await flush();
        pending.push({ descriptor, request });
        bytes += size;
      }
      after += page.items.length;
    }
    await flush();
    let validRequests = 0,
      unavailableRequests = 0,
      uncheckedItems = 0;
    for (let after = 0; ;) {
      const page = await step(() =>
        this.#storage.phase4ReadHistoryVerificationPage({ runId: input.runId, after, limit: 64 }),
      );
      for (const item of page.items) {
        if (item.verification === null) uncheckedItems++;
        else if (item.verification.status === "valid") validRequests++;
        else unavailableRequests++;
      }
      if (page.done) break;
      if (!page.items.length) throw new Error("history_revalidation_inventory_changed");
      after += page.items.length;
    }
    return {
      runId: inventory.runId,
      inventoryDigest: inventory.inventoryDigest,
      validRequests,
      unavailableRequests,
      uncheckedItems,
      status: "incomplete",
    };
  }
}
