import { describe, expect, it } from "vitest";
import { createPersistenceClient } from "../../src/index.js";
import { WORKER_FIXTURE, createTempDataDirectory, cleanupTempDataDirectory } from "../helpers.js";

const scope = { scopeKey: "a".repeat(64), providerId: "iris" };

describe("Phase 4 provider state through DB Worker", () => {
  it("restores barriers, isolates scopes, deduplicates lost acknowledgments and fences stale writers", async () => {
    const directory = createTempDataDirectory("provider-state");
    let client = createPersistenceClient({ dataDirectory: directory, worker: WORKER_FIXTURE });
    const state = {
      version: 1,
      personaBarriers: { agent: { reason: "revoked", minimumRevision: "2" } },
    };
    try {
      await client.migrate();
      expect(await client.phase4ReadProviderState(scope)).toBeNull();
      const write = { ...scope, expectedRevision: 0, state };
      expect(await client.phase4WriteProviderState(write)).toBe(1);
      await client.close();
      client = createPersistenceClient({ dataDirectory: directory, worker: WORKER_FIXTURE });
      await client.migrate();
      expect(await client.phase4ReadProviderState(scope)).toEqual({ revision: 1, state });
      expect(await client.phase4WriteProviderState(write)).toBe(1);
      expect(
        await client.phase4ReadProviderState({ ...scope, scopeKey: "b".repeat(64) }),
      ).toBeNull();
      expect(
        await client.phase4ReadProviderState({ ...scope, providerId: "different" }),
      ).toBeNull();
      const newer = {
        version: 1,
        personaBarriers: { agent: { reason: "revoked", minimumRevision: "3" } },
      };
      expect(
        await client.phase4WriteProviderState({ ...scope, expectedRevision: 1, state: newer }),
      ).toBe(2);
      await expect(client.phase4WriteProviderState(write)).rejects.toMatchObject({
        code: "idempotency_conflict",
      });
      await expect(
        client.phase4WriteProviderState({ ...write, expectedRevision: 1 }),
      ).rejects.toMatchObject({ code: "idempotency_conflict" });
      expect(await client.phase4ReadProviderState(scope)).toEqual({ revision: 2, state: newer });
    } finally {
      await client.close();
      cleanupTempDataDirectory(directory);
    }
  });

  it("bounds persistent snapshots by count, individual bytes and aggregate bytes without evicting barriers", async () => {
    const directory = createTempDataDirectory("provider-quota");
    const client = createPersistenceClient({ dataDirectory: directory, worker: WORKER_FIXTURE });
    try {
      await client.migrate();
      for (let index = 0; index < 128; index++) {
        await client.phase4WriteProviderState({
          ...scope,
          providerId: String(index),
          expectedRevision: 0,
          state: { blocked: true },
        });
      }
      await expect(
        client.phase4WriteProviderState({ ...scope, expectedRevision: 0, state: {} }),
      ).rejects.toMatchObject({ code: "invalid_request" });
      await expect(
        client.phase4WriteProviderState({
          ...scope,
          providerId: "0",
          expectedRevision: 1,
          state: "x".repeat(262_144),
        }),
      ).rejects.toMatchObject({ code: "invalid_request" });
      for (let index = 0; index < 33; index++) {
        await client.phase4WriteProviderState({
          ...scope,
          providerId: String(index),
          expectedRevision: 1,
          state: "x".repeat(250_000),
        });
      }
      await expect(
        client.phase4WriteProviderState({
          ...scope,
          providerId: "33",
          expectedRevision: 1,
          state: "x".repeat(250_000),
        }),
      ).rejects.toMatchObject({ code: "invalid_request" });
      expect(await client.phase4ReadProviderState({ ...scope, providerId: "33" })).toEqual({
        revision: 1,
        state: { blocked: true },
      });
    } finally {
      await client.close();
      cleanupTempDataDirectory(directory);
    }
  });
});
