import { DatabaseSync } from "node:sqlite";
import { statSync } from "node:fs";
import { expect, it } from "vitest";
import { createPersistenceClient } from "../../src/index.js";
import {
  SESSION_ID,
  TRACE,
  WORKER_FIXTURE,
  createTempDataDirectory,
  cleanupTempDataDirectory,
} from "../helpers.js";
import { fixture, adopt, commit, confirm } from "../phase4-effect-fixtures.js";

it.each([false, true])(
  "restores completion with an external WAL snapshot (in-flight delivery: %s)",
  async (inFlight) => {
    const directory = createTempDataDirectory("completion-restart-pressure-");
    const options = {
      dataDirectory: directory,
      worker: WORKER_FIXTURE,
      diskAdmission: { walHighWaterBytes: 16 * 1024 ** 2 },
    };
    let client = createPersistenceClient(options);
    let reader: DatabaseSync | undefined;
    try {
      await client.migrate();
      await client.ensureSession({ sessionId: SESSION_ID, createdAtMs: 0, trace: TRACE });
      const plans = Array.from({ length: 4 }, () => fixture("subtitle"));
      const receipts = plans.map((f) => f.receipt());
      for (const [index, f] of plans.entries()) {
        await adopt(client, f, index);
        await client.phase4PrepareEffects(f.preparation);
        await commit(client, f);
        expect((await confirm(client, receipts[index]!)).outcome).toBe("recorded");
      }
      if (inFlight)
        expect(
          await client.claimOutbox({ limit: 4, leaseMs: 30_000, ownerInstanceId: "old-worker" }),
        ).toHaveLength(1);
      reader = new DatabaseSync(`${directory}/state.db`, { readOnly: true });
      reader.exec("BEGIN");
      expect(
        reader.prepare("SELECT count(*) AS n FROM phase4_completion_reservations").get()!.n,
      ).toBe(4);
      const scope = { scopeKey: "f".repeat(64), providerId: "background" };
      let revision = 0;
      for (; revision < 200; revision++) {
        try {
          await client.phase4WriteProviderState({
            ...scope,
            expectedRevision: revision,
            state: { text: String.fromCharCode(65 + (revision % 26)).repeat(250_000) },
          });
        } catch (error) {
          expect(error).toMatchObject({ code: "storage_not_ready" });
          break;
        }
      }
      expect(revision).toBeGreaterThan(0);
      expect(revision).toBeLessThan(200);
      expect(await client.readDiskStatus()).toMatchObject({ ready: false, reason: "wal_pressure" });
      await client.close();
      client = createPersistenceClient(options);
      if (inFlight) {
        // Lease recovery is a real ordinary write, with no Scene completion
        // credit. Fail closed and preserve it until the checkpoint can proceed.
        await expect(client.migrate()).rejects.toMatchObject({ code: "storage_not_ready" });
        await expect(client.readDiskStatus()).rejects.toMatchObject({ code: "not_migrated" });
        expect(
          reader.prepare("SELECT count(*) AS n FROM outbox WHERE status = 'in_flight'").get()!.n,
        ).toBe(1);
        reader.close();
        reader = undefined;
        await client.migrate();
        expect(await client.readOutboxStats()).toMatchObject({ pending: 4, inFlight: 0 });
        expect((await client.readDiskStatus()).capacity!.activeCompletionReservations).toBe(0);
        for (const receipt of receipts)
          expect((await confirm(client, receipt)).outcome).toBe("duplicate");
        return;
      }
      await client.migrate();
      expect(await client.readDiskStatus()).toMatchObject({
        ready: false,
        reason: "wal_pressure",
        capacity: { activeCompletionReservations: 0, stateReservedBytes: 0 },
      });
      expect((await client.readOutboxStats()).pending).toBe(4);
      expect(await client.phase4ReadConfirmedSpeech(SESSION_ID)).toHaveLength(4);
      for (const [index, f] of plans.entries()) {
        expect((await confirm(client, receipts[index]!)).outcome).toBe("duplicate");
        await expect(confirm(client, f.receipt(1))).rejects.toMatchObject({
          code: "invalid_request",
        });
      }
      await expect(adopt(client, fixture("subtitle"), 4)).rejects.toMatchObject({
        code: "storage_not_ready",
      });
      // The independent transaction still sees its original four credits. A second
      // restart has nothing to close and must not emit another WAL transaction.
      expect(
        reader.prepare("SELECT count(*) AS n FROM phase4_completion_reservations").get()!.n,
      ).toBe(4);
      const walBytes = statSync(`${directory}/state.db-wal`).size;
      await client.close();
      client = createPersistenceClient(options);
      await client.migrate();
      expect(statSync(`${directory}/state.db-wal`).size).toBe(walBytes);
      expect((await client.readOutboxStats()).pending).toBe(4);
      reader.close();
      reader = undefined;
      expect((await client.readDiskStatus()).ready).toBe(true);
      for (let index = 0; index < 4; index++) {
        const messages = await client.claimOutbox({
          limit: 4,
          leaseMs: 30_000,
          ownerInstanceId: "recovered",
        });
        // A partition delivers in order, with one outstanding row at a time.
        expect(messages).toHaveLength(1);
        expect(messages[0]!.payload).toMatchObject({ event: { sourceCursor: String(index + 1) } });
        await client.completeOutbox({
          outboxId: messages[0]!.outboxId,
          ownerInstanceId: "recovered",
        });
      }
      expect(await client.readOutboxStats()).toMatchObject({
        pending: 0,
        inFlight: 0,
        delivered: 4,
      });
      await adopt(client, fixture("subtitle"), 4);
    } finally {
      reader?.close();
      await client.close();
      cleanupTempDataDirectory(directory);
    }
  },
);
