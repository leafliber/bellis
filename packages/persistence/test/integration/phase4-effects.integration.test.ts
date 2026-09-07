import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createPersistenceClient } from "../../src/index.js";
import {
  SESSION_ID,
  TRACE,
  WORKER_FIXTURE,
  createTempDataDirectory,
  cleanupTempDataDirectory,
} from "../helpers.js";
import { target, fixture, adopt, commit, confirm } from "../phase4-effect-fixtures.js";
const claim = { limit: 100, leaseMs: 30_000, ownerInstanceId: "effect-test" };

describe("Phase 4 output confirmation through DB Worker", () => {
  it("suppresses historical delivery and late effects after privacy change, including after restart", async () => {
    const directory = createTempDataDirectory("phase4-effect-privacy");
    let client = createPersistenceClient({ dataDirectory: directory, worker: WORKER_FIXTURE });
    const scopeKey = "c".repeat(64);
    try {
      await client.migrate();
      await client.ensureSession({ sessionId: SESSION_ID, createdAtMs: 0, trace: TRACE });
      await client.phase4EnsureMemoryPolicy(scopeKey, "1");
      const policy = { scopeKey, generation: 0 };
      const f = fixture("subtitle");
      f.preparation.targets = [{ ...target, policy }];
      await adopt(client, f, 0, policy);
      await client.phase4PrepareEffects(f.preparation);
      await commit(client, f);
      expect((await confirm(client, f.receipt())).outcome).toBe("recorded");
      expect(await client.phase4ReadConfirmedSpeech(SESSION_ID, 20, policy)).toHaveLength(1);
      const leased = await client.claimOutbox(claim);
      expect(leased).toHaveLength(1);
      const change = {
        scopeKey,
        expectedGeneration: 0,
        changeId: randomUUID(),
        privacyRevision: "1",
        blocked: false,
        reason: "forget" as const,
        tombstones: [{ providerId: "iris", resourceRef: "iris:claim:one", throughRevision: null }],
      };
      expect((await client.phase4ChangeMemoryPolicy(change)).generation).toBe(1);
      expect((await client.readDiskStatus()).capacity).toMatchObject({
        activeCompletionReservations: 0,
        stateReservedBytes: 0,
        stateReservedWalBytes: 0,
      });
      expect(await confirm(client, f.receipt(1))).toMatchObject({
        outcome: "rejected",
        reason: "privacy_revoked",
      });
      await expect(
        client.completeOutbox({
          outboxId: leased[0]!.outboxId,
          ownerInstanceId: claim.ownerInstanceId,
        }),
      ).rejects.toMatchObject({ code: "not_claimed" });
      expect(await client.claimOutbox(claim)).toEqual([]);
      await expect(client.phase4ReadConfirmedSpeech(SESSION_ID, 20, policy)).rejects.toMatchObject({
        code: "invalid_request",
      });
      expect(
        await client.phase4ReadConfirmedSpeech(SESSION_ID, 20, { scopeKey, generation: 1 }),
      ).toEqual([]);
      const audit = new DatabaseSync(`${directory}/state.db`);
      try {
        expect(
          audit.prepare("SELECT was_in_flight FROM phase4_memory_suppressed").get()?.was_in_flight,
        ).toBe(1);
        expect(
          audit.prepare("SELECT ack_at_ms FROM phase4_observations").get()?.ack_at_ms,
        ).toBeNull();
      } finally {
        audit.close();
      }
      await client.close();
      client = createPersistenceClient({ dataDirectory: directory, worker: WORKER_FIXTURE });
      await client.migrate();
      expect((await client.phase4ChangeMemoryPolicy(change)).generation).toBe(1);
      expect(await client.claimOutbox(claim)).toEqual([]);
      expect(
        await client.phase4ReadConfirmedSpeech(SESSION_ID, 20, { scopeKey, generation: 1 }),
      ).toEqual([]);
      const next = fixture("subtitle");
      next.preparation.targets = [
        { ...target, sourceStream: "output:policy:1", policy: { scopeKey, generation: 1 } },
      ];
      await adopt(client, next, 1, { scopeKey, generation: 1 });
      await client.phase4PrepareEffects(next.preparation);
      await commit(client, next);
      expect((await confirm(client, next.receipt())).outcome).toBe("recorded");
      expect((await client.claimOutbox(claim))[0]?.payload).toMatchObject({
        policy: { scopeKey, generation: 1 },
        event: { sourceCursor: "1", sourceStream: "output:policy:1" },
      });
    } finally {
      await client.close();
      cleanupTempDataDirectory(directory);
    }
  });

  it("stops new work on actual DB/WAL pressure but settles and retains already admitted effects across restart", async () => {
    const directory = createTempDataDirectory("phase4-disk-pressure-");
    const options = {
      dataDirectory: directory,
      worker: WORKER_FIXTURE,
      diskAdmission: { highWaterBytes: 16 * 1024 ** 2 },
    };
    let client = createPersistenceClient(options);
    try {
      await client.migrate();
      await client.ensureSession({ sessionId: SESSION_ID, createdAtMs: 0, trace: TRACE });
      expect((await client.readDiskStatus()).ready).toBe(true);
      const signalInput = {
        sessionId: SESSION_ID,
        priorityClass: "normal" as const,
        normalCapacity: 10,
        urgentCapacity: 10,
        receivedAtMs: 1,
        trace: TRACE,
        signal: {
          schemaVersion: 1 as const,
          id: randomUUID(),
          source: "disk-fixture",
          kind: "danmaku",
          occurredAt: 1,
          priority: 100,
          payload: { text: "accepted" },
        },
      };
      const acceptedSignal = await client.phase3AppendSignal(signalInput);

      const active = fixture("subtitle"),
        waiting = fixture("subtitle"),
        unadopted = fixture();
      await adopt(client, active);
      await client.phase4PrepareEffects(active.preparation);
      await commit(client, active);
      await adopt(client, waiting, 1);
      const db = new DatabaseSync(`${directory}/state.db`);
      try {
        // Trusted capacity fault: actual SQLite pages/WAL, no changes to quotas,
        // effect receipts, acknowledgement flags or reservation counters.
        db.exec(
          "PRAGMA wal_autocheckpoint=0; CREATE TABLE disk_pressure (payload BLOB); INSERT INTO disk_pressure VALUES(zeroblob(16777216));",
        );
        const status = await client.readDiskStatus();
        expect(status).toMatchObject({ ready: false, reason: "high_water" });
        expect(status.walBytes).toBeGreaterThan(16 * 1024 ** 2);
        expect(status.totalBytes).toBe(
          status.databaseBytes + status.walBytes + status.auxiliaryBytes,
        );
        await expect(adopt(client, unadopted, 2)).rejects.toMatchObject({
          code: "storage_not_ready",
          retryable: false,
        });
        expect(
          await client.phase4ReadContextManifest(SESSION_ID, unadopted.plan.scene.cycleId),
        ).toBeNull();
        expect((await client.phase3ReadDecisionState(SESSION_ID)).consumed).toBe(2n);
        await expect(client.phase4PrepareEffects(waiting.preparation)).rejects.toMatchObject({
          code: "storage_not_ready",
        });
        await expect(commit(client, waiting)).rejects.toMatchObject({ code: "storage_not_ready" });
        await expect(
          client.phase3AppendSignal({
            ...signalInput,
            signal: { ...signalInput.signal, id: randomUUID() },
          }),
        ).rejects.toMatchObject({ code: "storage_not_ready" });
        expect(await client.phase3AppendSignal(signalInput)).toMatchObject({
          result: "deduplicated",
          sequence: acceptedSignal.result === "accepted" ? acceptedSignal.sequence : -1n,
        });
        // Exact retries remain available after high-water admission closes.
        await client.phase4PrepareEffects(active.preparation);
        await commit(client, active);
        expect((await confirm(client, active.receipt())).outcome).toBe("recorded");
        expect((await confirm(client, active.receipt())).outcome).toBe("duplicate");
        expect((await client.phase4ReadConfirmedSpeech(SESSION_ID))[0]?.text).toBe("第一句。");
        await client.phase4CloseEffects(SESSION_ID, active.plan.scene.sceneId);
      } finally {
        db.close();
      }
      await client.close();
      client = createPersistenceClient(options);
      await client.migrate();
      expect((await client.readDiskStatus()).ready).toBe(false);
      expect((await client.phase4ReadConfirmedSpeech(SESSION_ID))[0]?.text).toBe("第一句。");
      const messages = await client.claimOutbox(claim);
      expect(messages).toHaveLength(1);
      expect(messages[0]?.payload).toMatchObject({
        event: { content: "第一句。", sourceCursor: "1" },
      });
      expect((await client.readOutboxStats()).dead).toBe(0);
    } finally {
      await client.close();
      cleanupTempDataDirectory(directory);
    }
  });

  it("stops new adoption at the high watermark while admitted confirmation retains its reservation", async () => {
    const directory = createTempDataDirectory("phase4-effects-capacity-");
    const client = createPersistenceClient({ dataDirectory: directory, worker: WORKER_FIXTURE });
    try {
      await client.migrate();
      await client.ensureSession({ sessionId: SESSION_ID, createdAtMs: 0, trace: TRACE });
      const f = fixture("subtitle");
      await adopt(client, f);
      await client.phase4PrepareEffects(f.preparation);
      await commit(client, f);
      const db = new DatabaseSync(`${directory}/state.db`);
      try {
        // Fault fixture models already-reserved backlog. It does not bypass the
        // public admission path being exercised below or fabricate receipts.
        db.prepare("UPDATE phase4_effect_preparations SET reserved_events = 10001").run();
        const blocked = fixture();
        await expect(adopt(client, blocked, 1)).rejects.toMatchObject({ code: "database_busy" });
        expect(
          await client.phase4ReadContextManifest(SESSION_ID, blocked.plan.scene.cycleId),
        ).toBeNull();
        expect((await confirm(client, f.receipt())).outcome).toBe("recorded");
        expect((await client.claimOutbox(claim))[0]!.payload).toMatchObject({
          event: { content: "第一句。", sourceCursor: "1" },
        });
        await client.phase4CloseEffects(SESSION_ID, f.plan.scene.sceneId);
        await adopt(client, blocked, 1);
        for (let index = 1; index <= 4; index++) {
          const next = index === 1 ? blocked : fixture();
          if (index > 1) await adopt(client, next, index);
          await client.phase4PrepareEffects(next.preparation);
        }
        const overflow = fixture();
        await adopt(client, overflow, 5);
        await expect(client.phase4PrepareEffects(overflow.preparation)).rejects.toMatchObject({
          code: "database_busy",
        });
      } finally {
        db.close();
      }
    } finally {
      await client.close();
      cleanupTempDataDirectory(directory);
    }
  });
  it("requires actual commit and durable audio binding; atomically records only confirmed text and deduplicates receipts", async () => {
    const directory = createTempDataDirectory("phase4-effects-");
    let client = createPersistenceClient({ dataDirectory: directory, worker: WORKER_FIXTURE });
    try {
      await client.migrate();
      await client.ensureSession({ sessionId: SESSION_ID, createdAtMs: 0, trace: TRACE });
      const f = fixture();
      await adopt(client, f);
      await client.phase4PrepareEffects(f.preparation);
      await client.phase4PrepareEffects(f.preparation);
      const receipt = f.receipt();
      await expect(confirm(client, receipt)).rejects.toMatchObject({ code: "invalid_request" });
      await commit(client, f);
      await expect(confirm(client, receipt)).rejects.toMatchObject({ code: "invalid_request" });
      await expect(client.phase4BindAudioSegment(f.binding(1))).rejects.toMatchObject({
        code: "invalid_request",
      });
      await client.phase4BindAudioSegment(f.binding());
      await client.phase4BindAudioSegment(f.binding());
      await expect(
        client.phase4BindAudioSegment({ ...f.binding(), endSample: 2880 }),
      ).rejects.toMatchObject({ code: "idempotency_conflict" });
      if (receipt.lane !== "audio") throw new Error("fixture");
      for (const invalid of [
        { ...receipt, end: 8 },
        { ...receipt, renderedSamples: 1919 },
        { ...receipt, sessionId: randomUUID() },
        { ...receipt, connectionGeneration: randomUUID() },
      ])
        await expect(confirm(client, invalid)).rejects.toMatchObject({ code: "invalid_request" });
      expect(await client.phase4ReadConfirmedSpeech(SESSION_ID)).toEqual([]);
      expect((await confirm(client, receipt)).outcome).toBe("recorded");
      expect((await confirm(client, receipt)).outcome).toBe("duplicate");
      expect((await confirm(client, { ...receipt, receiptId: randomUUID() })).outcome).toBe(
        "duplicate",
      );
      await expect(
        confirm(client, { ...receipt, appliedAtStageUs: "20001" }),
      ).rejects.toMatchObject({ code: "idempotency_conflict" });
      expect(await client.phase4ReadConfirmedSpeech(SESSION_ID)).toEqual([
        expect.objectContaining({ text: "第一句。", start: 0, end: 4 }),
      ]);
      const messages = await client.claimOutbox(claim);
      expect(messages).toHaveLength(1);
      expect(messages[0]!.payload).toMatchObject({
        event: {
          content: "第一句。",
          role: "assistant",
          effectState: "partial",
          sourceCursor: "1",
          effectProof: { confirmed_range: { start: 0, end: 4, unit: "utf16" } },
        },
      });
      await client.close();
      client = createPersistenceClient({ dataDirectory: directory, worker: WORKER_FIXTURE });
      await client.migrate();
      expect(await client.claimOutbox(claim)).toEqual(messages);
      expect((await confirm(client, receipt)).outcome).toBe("duplicate");
      await expect(client.phase4BindAudioSegment(f.binding(1))).rejects.toMatchObject({
        code: "invalid_request",
      });
      await expect(confirm(client, f.receipt(1))).rejects.toMatchObject({
        code: "invalid_request",
      });
      expect(await client.phase4ReadConfirmedSpeech(SESSION_ID)).toHaveLength(1);
    } finally {
      await client.close();
      cleanupTempDataDirectory(directory);
    }
  });

  it("rolls back receipt, cursor and outbox together when observation insertion fails, preserving reservation for retry", async () => {
    const directory = createTempDataDirectory("phase4-effects-rollback-");
    const client = createPersistenceClient({ dataDirectory: directory, worker: WORKER_FIXTURE });
    try {
      await client.migrate();
      await client.ensureSession({ sessionId: SESSION_ID, createdAtMs: 0, trace: TRACE });
      const f = fixture("subtitle");
      await adopt(client, f);
      await client.phase4PrepareEffects(f.preparation);
      await commit(client, f);
      const db = new DatabaseSync(`${directory}/state.db`);
      try {
        db.exec(
          "CREATE TRIGGER fail_observation BEFORE INSERT ON phase4_observations BEGIN SELECT RAISE(ABORT, 'injected'); END",
        );
        const receipt = f.receipt();
        await expect(confirm(client, receipt)).rejects.toBeDefined();
        expect(await client.phase4ReadConfirmedSpeech(SESSION_ID)).toEqual([]);
        expect((await client.readOutboxStats()).pending).toBe(0);
        expect(
          db.prepare("SELECT reserved_events FROM phase4_effect_preparations").get()!
            .reserved_events,
        ).toBe(2);
        db.exec("DROP TRIGGER fail_observation");
        expect((await confirm(client, receipt)).outcome).toBe("recorded");
        expect((await client.claimOutbox(claim))[0]!.payload).toMatchObject({
          event: { sourceCursor: "1" },
        });
        await client.phase4CloseEffects(SESSION_ID, f.plan.scene.sceneId);
        expect(
          db.prepare("SELECT reserved_events FROM phase4_effect_preparations").get()!
            .reserved_events,
        ).toBe(0);
        await expect(confirm(client, f.receipt(1))).rejects.toMatchObject({
          code: "invalid_request",
        });
      } finally {
        db.close();
      }
    } finally {
      await client.close();
      cleanupTempDataDirectory(directory);
    }
  });
});

it("protects four 32-segment eight-Provider plans after background WAL writes stop, with no double spending on retries", async () => {
  const directory = createTempDataDirectory("completion-wal-maximum-");
  const options = {
    dataDirectory: directory,
    worker: WORKER_FIXTURE,
    diskAdmission: { walHighWaterBytes: 16 * 1024 ** 2 },
  };
  let client = createPersistenceClient(options);
  let reader: DatabaseSync | undefined;
  const scope = { scopeKey: "f".repeat(64), providerId: "background" };
  try {
    await client.migrate();
    await client.ensureSession({ sessionId: SESSION_ID, createdAtMs: 0, trace: TRACE });
    const plans = Array.from({ length: 4 }, () => fixture("audio", 32));
    for (let index = 0; index < plans.length; index++) {
      const f = plans[index]!;
      f.preparation.targets = Array.from({ length: 8 }, (_, i) => ({
        ...target,
        providerId: `provider-${i}`,
        sourceStream: "o".repeat(200),
        privacyLabels: Array.from({ length: 30 }, () => "l".repeat(250)),
      }));
      await adopt(client, f, index);
      await client.phase4PrepareEffects(f.preparation);
      await commit(client, f);
    }
    const initial = (await client.readDiskStatus()).capacity!;
    expect(initial.activeCompletionReservations).toBe(4);
    expect(initial.stateReservedBytes).toBeGreaterThan(300 * 1024 ** 2);
    reader = new DatabaseSync(`${directory}/state.db`, { readOnly: true });
    reader.exec("BEGIN");
    reader.prepare("SELECT count(*) FROM phase4_effect_preparations").get();
    let revision = 0;
    for (let i = 0; i < 200; i++) {
      try {
        revision = await client.phase4WriteProviderState({
          ...scope,
          expectedRevision: revision,
          state: { text: String.fromCharCode(65 + (i % 26)).repeat(250_000) },
        });
      } catch (error) {
        expect(error).toMatchObject({ code: "storage_not_ready" });
        break;
      }
    }
    expect(revision).toBeGreaterThan(0);
    expect(revision).toBeLessThan(200);
    expect(await client.readDiskStatus()).toMatchObject({ ready: false, reason: "wal_pressure" });
    const frozen = statSync(`${directory}/state.db-wal`).size;
    await expect(
      client.phase4WriteProviderState({
        ...scope,
        expectedRevision: revision,
        state: { text: "cannot spend completion reserve" },
      }),
    ).rejects.toMatchObject({ code: "storage_not_ready" });
    expect(statSync(`${directory}/state.db-wal`).size).toBe(frozen);
    for (const f of plans) {
      for (let i = 0; i < 32; i++) await client.phase4BindAudioSegment(f.binding(i));
      const afterBindings = (await client.readDiskStatus()).capacity!.stateReservedBytes;
      await client.phase4BindAudioSegment(f.binding(31));
      expect((await client.readDiskStatus()).capacity!.stateReservedBytes).toBe(afterBindings);
      const invalid = { ...f.receipt(), contentHash: "0".repeat(64) };
      await expect(confirm(client, invalid)).rejects.toMatchObject({ code: "invalid_request" });
      expect((await client.readDiskStatus()).capacity!.stateReservedBytes).toBe(afterBindings);
      for (let i = 31; i >= 0; i--)
        expect((await confirm(client, f.receipt(i))).outcome).toBe("recorded");
      const beforeDuplicate = (await client.readDiskStatus()).capacity!.stateReservedBytes;
      expect((await confirm(client, f.receipt(31))).outcome).toBe("duplicate");
      expect((await client.readDiskStatus()).capacity!.stateReservedBytes).toBe(beforeDuplicate);
      await client.phase4CloseEffects(SESSION_ID, f.plan.scene.sceneId);
      await client.phase4CloseEffects(SESSION_ID, f.plan.scene.sceneId);
    }
    const done = (await client.readDiskStatus()).capacity!;
    expect(done.activeCompletionReservations).toBe(0);
    expect(done.stateReservedBytes).toBe(0);
    expect(done.stateReservedWalBytes).toBe(0);
    expect(statSync(`${directory}/state.db-wal`).size).toBeLessThanOrEqual(done.stateWalLimitBytes);
    expect((await client.readOutboxStats()).pending).toBe(1024);
    reader.exec("ROLLBACK");
    reader.close();
    reader = undefined;
    await client.close();
    client = createPersistenceClient(options);
    await client.migrate();
    expect((await client.readOutboxStats()).pending).toBe(1024);
    expect((await client.readDiskStatus()).capacity!.activeCompletionReservations).toBe(0);
  } finally {
    reader?.close();
    await client.close();
    cleanupTempDataDirectory(directory);
  }
}, 30_000);

it("keeps logical DB space for an active confirmation and releases unused credits on restart without dropping accepted facts", async () => {
  const directory = createTempDataDirectory("completion-db-reserve-");
  const options = {
    dataDirectory: directory,
    worker: WORKER_FIXTURE,
    diskAdmission: { stateMaxBytes: 32 * 1024 ** 2, transactionCacheMaxBytes: 16 * 1024 ** 2 },
  };
  let client = createPersistenceClient(options);
  const scope = { scopeKey: "e".repeat(64), providerId: "background" };
  try {
    await client.migrate();
    await client.ensureSession({ sessionId: SESSION_ID, createdAtMs: 0, trace: TRACE });
    const f = fixture("subtitle");
    await adopt(client, f);
    await client.phase4PrepareEffects(f.preparation);
    await commit(client, f);
    const { makeSessionRecord } = await import("../helpers.js");
    let accepted = 0;
    for (; accepted < 160; accepted++) {
      const id = randomUUID();
      try {
        await client.appendRecord({
          record: makeSessionRecord({
            recordId: id,
            aggregateId: id,
            payload: { text: "x".repeat(250_000) },
          }),
          trace: TRACE,
        });
      } catch (error) {
        expect(error).toMatchObject({
          code: "storage_not_ready",
          message: "effect completion capacity is reserved",
        });
        break;
      }
    }
    expect(accepted).toBeGreaterThan(0);
    expect(accepted).toBeLessThan(160);
    await expect(
      client.phase4WriteProviderState({
        ...scope,
        expectedRevision: 0,
        state: { text: "blocked" },
      }),
    ).rejects.toMatchObject({ code: "storage_not_ready" });
    expect(await client.readDiskStatus()).toMatchObject({ ready: false, reason: "database_limit" });
    const receipt = f.receipt();
    expect((await confirm(client, receipt)).outcome).toBe("recorded");
    expect((await confirm(client, receipt)).outcome).toBe("duplicate");
    expect((await client.readDiskStatus()).capacity!.activeCompletionReservations).toBe(1);
    await client.close();
    client = createPersistenceClient(options);
    await client.migrate();
    expect((await client.readDiskStatus()).capacity!.activeCompletionReservations).toBe(0);
    expect((await client.readDiskStatus()).capacity!.stateReservedBytes).toBe(0);
    expect((await client.phase4ReadConfirmedSpeech(SESSION_ID))[0]?.text).toBe("第一句。");
    expect((await client.readOutboxStats()).pending).toBe(1);
  } finally {
    await client.close();
    cleanupTempDataDirectory(directory);
  }
}, 20_000);

it("scales completion credits for an existing database with 64KiB pages before admitting output", async () => {
  const directory = createTempDataDirectory("completion-large-pages-");
  const seed = new DatabaseSync(`${directory}/state.db`);
  seed.exec("PRAGMA page_size=65536; VACUUM");
  seed.close();
  const client = createPersistenceClient({
    dataDirectory: directory,
    worker: WORKER_FIXTURE,
    diskAdmission: { transactionCacheMaxBytes: 64 * 1024 ** 2 },
  });
  try {
    await client.migrate();
    await client.ensureSession({ sessionId: SESSION_ID, createdAtMs: 0, trace: TRACE });
    const f = fixture("subtitle");
    await adopt(client, f);
    await client.phase4PrepareEffects(f.preparation);
    await commit(client, f);
    expect((await client.readDiskStatus()).capacity!.stateReservedBytes).toBe(72 * 1024 ** 2);
    expect((await confirm(client, f.receipt())).outcome).toBe("recorded");
    await client.phase4CloseEffects(SESSION_ID, f.plan.scene.sceneId);
    expect((await client.readDiskStatus()).capacity!.stateReservedBytes).toBe(0);
  } finally {
    await client.close();
    cleanupTempDataDirectory(directory);
  }
});
