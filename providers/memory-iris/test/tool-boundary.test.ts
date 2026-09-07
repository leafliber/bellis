import { expect, it, vi } from "vitest";
import {
  IrisToolBoundary,
  freezeIrisToolRequest,
  type IrisToolRequest,
} from "../src/tool-boundary.js";

const claim = {
  claim_id: "claim",
  agent_id: "agent",
  subject_entity_id: "subject",
  current_subject_entity_id: "subject",
  predicate: "likes",
  category: "preference",
  status: "active",
  canonical_text: "Tea",
  revision: 1,
  confidence: 1,
  importance: 0.5,
  accessibility: 1,
  source_authority: "user_statement",
  evidence_count: 1,
  recorded_at_us: 1,
  value: "tea",
};
const forgotten = {
  request_id: "forget",
  selector_key: "resource:claim:claim",
  target_count: 3,
  erased_count: 1,
  protected_skipped: 1,
  held_skipped: 1,
  tombstone_seq_lo: 1,
  tombstone_seq_hi: 1,
};
const remember = (): IrisToolRequest => ({
  operation: "remember",
  idempotencyKey: "original-key",
  record: {
    agent_id: "agent",
    space_id: "space",
    subject_entity_id: "subject",
    predicate: "likes",
    value: "tea",
    evidence: [
      {
        source_type: "observation",
        source_id: "obs",
        relation: "supports",
        source_authority: "user_statement",
      },
    ],
  },
});
const boundary = (transport: typeof fetch, timeoutMs = 1000) =>
  new IrisToolBoundary({
    baseUrl: "http://127.0.0.1",
    bearerToken: "secret-token",
    transport,
    timeoutMs,
  });

it("reports only allowlisted FTS readiness reasons without remote diagnostic text", async () => {
  for (const reason of ["fts_rebuild_pending", "private_diagnostic"]) {
    const b = boundary(async () =>
      Response.json(
        {
          error: {
            code: "not_ready",
            retryable: true,
            details: { reason_code: reason, secret: "private text" },
          },
        },
        { status: 503 },
      ),
    );
    const error = await b
      .execute(
        { operation: "memory_search", record: { agent_id: "agent", query: "tea" } },
        new AbortController().signal,
      )
      .catch((value) => value);
    expect(error).toMatchObject({ code: "not_ready", status: 503 });
    expect(error.reasonCode).toBe(reason === "fts_rebuild_pending" ? reason : undefined);
    expect(JSON.stringify(error)).not.toContain("private");
  }
});

it("uses the installed SDK for all four routes, preserving business keys, revisions and lease proof", async () => {
  const sent: {
    path: string;
    body: unknown;
    key: string | null;
    signal: AbortSignal | null | undefined;
  }[] = [];
  const b = boundary(async (url, init) => {
    const path = new URL(String(url)).pathname;
    sent.push({
      path,
      body: JSON.parse(String(init?.body)),
      key: new Headers(init?.headers).get("Idempotency-Key"),
      signal: init?.signal,
    });
    return Response.json(
      path === "/v1/search" ? { results: [] } : path === "/v1/memory:forget" ? forgotten : claim,
    );
  });
  const signal = new AbortController().signal;
  await b.execute(
    { operation: "memory_search", record: { agent_id: "agent", query: "tea", space_id: "space" } },
    signal,
  );
  await b.execute(remember(), signal);
  await b.execute(
    {
      operation: "correct",
      claimId: "claim/slash",
      idempotencyKey: "correct-key",
      record: {
        expected_revision: 1,
        reason: "trusted correction",
        value: "coffee",
        lease_id: "lease",
        lease_epoch: 7,
      },
    },
    signal,
  );
  expect(
    await b.execute(
      {
        operation: "forget",
        idempotencyKey: "forget-key",
        record: {
          selector: { kind: "resource", resource_type: "claim", resource_id: "claim" },
          reason: "trusted forget",
          erase_content: true,
        },
      },
      signal,
    ),
  ).toEqual(forgotten);
  expect(sent.map((row) => row.path)).toEqual([
    "/v1/search",
    "/v1/claims:remember",
    "/v1/claims/claim%2Fslash:correct",
    "/v1/memory:forget",
  ]);
  expect(sent.map((row) => row.key)).toEqual([null, "original-key", "correct-key", "forget-key"]);
  expect(sent[2]?.body).toMatchObject({ expected_revision: 1, lease_id: "lease", lease_epoch: 7 });
  expect(sent.every((row) => row.signal instanceof AbortSignal)).toBe(true);
});

it("freezes a deep copy before dispatch and rejects unknown envelope fields and invalid public requests", async () => {
  const request = remember();
  const frozen = freezeIrisToolRequest(request);
  (request.record as Record<string, unknown>).value = "mutated";
  expect(frozen.record.value).toBe("tea");
  expect(Object.isFrozen(frozen.record.evidence)).toBe(true);
  const transport = vi.fn<typeof fetch>();
  const b = boundary(transport);
  for (const bad of [
    { ...remember(), bearerToken: "must-not-persist" },
    { ...remember(), record: { ...remember().record, evidence: [] } },
    {
      ...remember(),
      record: { ...remember().record, actor_external_identity_id: "not-a-public-claim-field" },
    },
    {
      operation: "correct",
      claimId: "claim",
      idempotencyKey: "k",
      record: { expected_revision: 9007199254740992, reason: "r" },
    },
    {
      operation: "forget",
      idempotencyKey: "k",
      record: { selector: { kind: "invalid" }, reason: "r" },
    },
    { ...remember(), record: { ...remember().record, value: "x".repeat(65_536) } },
  ])
    await expect(
      b.execute(bad as IrisToolRequest, new AbortController().signal),
    ).rejects.toMatchObject({ code: "invalid_tool_request" });
  expect(transport).not.toHaveBeenCalled();
});

it("cancels the actual request and preserves unknown outcome, while retaining an uncooperative transport permit", async () => {
  let finish!: (response: Response) => void;
  let wireSignal: AbortSignal | null | undefined;
  const transport = vi.fn<typeof fetch>(async (_, init) => {
    wireSignal = init?.signal;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const b = boundary(transport, 20);
  await expect(b.execute(remember(), new AbortController().signal)).rejects.toMatchObject({
    code: "tool_outcome_unknown",
    remoteOutcome: "unknown",
    causeCode: "request_timeout",
  });
  expect(wireSignal?.aborted).toBe(true);
  await expect(b.execute(remember(), new AbortController().signal)).rejects.toMatchObject({
    code: "operation_busy",
  });
  expect(transport).toHaveBeenCalledTimes(1);
  finish(Response.json(claim));
  await new Promise((resolve) => setTimeout(resolve, 10));
  transport.mockResolvedValue(Response.json(claim));
  expect(await b.execute(remember(), new AbortController().signal)).toEqual(claim);
  expect(new Headers(transport.mock.calls[1]?.[1]?.headers).get("Idempotency-Key")).toBe(
    "original-key",
  );
});

it("distinguishes definite revision rejection from lost responses and redacts remote error details", async () => {
  const rejected = boundary(async () =>
    Response.json(
      {
        error: {
          code: "revision_conflict",
          retryable: false,
          message: "secret-token private memory",
        },
      },
      { status: 409 },
    ),
  );
  await expect(rejected.execute(remember(), new AbortController().signal)).rejects.toMatchObject({
    code: "revision_conflict",
    status: 409,
  });
  for (const transport of [
    async () => {
      throw new Error("secret-token private memory");
    },
    async () =>
      Response.json(
        { error: { code: "server_error", retryable: true, message: "private memory" } },
        { status: 500 },
      ),
    async () => Response.json({ ...claim, revision: 9007199254740992 }),
    async () => Response.json({ malformed: "secret-token private memory" }),
  ]) {
    const error = await boundary(transport)
      .execute(remember(), new AbortController().signal)
      .catch((value) => value);
    expect(error).toMatchObject({ code: "tool_outcome_unknown" });
    expect(JSON.stringify(error)).not.toContain("private memory");
    expect(String(error)).not.toContain("secret-token");
  }
  const cancelled = new AbortController();
  cancelled.abort(new Error("private reason"));
  const transport = vi.fn<typeof fetch>();
  await expect(boundary(transport).execute(remember(), cancelled.signal)).rejects.toMatchObject({
    code: "request_cancelled",
  });
  expect(transport).not.toHaveBeenCalled();
});

it("reads a frozen target through the public SDK and rejects unsafe or mismatched target responses", async () => {
  const transport = vi.fn<typeof fetch>(async () => Response.json(claim));
  const result = await boundary(transport).readClaim("claim", new AbortController().signal);
  expect(result).toEqual(claim);
  expect(Object.isFrozen(result)).toBe(true);
  expect(new URL(String(transport.mock.calls[0]?.[0])).pathname).toBe("/v1/claims/claim");
  for (const change of [
    { claim_id: "another" },
    { revision: 0 },
    { revision: 9007199254740992 },
    { recorded_at_us: 9007199254740992 },
  ]) {
    const error = await boundary(async () => Response.json({ ...claim, ...change }))
      .readClaim("claim", new AbortController().signal)
      .catch((value) => value);
    expect(error).toBeInstanceOf(Error);
    expect(error.remoteOutcome).toBeUndefined();
  }
  const error = await boundary(async () => {
    throw new Error("private-token private-memory");
  })
    .readClaim("claim", new AbortController().signal)
    .catch((value) => value);
  expect(error).toMatchObject({ code: "target_read_failed" });
  expect(String(error)).not.toContain("private");
});

it("retains a timed-out target read permit so a write cannot bypass its still-running transport", async () => {
  let finish!: (value: Response) => void;
  let wireSignal: AbortSignal | null | undefined;
  const transport = vi.fn<typeof fetch>(async (_url, init) => {
    wireSignal = init?.signal;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const b = boundary(transport, 20),
    signal = new AbortController().signal;
  await expect(b.readClaim("claim", signal)).rejects.toMatchObject({ code: "request_timeout" });
  expect(wireSignal?.aborted).toBe(true);
  await expect(b.execute(remember(), signal)).rejects.toMatchObject({ code: "operation_busy" });
  expect(transport).toHaveBeenCalledTimes(1);
  finish(Response.json(claim));
  await new Promise((resolve) => setTimeout(resolve, 10));
  transport.mockImplementation(async () => Response.json(claim));
  expect(await b.execute(remember(), signal)).toEqual(claim);
});
