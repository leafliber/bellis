import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cp, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchRecoveryChild } from "./iris-recovery-process.mjs";
import { createObserveFaultProxy } from "./iris-observe-fault-proxy.mjs";
import { closedDirectoryDigest } from "./iris-host-snapshot-probe.mjs";

const childPath = fileURLToPath(new URL("./iris-observe-recovery-child.mjs", import.meta.url));

/** Restore an actual older cold host directory after its Observe has settled remotely. */
export async function runObserveSnapshotProbe(
  baseUrl,
  credential,
  client,
  directory,
  schemaVersion,
) {
  const results = [];
  for (const window of [
    "observation-before-http-publish",
    "core-observation-committed-before-http-ack",
    "observation-sdk-ack-before-host-delivered",
  ]) {
    const caseDirectory = join(directory, `observe-snapshot-${results.length + 1}`);
    await mkdir(caseDirectory);
    const proxy = await createObserveFaultProxy(baseUrl, window);
    const configPath = join(caseDirectory, "operator.json");
    const dataDirectory = join(caseDirectory, "host");
    const backupDirectory = join(caseDirectory, "cold-snapshot");
    const config = {
      baseUrl: proxy.baseUrl,
      token: credential.token,
      agentId: credential.agent_id,
      spaceId: credential.space_id,
      actorId: credential.actor_external_identity_id,
      schemaVersion,
      appInstanceId: `observe-snapshot-${results.length + 1}`,
      sessionId: randomUUID(),
      dataDirectory,
      window,
    };
    let host;
    try {
      await writeFile(configPath, JSON.stringify(config), { mode: 0o600, flag: "wx" });
      host = launchRecoveryChild(configPath, "fault", childPath);
      await host.expect("ready");
      host.child.send({ type: "run" });
      const sdkAcknowledged = window === "observation-sdk-ack-before-host-delivered";
      if (!sdkAcknowledged) {
        await proxy.checkpoint();
        host.child.send({ type: "snapshot" });
      }
      const checkpoint = await host.expect("checkpoint");
      const original = checkpoint.event;
      assert.equal(checkpoint.outbox.inFlight, 1);
      assert.equal(checkpoint.outbox.delivered, 0);
      assert.equal(checkpoint.coreAckCount, sdkAcknowledged ? 1 : 0);
      assert.equal(checkpoint.providerCursor, sdkAcknowledged ? "1" : null);
      const remoteBefore = await client.sourceCursor(original.sourceStream, credential.agent_id, {
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(
        remoteBefore.cursor_position,
        window === "observation-before-http-publish" ? null : 1,
      );
      const first = proxy.requests[0];
      assert.ok(first);
      assert.equal(first.records[0].idempotency_key, original.eventId);
      assert.equal(first.responseForwarded, sdkAcknowledged);
      const oldPid = host.child.pid;
      assert.equal((await host.stop("SIGKILL")).signal, "SIGKILL");
      host = undefined;
      // Worker threads die with this process; copy SQLite plus WAL only after terminal exit.
      const snapshotDigest = await closedDirectoryDigest(dataDirectory);
      await cp(dataDirectory, backupDirectory, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
      assert.equal(await closedDirectoryDigest(backupDirectory), snapshotDigest);
      proxy.release();
      await writeFile(configPath, JSON.stringify({ ...config, original }), { mode: 0o600 });

      // First finish the newer host, so the next step is a real rollback, not just crash restart.
      host = launchRecoveryChild(configPath, "recover", childPath);
      assert.notEqual(host.child.pid, oldPid);
      const advanced = await host.expect("recovered");
      assert.deepEqual(advanced.event, original);
      assert.equal(advanced.outbox.delivered, 1);
      assert.equal(advanced.providerCursor, "1");
      await host.stop();
      host = undefined;
      assert.equal(proxy.requests.length, 2);
      const remoteAdvanced = await client.sourceCursor(original.sourceStream, credential.agent_id, {
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(remoteAdvanced.cursor_position, 1);

      await rename(dataDirectory, join(caseDirectory, "newer-delivered-host"));
      await cp(backupDirectory, dataDirectory, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
      assert.equal(await closedDirectoryDigest(dataDirectory), snapshotDigest);
      host = launchRecoveryChild(configPath, "recover", childPath);
      const restored = await host.expect("recovered");
      assert.deepEqual(restored.event, original);
      assert.equal(restored.outbox.delivered, 1);
      assert.equal(restored.outbox.pending + restored.outbox.inFlight + restored.outbox.dead, 0);
      assert.equal(restored.providerCursor, "1");
      assert.equal(proxy.requests.length, 3);
      assert.ok(
        proxy.requests.every(
          (request) => request.bodyDigest === first.bodyDigest && request.key === first.key,
        ),
      );
      const replay = await client.observeBatch(first.records, {
        idempotencyKey: first.key,
        signal: AbortSignal.timeout(5000),
      });
      const canonicalIds = [
        ...replay.accepted_observation_ids,
        ...replay.duplicate_observation_ids,
      ];
      assert.equal(canonicalIds.length, 1);
      for (const request of proxy.requests) {
        assert.deepEqual(
          [
            ...request.receipt.accepted_observation_ids,
            ...request.receipt.duplicate_observation_ids,
          ],
          canonicalIds,
        );
      }
      // A new test-only batch key exercises record deduplication beyond the response cache.
      const dedupe = await client.observeBatch(first.records, {
        idempotencyKey: randomUUID(),
        signal: AbortSignal.timeout(5000),
      });
      assert.deepEqual(dedupe.accepted_observation_ids, []);
      assert.deepEqual(dedupe.duplicate_observation_ids, canonicalIds);
      assert.equal(dedupe.outbox_enqueued, 0);
      const remoteFinal = await client.sourceCursor(original.sourceStream, credential.agent_id, {
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(remoteFinal.cursor_position, 1);
      results.push({
        window,
        status: "passed",
        snapshotDigest,
        crash: "SIGKILL-observed-before-cold-copy",
        snapshotProviderCursor: checkpoint.providerCursor,
        snapshotRemoteCursor: remoteBefore.cursor_position,
        remoteCursorBeforeRollback: remoteAdvanced.cursor_position,
        exactOlderDirectoryRestored: true,
        originalEventId: original.eventId,
        originalOutboxId: original.outboxId,
        sourceStream: original.sourceStream,
        wireBodyDigest: first.bodyDigest,
        batchKey: first.key,
        wireRequests: proxy.requests.length,
        canonicalObservationId: canonicalIds[0],
        duplicateCanonicalWrites: 0,
        finalHostDelivered: 1,
        finalProviderCursor: "1",
        finalRemoteCursor: 1,
      });
    } finally {
      try {
        if (host && host.child.exitCode === null && host.child.signalCode === null)
          await host.stop();
      } finally {
        await proxy.close();
      }
    }
  }
  return {
    status: "passed",
    casesPassed: results.length,
    results,
    scope:
      "Three actual cold host rollbacks across Observe publication/ACK stages with newer Core preserved; trusted user input, original identity/body and record dedupe. Not simultaneous Core rollback, deleted Observation replay, Stage effect snapshots or a full twenty-repetition matrix.",
  };
}
