import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { SystemMonotonicClock } from "../../../packages/transport/dist/index.js";
import { StandardToolRuntime, type ToolExecutionContext } from "@bellis/tool-runtime";
import type { JsonValue, PreparedToolCall, ToolCall } from "@bellis/contracts";
import { registerIrisTools, type IrisToolAuthority, type IrisToolGrant } from "../src/tools.js";
import { IrisToolBoundary } from "../src/tool-boundary.js";

const claim = {
  claim_id: "claim",
  agent_id: "agent",
  subject_entity_id: "subject",
  current_subject_entity_id: "subject",
  predicate: "likes",
  category: "preference",
  status: "active",
  canonical_text: "Tea",
  revision: 2,
  confidence: 1,
  importance: 0.5,
  accessibility: 1,
  source_authority: "user_statement",
  evidence_count: 1,
  recorded_at_us: 1,
  value: "tea",
  privacy_labels: ["space:space"],
  scope: { space_group_id: null, space_id: "space", session_id: "core-session" },
};
const readableClaim = { ...claim, revision: 1 };
const forgotten = {
  request_id: "forgotten",
  selector_key: "resource:claim:claim",
  target_count: 3,
  erased_count: 1,
  protected_skipped: 1,
  held_skipped: 1,
  tombstone_seq_lo: 1,
  tombstone_seq_hi: 1,
};
const grant = (): IrisToolGrant => ({
  policy: { scopeKey: "a".repeat(64), generation: 0 },
  reason: "trusted user request",
  subject: { self: true },
  privacyLabels: ["space:space"],
  sourceAuthority: "user_statement",
  evidence: [
    {
      source_type: "observation",
      source_id: "trusted-observation",
      relation: "supports",
      source_authority: "user_statement",
    },
  ],
  target: { claimId: "claim", revision: 1 },
});
const call = (toolName: string, args: Record<string, JsonValue>): ToolCall => ({
  schemaVersion: 1,
  toolRunId: randomUUID(),
  toolName,
  arguments: args,
  idempotencyKey: "model-key",
});
const context = (): ToolExecutionContext => ({
  sessionId: randomUUID(),
  turnId: randomUUID(),
  cycleId: randomUUID(),
  traceId: "1".repeat(32),
  signal: new AbortController().signal,
  capabilities: new Set(["memory.read", "memory.write", "memory.forget"]),
  idempotencyKeys: new Map(),
  maxParallelTools: 1,
});
function fixture(
  overrides: Partial<IrisToolAuthority> = {},
  transport?: typeof fetch,
  confirm?: () => Promise<boolean>,
  selfEntityId: string | null = "subject",
) {
  const reads: string[] = [];
  const calls: { path: string; body: Record<string, JsonValue>; key: string | null }[] = [];
  const order: string[] = [];
  const saved = new Map<string, PreparedToolCall>();
  const authority: IrisToolAuthority = {
    authorize: vi.fn(async ({ operation }) => {
      const { target, ...base } = grant();
      return operation === "remember" || operation === "memory_search"
        ? base
        : { ...base, target: target! };
    }),
    assertCurrent: vi.fn(async () => {
      order.push("current");
    }),
    beforeForget: vi.fn(async () => {
      order.push("block");
    }),
    afterForget: vi.fn(async () => {
      order.push("tombstone");
    }),
    filterResult: vi.fn(async (_prepared, result) => {
      order.push("filter");
      return result;
    }),
    ...overrides,
  };
  const boundary = new IrisToolBoundary({
    baseUrl: "http://127.0.0.1",
    bearerToken: "secret",
    transport:
      transport ??
      (async (url, init) => {
        const path = new URL(String(url)).pathname;
        if ((init?.method ?? "GET") === "GET") {
          reads.push(path);
          return Response.json(readableClaim);
        }
        calls.push({
          path,
          body: JSON.parse(String(init?.body)),
          key: new Headers(init?.headers).get("Idempotency-Key"),
        });
        order.push("http");
        return Response.json(
          path === "/v1/search"
            ? { results: [] }
            : path === "/v1/memory:forget"
              ? forgotten
              : claim,
        );
      }),
  });
  const runtime = new StandardToolRuntime({
    clock: new SystemMonotonicClock(),
    wallClockMs: Date.now,
    preparationStore: {
      load: async (_session, run) => saved.get(run) ?? null,
      save: async (value) => {
        saved.set(value.toolRunId, value);
      },
    },
    confirmation: {
      confirm: async (request) => {
        expect(request.prepared).toEqual(saved.get(request.toolRunId));
        order.push("confirm");
        return confirm ? confirm() : true;
      },
    },
  });
  registerIrisTools(runtime, {
    agentId: "agent",
    spaceId: "space",
    coreSessionId: "core-session",
    ...(selfEntityId === null ? {} : { selfEntityId }),
    boundary,
    authority,
  });
  return {
    runtime,
    authority,
    calls,
    reads,
    order,
    saved,
    execute: async (input: ToolCall, executionContext = context()) =>
      (await runtime.executeDag(runtime.compileDag([input]), executionContext)).results[0]!,
  };
}

it("registers all four tools with closed model schemas, capabilities and no result caches", async () => {
  const f = fixture();
  try {
    expect(
      f.runtime
        .listDeclarations()
        .map((d) => [d.name, d.requiredCapabilities, d.requiresConfirmation, d.cache]),
    ).toEqual([
      ["memory_search", ["memory.read"], false, null],
      ["remember", ["memory.write"], true, null],
      ["correct", ["memory.write"], true, null],
      ["forget", ["memory.forget"], true, null],
    ]);
    for (const [name, args] of [
      ["memory_search", { query: "tea", agent_id: "evil" }],
      ["remember", { predicate: "likes", value: "tea", evidence: [] }],
      ["correct", { claimId: "claim", value: "tea", expected_revision: 99 }],
      ["forget", { claimId: "claim", selector: { kind: "all" } }],
    ] as const) {
      expect(f.runtime.validateArguments(name, args).ok).toBe(false);
    }
    const denied = await f.execute(call("remember", { predicate: "likes", value: "tea" }), {
      ...context(),
      capabilities: new Set(),
    });
    expect(denied.errorCode).toBe("capability_missing");
    expect(f.authority.authorize).not.toHaveBeenCalled();
    expect(f.calls).toHaveLength(0);
  } finally {
    await f.runtime.close("done");
  }
});

it("injects trusted scope, evidence, revisions and business keys through the installed SDK for all four tools", async () => {
  const f = fixture();
  try {
    for (const input of [
      call("memory_search", { query: "tea" }),
      call("remember", { predicate: "likes", value: "tea" }),
      call("correct", { claimId: "claim", value: "oolong" }),
      call("forget", { claimId: "claim" }),
    ]) {
      expect((await f.execute(input)).outcome).toBe("succeeded");
    }
    expect(f.reads).toEqual(Array(4).fill("/v1/claims/claim"));
    expect(f.calls.map((c) => c.path)).toEqual([
      "/v1/search",
      "/v1/claims:remember",
      "/v1/claims/claim:correct",
      "/v1/memory:forget",
    ]);
    expect(f.calls[0]?.body).toMatchObject({
      agent_id: "agent",
      space_id: "space",
      session_id: "core-session",
    });
    expect(f.calls[1]?.body).toMatchObject({
      subject_is_self: true,
      evidence: grant().evidence,
      privacy_labels: ["space:space"],
    });
    expect(f.calls[2]?.body).toMatchObject({
      expected_revision: 1,
      reason: "trusted user request",
    });
    expect(f.calls[3]?.body).toMatchObject({
      selector: { kind: "resource", resource_type: "claim", resource_id: "claim" },
      erase_content: true,
    });
    expect(
      f.calls.slice(1).every((c) => c.key?.startsWith("bellis:iris:") && c.key !== "model-key"),
    ).toBe(true);
    expect(f.order.slice(-7)).toEqual([
      "confirm",
      "current",
      "current",
      "block",
      "http",
      "tombstone",
      "filter",
    ]);
    expect(f.authority.afterForget).toHaveBeenCalledWith(
      expect.anything(),
      forgotten,
      expect.anything(),
    );
  } finally {
    await f.runtime.close("done");
  }
});

it("denies absent authorization and mismatched resolved targets before confirmation or HTTP", async () => {
  for (const authorize of [
    async () => null,
    async () => ({ ...grant(), target: { claimId: "another-claim", revision: 3 } }),
  ]) {
    const f = fixture({ authorize });
    try {
      expect((await f.execute(call("correct", { claimId: "claim", value: "tea" }))).outcome).toBe(
        "failed",
      );
      expect(f.calls).toHaveLength(0);
      expect(f.order).not.toContain("confirm");
    } finally {
      await f.runtime.close("done");
    }
  }
});

it("recovers the saved host key/request without acquiring a new grant, but rechecks current authority", async () => {
  const f = fixture();
  const input = call("correct", { claimId: "claim", value: "tea" });
  const executionContext = context();
  try {
    expect((await f.execute(input, executionContext)).outcome).toBe("succeeded");
    expect((await f.execute(input, executionContext)).outcome).toBe("succeeded");
    expect(f.authority.authorize).toHaveBeenCalledTimes(1);
    expect(f.authority.assertCurrent).toHaveBeenCalledTimes(4);
    expect(f.calls[0]).toEqual(f.calls[1]);
  } finally {
    await f.runtime.close("done");
  }
});

it("rejects permission revoked during confirmation before dispatch", async () => {
  let revoked = false;
  const f = fixture(
    {
      assertCurrent: async () => {
        if (revoked) throw new Error("revoked");
      },
    },
    undefined,
    async () => {
      revoked = true;
      return true;
    },
  );
  try {
    expect((await f.execute(call("correct", { claimId: "claim", value: "tea" }))).errorCode).toBe(
      "iris_policy_rejected",
    );
    expect(f.calls).toHaveLength(0);
  } finally {
    await f.runtime.close("done");
  }
});

it("requires a durable Forget barrier before HTTP and leaves unknown writes blocked", async () => {
  const failed = fixture({
    beforeForget: async () => {
      throw new Error("DB unavailable");
    },
  });
  try {
    expect((await failed.execute(call("forget", { claimId: "claim" }))).errorCode).toBe(
      "iris_policy_rejected",
    );
    expect(failed.calls).toHaveLength(0);
  } finally {
    await failed.runtime.close("done");
  }
  let blocked = false;
  const unknown = fixture(
    {
      beforeForget: async () => {
        blocked = true;
      },
    },
    async (_url, init) => {
      if ((init?.method ?? "GET") === "GET") return Response.json(readableClaim);
      expect(blocked).toBe(true);
      throw new Error("lost response");
    },
  );
  try {
    expect((await unknown.execute(call("forget", { claimId: "claim" }))).errorCode).toBe(
      "tool_outcome_unknown",
    );
    expect(unknown.authority.afterForget).not.toHaveBeenCalled();
    expect(unknown.authority.filterResult).not.toHaveBeenCalled();
    expect(blocked).toBe(true);
  } finally {
    await unknown.runtime.close("done");
  }
});

it("does not expose results rejected by the current privacy filter and preserves definite Core rejections", async () => {
  const f = fixture({
    filterResult: async () => {
      throw new Error("private content must not escape");
    },
  });
  try {
    const result = await f.execute(call("memory_search", { query: "tea" }));
    expect(result.outcome).toBe("failed");
    expect(result.value).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("private");
  } finally {
    await f.runtime.close("done");
  }
  const conflict = fixture({}, async (_url, init) =>
    (init?.method ?? "GET") === "GET"
      ? Response.json(readableClaim)
      : Response.json({ error: { code: "revision_conflict", retryable: false } }, { status: 409 }),
  );
  try {
    const result = await conflict.execute(call("correct", { claimId: "claim", value: "tea" }));
    expect(result.errorCode).toBe("revision_conflict");
    expect(result.value).toBeUndefined();
  } finally {
    await conflict.runtime.close("done");
  }
});

it.each([
  ["agent", { agent_id: "another-agent" }],
  ["subject", { current_subject_entity_id: "another-subject" }],
  ["revision", { revision: 3 }],
  ["status", { status: "superseded" }],
  ["space", { scope: { space_id: "another-space" } }],
  ["session", { scope: { space_id: "space", session_id: "another-session" } }],
  ["unscoped session", { scope: { session_id: "core-session" } }],
  ["group membership", { scope: { space_group_id: "group", space_id: "space" } }],
  ["missing scope", { scope: null }],
  ["empty privacy labels", { privacy_labels: [] }],
  ["ungranted privacy label", { privacy_labels: ["space:space", "private"] }],
])("rejects an unauthorized target %s before saving or confirming", async (_name, change) => {
  const transport = vi.fn<typeof fetch>(async () => Response.json({ ...readableClaim, ...change }));
  const f = fixture({}, transport);
  try {
    expect((await f.execute(call("forget", { claimId: "claim" }))).outcome).toBe("failed");
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]?.[1]?.method ?? "GET").toBe("GET");
    expect(f.saved.size).toBe(0);
    expect(f.order).not.toContain("confirm");
    expect(f.authority.beforeForget).not.toHaveBeenCalled();
  } finally {
    await f.runtime.close("done");
  }
});

it.each([
  { revision: 2 },
  { canonical_text: "changed without revision" },
  { value: "changed without revision" },
  { privacy_labels: ["private"] },
  { scope: { space_id: "another-space" } },
])("rejects a target changed during confirmation: %j", async (change) => {
  let approved = false;
  const transport = vi.fn<typeof fetch>(async () =>
    Response.json({ ...readableClaim, ...(approved ? change : {}) }),
  );
  const f = fixture({}, transport, async () => {
    const prepared = [...f.saved.values()][0]!;
    expect(prepared.confirmation).toMatchObject({
      target: {
        claimId: "claim",
        subjectEntityId: "subject",
        revision: 1,
        canonicalText: "Tea",
        value: "tea",
      },
    });
    expect(Object.isFrozen(prepared.confirmation)).toBe(true);
    approved = true;
    return true;
  });
  try {
    expect(
      (await f.execute(call("correct", { claimId: "claim", value: "oolong" }))).errorCode,
    ).toBe("iris_policy_rejected");
    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport.mock.calls.every(([, init]) => (init?.method ?? "GET") === "GET")).toBe(true);
  } finally {
    await f.runtime.close("done");
  }
});

it("requires a trusted self identity mapping and accepts an explicitly authorized entity", async () => {
  const missing = fixture({}, undefined, undefined, null);
  const entity = fixture(
    { authorize: async () => ({ ...grant(), subject: { entityId: "subject" } }) },
    undefined,
    undefined,
    null,
  );
  try {
    expect((await missing.execute(call("forget", { claimId: "claim" }))).outcome).toBe("failed");
    expect(missing.reads).toHaveLength(0);
    expect(missing.order).not.toContain("confirm");
    expect((await entity.execute(call("forget", { claimId: "claim" }))).outcome).toBe("succeeded");
  } finally {
    await missing.runtime.close("done");
    await entity.runtime.close("done");
  }
});

it("rechecks host authority after target I/O before writing", async () => {
  let reads = 0,
    revoked = false;
  const transport = vi.fn<typeof fetch>(async () => {
    if (++reads === 2) revoked = true;
    return Response.json(readableClaim);
  });
  const f = fixture(
    {
      assertCurrent: async () => {
        if (revoked) throw new Error("revoked");
      },
    },
    transport,
  );
  try {
    expect((await f.execute(call("forget", { claimId: "claim" }))).errorCode).toBe(
      "iris_policy_rejected",
    );
    expect(transport).toHaveBeenCalledTimes(2);
    expect(f.authority.beforeForget).not.toHaveBeenCalled();
  } finally {
    await f.runtime.close("done");
  }
});
