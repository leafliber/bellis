import { AsyncIrisMemoryClient, validateContract } from "@iris-memory/sdk";
import { JsonValueSchema, type JsonValue } from "@bellis/contracts";
import { BoundedIrisCalls } from "./bounded-calls.js";
import { checkedIrisFetch, IrisBoundaryError } from "./http.js";
import { safeInteger } from "./validation.js";

/** Provider-local public wire envelope. Credentials never belong in the durable request. */
export type IrisToolRequest =
  | { readonly operation: "memory_search"; readonly record: Readonly<Record<string, JsonValue>> }
  | {
      readonly operation: "remember" | "forget";
      readonly record: Readonly<Record<string, JsonValue>>;
      readonly idempotencyKey: string;
    }
  | {
      readonly operation: "correct";
      readonly claimId: string;
      readonly record: Readonly<Record<string, JsonValue>>;
      readonly idempotencyKey: string;
    };

export class IrisToolOutcomeUnknown extends IrisBoundaryError {
  readonly remoteOutcome = "unknown";
  constructor(readonly causeCode: string) {
    super("tool_outcome_unknown", true);
    this.name = "IrisToolOutcomeUnknown";
  }
}

const fields = {
  memory_search: ["agent_id", "space_id", "session_id", "query", "limit"],
  remember: [
    "agent_id",
    "predicate",
    "value",
    "subject_entity_id",
    "subject_is_self",
    "canonical_text",
    "category",
    "space_id",
    "session_id",
    "confidence",
    "importance",
    "accessibility",
    "source_authority",
    "evidence",
    "privacy_labels",
    "source_refs",
    "valid_from_us",
    "valid_until_us",
    "extractor_version",
    "lease_id",
    "lease_epoch",
  ],
  correct: [
    "expected_revision",
    "mode",
    "value",
    "canonical_text",
    "evidence",
    "source_authority",
    "reason",
    "lease_id",
    "lease_epoch",
  ],
  forget: ["selector", "reason", "erase_content", "lease_id", "lease_epoch"],
} as const;

function responseInteger(value: unknown, field: string): number {
  if (typeof value !== "number") throw new IrisBoundaryError("invalid_tool_response", false);
  return safeInteger(value, field);
}
function invalid(): never {
  throw new IrisBoundaryError("invalid_tool_request", false);
}
function nonempty(value: unknown, max = 512): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}
function object(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Snapshot once before an async boundary; recovery must persist this exact envelope. */
export function freezeIrisToolRequest(input: IrisToolRequest): IrisToolRequest {
  let request: IrisToolRequest;
  try {
    const value = JsonValueSchema.parse(input);
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) > 65_536) invalid();
    request = JSON.parse(text) as IrisToolRequest;
  } catch {
    return invalid();
  }
  if (!object(request) || !Object.hasOwn(fields, request.operation)) invalid();
  const allowed = fields[request.operation];
  if (allowed === undefined || !object(request.record)) invalid();
  const envelopeKeys =
    request.operation === "memory_search"
      ? ["operation", "record"]
      : request.operation === "correct"
        ? ["operation", "record", "idempotencyKey", "claimId"]
        : ["operation", "record", "idempotencyKey"];
  if (
    Object.keys(request).some((key) => !envelopeKeys.includes(key)) ||
    Object.keys(request.record).some((key) => !(allowed as readonly string[]).includes(key))
  )
    invalid();
  const r = request.record;
  if (request.operation !== "memory_search" && !nonempty(request.idempotencyKey, 128)) invalid();
  if (r.session_id !== undefined && r.session_id !== null && !nonempty(r.space_id)) invalid();
  if ((r.lease_id === undefined) !== (r.lease_epoch === undefined)) invalid();
  if (
    r.lease_id !== undefined &&
    (!nonempty(r.lease_id) || !Number.isSafeInteger(r.lease_epoch) || Number(r.lease_epoch) < 1)
  )
    invalid();
  switch (request.operation) {
    case "memory_search":
      if (
        !nonempty(r.agent_id) ||
        !nonempty(r.query, 8192) ||
        (r.limit !== undefined &&
          (!Number.isSafeInteger(r.limit) || Number(r.limit) < 1 || Number(r.limit) > 100))
      )
        invalid();
      break;
    case "remember":
      if (
        !nonempty(r.agent_id) ||
        !nonempty(r.predicate, 256) ||
        !Object.hasOwn(r, "value") ||
        !Array.isArray(r.evidence) ||
        r.evidence.length < 1 ||
        r.evidence.length > 64
      )
        invalid();
      break;
    case "correct":
      if (
        !nonempty(request.claimId) ||
        !Number.isSafeInteger(r.expected_revision) ||
        Number(r.expected_revision) < 1 ||
        !nonempty(r.reason, 4096)
      )
        invalid();
      break;
    case "forget":
      if (!object(r.selector) || !nonempty(r.selector.kind) || !nonempty(r.reason, 4096)) invalid();
      break;
  }
  const schema = {
    memory_search: "search-request",
    remember: "claim-remember-request",
    correct: "claim-correct-request",
    forget: "memory-forget-request",
  }[request.operation];
  if (validateContract(schema, r).length > 0) invalid();
  return freeze(request);
}

/** Transport only: host authorization, confirmation, durable request and read barriers precede it. */
export class IrisToolBoundary {
  readonly #calls = new BoundedIrisCalls();
  readonly #config: {
    baseUrl: string;
    bearerToken: string;
    timeoutMs: number;
    transport: typeof fetch;
  };
  constructor(config: {
    baseUrl: string;
    bearerToken: string;
    timeoutMs?: number;
    transport?: typeof fetch;
  }) {
    const timeoutMs = config.timeoutMs ?? 4000;
    const url = new URL(config.baseUrl);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !nonempty(config.bearerToken, 16_384) ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 30_000
    )
      throw new IrisBoundaryError("invalid_tool_configuration", false);
    this.#config = {
      baseUrl: url.href,
      bearerToken: config.bearerToken,
      timeoutMs,
      transport: config.transport ?? fetch,
    };
  }

  async execute(input: IrisToolRequest, parent: AbortSignal): Promise<JsonValue> {
    const request = freezeIrisToolRequest(input);
    let dispatched = false;
    try {
      return await this.#calls.run("tools", parent, this.#config.timeoutMs, async (signal) => {
        const transport = checkedIrisFetch(async (url, init) => {
          signal.throwIfAborted();
          const combined = AbortSignal.any([
            signal,
            ...(init?.signal == null ? [] : [init.signal]),
            ...(url instanceof Request ? [url.signal] : []),
          ]);
          dispatched = true;
          return this.#config.transport(url, { ...init, signal: combined });
        });
        // The installed SDK lacks per-method AbortSignal for these operations.
        // A per-call client closes over its own deadline without changing shared fetch/global state.
        const client = new AsyncIrisMemoryClient(this.#config.baseUrl, {
          bearerToken: this.#config.bearerToken,
          fetch: transport,
        });
        let value: unknown;
        switch (request.operation) {
          case "memory_search":
            value = await client.search(
              request.record as unknown as Parameters<typeof client.search>[0],
            );
            break;
          case "remember":
            value = await client.rememberClaim(request.record, {
              idempotencyKey: request.idempotencyKey,
            });
            break;
          case "correct":
            value = await client.correctClaim(request.claimId, request.record, {
              idempotencyKey: request.idempotencyKey,
            });
            break;
          case "forget":
            value = await client.forgetMemory(request.record, {
              idempotencyKey: request.idempotencyKey,
            });
            break;
        }
        const result = JsonValueSchema.parse(value);
        if (!object(result)) throw new IrisBoundaryError("invalid_tool_response", false);
        if (request.operation === "remember" || request.operation === "correct") {
          if (responseInteger(result.revision, "revision") < 1)
            throw new IrisBoundaryError("invalid_tool_response", false);
          responseInteger(result.recorded_at_us, "recorded_at_us");
        }
        if (request.operation === "forget") {
          for (const field of [
            "target_count",
            "erased_count",
            "protected_skipped",
            "held_skipped",
            "tombstone_seq_lo",
          ])
            responseInteger(result[field], field);
          if (result.tombstone_seq_hi !== null)
            responseInteger(result.tombstone_seq_hi, "tombstone_seq_hi");
        }
        return result;
      });
    } catch (error) {
      // Only a definite public 4xx rejection proves this attempt did not perform the write.
      const rejected =
        error instanceof IrisBoundaryError &&
        error.status !== undefined &&
        [400, 401, 403, 404, 409, 422].includes(error.status);
      if (request.operation !== "memory_search" && dispatched && !rejected)
        throw new IrisToolOutcomeUnknown(
          error instanceof IrisBoundaryError ? error.code : "transport_or_response_failure",
        );
      if (error instanceof IrisBoundaryError) throw error;
      throw new IrisBoundaryError(
        parent.aborted ? "request_cancelled" : "tool_transport_failure",
        true,
      );
    }
  }

  /** Public target read, sharing the retained transport permit with writes. */
  async readClaim(
    claimId: string,
    parent: AbortSignal,
  ): Promise<Readonly<Record<string, JsonValue>>> {
    if (!nonempty(claimId)) throw new IrisBoundaryError("invalid_tool_request", false);
    try {
      return await this.#calls.run("tools", parent, this.#config.timeoutMs, async (signal) => {
        const client = new AsyncIrisMemoryClient(this.#config.baseUrl, {
          bearerToken: this.#config.bearerToken,
          fetch: checkedIrisFetch(async (url, init) => {
            signal.throwIfAborted();
            return this.#config.transport(url, {
              ...init,
              signal: AbortSignal.any([
                signal,
                ...(init?.signal == null ? [] : [init.signal]),
                ...(url instanceof Request && url.signal ? [url.signal] : []),
              ]),
            });
          }),
        });
        const value = JsonValueSchema.parse(await client.getClaim(claimId));
        if (
          !object(value) ||
          value.claim_id !== claimId ||
          responseInteger(value.revision, "revision") < 1
        )
          throw new IrisBoundaryError("invalid_tool_response", false);
        responseInteger(value.recorded_at_us, "recorded_at_us");
        return freeze(value);
      });
    } catch (error) {
      if (error instanceof IrisBoundaryError) throw error;
      throw new IrisBoundaryError(
        parent.aborted ? "request_cancelled" : "target_read_failed",
        true,
      );
    }
  }
}
