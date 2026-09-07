import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { IrisRecallVerifier } from "../src/recall-verifier.js";
const request = () => ({
  schemaVersion: 1 as const,
  attemptId: randomUUID(),
  requestId: "original",
  agentId: "agent",
  spaceId: "space",
  body: {
    request_id: "original",
    scope: { agent_id: "agent", space_id: "space" },
    topic: "original topic",
    deadline_at: "2020-01-01T00:00:00Z",
  },
});
const capabilities = {
  api_version: "v1",
  schema_version: 20,
  capabilities: ["recall.revalidate.v1"],
};
const response = {
  schema_version: 1,
  checked_at: "2026-09-07T00:00:00Z",
  results: [{ request_id: "original", status: "valid" }],
};
const config = {
  baseUrl: "http://localhost:9999",
  bearerToken: "fixture-token",
  agentId: "agent",
  spaceId: "space",
  minimumCoreSchemaVersion: 20,
  maximumCoreSchemaVersion: 20,
};

it("uses the installed SDK negotiation and bounded public HTTP with the complete original body and fresh deadline", async () => {
  const bodies: unknown[] = [],
    urls: string[] = [];
  const transport = vi.fn(async (input, init) => {
    urls.push(String(input));
    expect(init.headers.Authorization).toBe("Bearer fixture-token");
    expect(init.redirect).toBe("error");
    bodies.push(JSON.parse(init.body));
    return Response.json(urls.length % 2 ? capabilities : response);
  }) as unknown as typeof fetch;
  const verifier = new IrisRecallVerifier({ ...config, fetch: transport });
  const original = request();
  expect(await verifier.verify([original], new AbortController().signal)).toEqual({
    schemaVersion: 1,
    checkedAt: response.checked_at,
    results: [{ requestId: "original", status: "valid" }],
  });
  expect(bodies[1]).toMatchObject({ requests: [original.body] });
  expect(Date.parse((bodies[1] as { deadline_at: string }).deadline_at)).toBeGreaterThan(
    Date.now(),
  );
  await verifier.verify([original], new AbortController().signal);
  expect(urls.filter((url) => url.endsWith("/v1/recall:revalidate"))).toHaveLength(2);
  verifier.stop();
  await expect(verifier.verify([original], new AbortController().signal)).rejects.toThrow(
    "stopped",
  );
  expect(urls).toHaveLength(4);
});

it("rejects unsupported capability/schema and cross-identity original bodies before verification HTTP", async () => {
  for (const negotiated of [
    { ...capabilities, capabilities: [] },
    { ...capabilities, schema_version: 21 },
  ]) {
    const transport = vi.fn(async () => Response.json(negotiated)) as unknown as typeof fetch;
    const verifier = new IrisRecallVerifier({ ...config, fetch: transport });
    await expect(verifier.verify([request()], new AbortController().signal)).rejects.toMatchObject({
      code: "revalidation_unsupported",
    });
    expect(transport).toHaveBeenCalledTimes(1);
  }
  const transport = vi.fn() as unknown as typeof fetch;
  const verifier = new IrisRecallVerifier({ ...config, fetch: transport });
  const original = request();
  await expect(
    verifier.verify(
      [
        {
          ...original,
          body: { ...original.body, scope: { ...original.body.scope, agent_id: "other" } },
        },
      ],
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: "revalidation_identity_mismatch" });
  await expect(
    verifier.verify([original, original], new AbortController().signal),
  ).rejects.toBeDefined();
  await expect(
    verifier.verify(
      [{ ...original, body: { ...original.body, topic: "x".repeat(1048576) } }],
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: "revalidation_request_too_large" });
  expect(transport).not.toHaveBeenCalled();
});

it("rejects partial, duplicate, unknown or malformed response identities without yielding verdicts", async () => {
  for (const results of [
    [],
    [response.results[0], response.results[0]],
    [{ request_id: "other", status: "valid" }],
    [{ request_id: "original", status: "partial" }],
  ]) {
    let calls = 0;
    const verifier = new IrisRecallVerifier({
      ...config,
      fetch: (async () =>
        Response.json(++calls === 1 ? capabilities : { ...response, results })) as typeof fetch,
    });
    await expect(verifier.verify([request()], new AbortController().signal)).rejects.toBeDefined();
  }
});

it("cancels an uncooperative transport promptly but retains its busy slot until it settles", async () => {
  let release!: (response: Response) => void;
  const transport = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
  ) as unknown as typeof fetch;
  const verifier = new IrisRecallVerifier({ ...config, fetch: transport });
  const cancel = new AbortController();
  const pending = verifier.verify([request()], cancel.signal);
  await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
  cancel.abort(new Error("cancel-verification"));
  await expect(pending).rejects.toThrow("cancel-verification");
  await expect(verifier.verify([request()], new AbortController().signal)).rejects.toMatchObject({
    code: "operation_busy",
  });
  release(Response.json(capabilities));
  verifier.stop();
});
