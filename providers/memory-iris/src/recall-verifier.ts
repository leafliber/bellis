import { AsyncIrisMemoryClient } from "@iris-memory/sdk";
import {
  MemoryRecallVerificationRequestsSchema,
  MemoryRecallVerificationSchema,
  type MemoryRecallRequest,
  type MemoryRecallVerification,
  type MemoryRecallVerifier,
} from "@bellis/contracts";
import { BoundedIrisCalls } from "./bounded-calls.js";
import { checkedIrisFetch, IrisBoundaryError } from "./http.js";

export interface IrisRecallVerifierConfig {
  readonly baseUrl: string;
  readonly bearerToken: string;
  readonly agentId: string;
  readonly spaceId: string;
  readonly minimumCoreSchemaVersion?: number;
  readonly maximumCoreSchemaVersion?: number;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
}

/** Read-only recovery transport. It never starts Persona, SSE or an Outbox. */
export class IrisRecallVerifier implements MemoryRecallVerifier {
  readonly id = "iris";
  readonly #config: IrisRecallVerifierConfig;
  readonly #fetch: typeof fetch;
  readonly #client: AsyncIrisMemoryClient;
  readonly #calls = new BoundedIrisCalls();
  readonly #lifetime = new AbortController();
  readonly #timeoutMs: number;

  constructor(config: IrisRecallVerifierConfig) {
    const url = new URL(config.baseUrl);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== "/" && url.pathname !== "")
    )
      throw new TypeError("Iris recovery requires an HTTP origin");
    if (!config.bearerToken || !config.agentId || !config.spaceId)
      throw new TypeError("Iris recovery identity is required");
    const minimum = config.minimumCoreSchemaVersion ?? 14,
      maximum = config.maximumCoreSchemaVersion ?? 15;
    if (
      !Number.isSafeInteger(minimum) ||
      !Number.isSafeInteger(maximum) ||
      minimum < 1 ||
      maximum < minimum
    )
      throw new RangeError("Iris recovery schema window invalid");
    this.#timeoutMs = config.timeoutMs ?? 10000;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1 || this.#timeoutMs > 30000)
      throw new RangeError("Iris recovery timeout must be 1..30000ms");
    this.#config = { ...config, baseUrl: url.origin };
    this.#fetch = checkedIrisFetch(config.fetch);
    this.#client = new AsyncIrisMemoryClient(url.origin, {
      bearerToken: config.bearerToken,
      fetch: this.#fetch,
    });
  }

  stop(): void {
    this.#lifetime.abort(new Error("iris_recall_verifier_stopped"));
  }

  async verify(
    values: readonly MemoryRecallRequest[],
    parent: AbortSignal,
  ): Promise<MemoryRecallVerification> {
    const requests = MemoryRecallVerificationRequestsSchema.parse(values);
    if (
      new Set(requests.map((r) => r.requestId)).size !== requests.length ||
      new Set(requests.map((r) => r.attemptId)).size !== requests.length
    )
      throw new IrisBoundaryError("revalidation_duplicate_request", false);
    for (const request of requests) {
      const scope = request.body.scope;
      if (
        request.agentId !== this.#config.agentId ||
        request.spaceId !== this.#config.spaceId ||
        scope === null ||
        typeof scope !== "object" ||
        Array.isArray(scope) ||
        scope.agent_id !== request.agentId ||
        scope.space_id !== request.spaceId ||
        request.body.request_id !== request.requestId
      )
        throw new IrisBoundaryError("revalidation_identity_mismatch", false);
    }
    const body = JSON.stringify({
      schema_version: 1,
      deadline_at: new Date(Date.now() + this.#timeoutMs).toISOString(),
      requests: requests.map((r) => r.body),
    });
    if (Buffer.byteLength(body) > 1_048_576)
      throw new IrisBoundaryError("revalidation_request_too_large", false);
    return this.#calls.run(
      "recall-revalidate",
      AbortSignal.any([parent, this.#lifetime.signal]),
      this.#timeoutMs,
      async (signal) => {
        // Re-negotiate for each batch; a different installed service must not inherit
        // previously cached capabilities or schema compatibility.
        const capabilities = await this.#client.negotiate(["v1"], { signal });
        signal.throwIfAborted();
        if (
          capabilities.api_version !== "v1" ||
          capabilities.schema_version < (this.#config.minimumCoreSchemaVersion ?? 14) ||
          capabilities.schema_version > (this.#config.maximumCoreSchemaVersion ?? 15) ||
          !capabilities.capabilities.includes("recall.revalidate.v1")
        )
          throw new IrisBoundaryError("revalidation_unsupported", false);
        const response = await this.#fetch(`${this.#config.baseUrl}/v1/recall:revalidate`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.#config.bearerToken}`,
            "Content-Type": "application/json",
          },
          body,
          signal,
        });
        signal.throwIfAborted();
        let result: MemoryRecallVerification;
        try {
          const value = (await response.json()) as {
            schema_version: unknown;
            checked_at: unknown;
            results: { request_id: unknown; status: unknown }[];
          };
          result = MemoryRecallVerificationSchema.parse({
            schemaVersion: value.schema_version,
            checkedAt: value.checked_at,
            results: value.results.map((r) => ({ requestId: r.request_id, status: r.status })),
          });
        } catch {
          throw new IrisBoundaryError("invalid_revalidation_response", false);
        }
        signal.throwIfAborted();
        if (
          new Set(result.results.map((r) => r.requestId)).size !== result.results.length ||
          result.results.length !== requests.length ||
          result.results.some((r) => !requests.some((request) => request.requestId === r.requestId))
        )
          throw new IrisBoundaryError("revalidation_response_identity_mismatch", false);
        return result;
      },
    );
  }
}
