import { describe, expect, it } from "vitest";
import { checkedIrisFetch, IrisBoundaryError } from "../src/http.js";
import { decimalToSafeInteger, validateObservation } from "../src/validation.js";
import { mapRecallCandidate } from "../src/mapping.js";
import { personaCanonicalFromWire } from "../src/persona-canonical.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { MemoryObserveEvent, MemoryQuery } from "@bellis/contracts/memory";
import type { RecallCandidate, RecallResponse } from "@iris-memory/sdk";

const observation: MemoryObserveEvent = {
  schemaVersion: 1,
  eventId: "event",
  outboxId: "outbox",
  agentId: "agent",
  role: "assistant",
  kind: "message.text",
  occurredAtMs: 1,
  committedAtMs: 2,
  effectState: "partial",
  content: "prefix",
  effectProof: { confirmed_range: { unit: "utf16", start: 0, end: 6 } },
};

describe("Iris public boundary", () => {
  it("caps successful response bodies before SDK JSON parsing and cancels oversized streams", async () => {
    let cancelled = false;
    const transport = (async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(1_048_577));
          },
          cancel() {
            cancelled = true;
          },
        }),
      )) as typeof fetch;
    await expect(checkedIrisFetch(transport)("http://127.0.0.1/v1/recall")).rejects.toMatchObject({
      code: "response_too_large",
      retryable: false,
    });
    expect(cancelled).toBe(true);
  });
  it("matches independently generated Python numeric and Unicode canonical fixtures", () => {
    const fixtures = JSON.parse(
      readFileSync(new URL("./fixtures/python-persona-canonical-v1.json", import.meta.url), "utf8"),
    ) as { wire: string; canonical: string; sha256: string }[];
    for (const fixture of fixtures) {
      const canonical = personaCanonicalFromWire(fixture.wire);
      expect(canonical).toBe(fixture.canonical);
      expect(createHash("sha256").update(canonical).digest("hex")).toBe(fixture.sha256);
    }
  });
  it("rejects partial output without proof and committed output with proof", () => {
    expect(() => validateObservation(observation)).not.toThrow();
    expect(() => validateObservation({ ...observation, effectProof: {} })).toThrow(
      /confirmed_range/,
    );
    expect(() => validateObservation({ ...observation, effectState: "committed" })).toThrow(
      /must not/,
    );
    expect(() => validateObservation({ ...observation, sourceStream: "stream" })).toThrow(
      /together/,
    );
  });

  it("rejects already rounded decimal revisions instead of reconstructing precision", () => {
    expect(decimalToSafeInteger("9007199254740991", "revision")).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => decimalToSafeInteger("9007199254740993", "revision")).toThrow(/safe integer/);
    expect(() => decimalToSafeInteger("01", "revision")).toThrow(/decimal/);
  });

  it("retains structured source hashes and rejects invalid ones", () => {
    const candidate = {
      candidate_id: "cand:0123456789abcdef",
      resource_ref: { resource_type: "claim", resource_id: "claim", revision: 1 },
      category: "fact",
      content_hash: "a".repeat(16),
      text: "different text hash",
      placement: "memory",
      privacy_labels: [],
      source_refs: [],
      token_estimate: 4,
    } as unknown as RecallCandidate;
    const query = { privacyScope: "space:one" } as MemoryQuery;
    const response = { cache_until: null } as RecallResponse;
    expect(mapRecallCandidate(candidate, 0, 1, query, response).block?.contentHash).toBe(
      "a".repeat(16),
    );
    expect(
      mapRecallCandidate({ ...candidate, content_hash: "invalid" }, 0, 1, query, response).dropped,
    ).toBe(true);
    expect(
      mapRecallCandidate(
        {
          ...candidate,
          resource_ref: { ...candidate.resource_ref, revision: Number.MAX_SAFE_INTEGER + 1 },
        },
        0,
        1,
        query,
        response,
      ).dropped,
    ).toBe(true);
  });

  it("classifies non-2xx errors without retaining private message text", async () => {
    const transport = (async () =>
      new Response(
        JSON.stringify({
          error: {
            code: "permission_denied",
            retryable: true,
            message: "PRIVATE_CANARY",
          },
        }),
        { status: 403 },
      )) as typeof fetch;
    const request = checkedIrisFetch(transport)("http://127.0.0.1/v1/recall");
    await expect(request).rejects.toMatchObject({
      code: "permission_denied",
      retryable: false,
      status: 403,
    });
    await expect(request).rejects.not.toThrow("PRIVATE_CANARY");
  });

  it("keeps cancellation and malformed HTTP failures distinguishable", async () => {
    const reason = new DOMException("cancelled", "AbortError");
    const cancelled = checkedIrisFetch((async () => {
      throw reason;
    }) as typeof fetch);
    await expect(cancelled("http://127.0.0.1")).rejects.toBe(reason);
    const malformed = checkedIrisFetch(
      (async () => new Response("x".repeat(20_000), { status: 503 })) as typeof fetch,
    );
    await expect(malformed("http://127.0.0.1")).rejects.toEqual(
      new IrisBoundaryError("http_error", true, 503),
    );
  });
});
