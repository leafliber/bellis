import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchRecoveryChild } from "./iris-recovery-process.mjs";
import { createObserveFaultProxy } from "./iris-observe-fault-proxy.mjs";

const childPath = fileURLToPath(new URL("./iris-observe-recovery-child.mjs", import.meta.url));
export async function runObserveRecoveryProbe(
  baseUrl,
  credential,
  client,
  directory,
  schemaVersion,
  operator,
  repetitions,
) {
  const windows = [
    "observation-before-http-publish",
    "core-observation-committed-before-http-ack",
    "observation-sdk-ack-before-host-delivered",
  ];
  const targets = ["bellis-runtime", "core-api", "core-worker"],
    results = [];
  for (const window of windows)
    for (const target of targets)
      for (let index = 0; index < repetitions; index++) {
        const caseDirectory = join(directory, `observe-recovery-${results.length + 1}`);
        await mkdir(caseDirectory);
        const proxy = await createObserveFaultProxy(baseUrl, window);
        const configPath = join(caseDirectory, "operator.json");
        const config = {
          baseUrl: proxy.baseUrl,
          token: credential.token,
          agentId: credential.agent_id,
          spaceId: credential.space_id,
          actorId: credential.actor_external_identity_id,
          schemaVersion,
          appInstanceId: `observe-recovery-${results.length + 1}`,
          sessionId: randomUUID(),
          dataDirectory: join(caseDirectory, "host"),
          window,
        };
        let host;
        try {
          await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
          host = launchRecoveryChild(configPath, "fault", childPath);
          await host.expect("ready");
          host.child.send({ type: "run" });
          if (window !== "observation-sdk-ack-before-host-delivered") {
            await proxy.checkpoint();
            host.child.send({ type: "snapshot" });
          }
          const checkpoint = await host.expect("checkpoint"),
            original = checkpoint.event;
          assert.equal(checkpoint.outbox.inFlight, 1);
          assert.equal(checkpoint.outbox.delivered, 0);
          const acknowledged = window === "observation-sdk-ack-before-host-delivered";
          assert.equal(checkpoint.coreAckCount, acknowledged ? 1 : 0);
          assert.equal(checkpoint.providerCursor, acknowledged ? "1" : null);
          const first = proxy.requests[0];
          assert.ok(first);
          assert.equal(first.responseForwarded, acknowledged);
          assert.equal(first.records[0].idempotency_key, original.eventId);
          assert.equal(first.records[0].source_cursor, "1");
          const remote = await client.sourceCursor(original.sourceStream, credential.agent_id, {
            signal: AbortSignal.timeout(10000),
          });
          assert.equal(
            remote.cursor_position,
            window === "observation-before-http-publish" ? null : 1,
          );
          const knownCanonicalId = first.receipt?.accepted_observation_ids[0];
          if (window !== "observation-before-http-publish")
            assert.equal(typeof knownCanonicalId, "string");
          let crash;
          if (target === "bellis-runtime") {
            const oldPid = host.child.pid;
            const killed = await host.stop("SIGKILL");
            assert.equal(killed.signal, "SIGKILL");
            proxy.release();
            await writeFile(configPath, JSON.stringify({ ...config, original }), { mode: 0o600 });
            host = launchRecoveryChild(configPath, "recover", childPath);
            assert.notEqual(host.child.pid, oldPid);
            crash = { signal: "SIGKILL", replacedProcess: true };
          } else {
            crash = await operator.restart(target);
            proxy.release();
            host.child.send({ type: "release", original });
          }
          const recovered = await host.expect("recovered");
          assert.deepEqual(recovered.event, original);
          assert.equal(recovered.outbox.delivered, 1);
          const sent = proxy.requests;
          assert.equal(sent.length, target === "bellis-runtime" ? 2 : 1);
          assert.ok(
            sent.every(
              (request) => request.bodyDigest === first.bodyDigest && request.key === first.key,
            ),
          );
          const replay = await client.observeBatch(first.records, {
            idempotencyKey: first.key,
            signal: AbortSignal.timeout(10000),
          });
          const canonicalIds = [
            ...replay.accepted_observation_ids,
            ...replay.duplicate_observation_ids,
          ];
          assert.equal(canonicalIds.length, 1);
          if (knownCanonicalId) assert.equal(canonicalIds[0], knownCanonicalId);
          const dedupe = await client.observeBatch(first.records, {
            idempotencyKey: randomUUID(),
            signal: AbortSignal.timeout(10000),
          });
          assert.deepEqual(dedupe.accepted_observation_ids, []);
          assert.deepEqual(dedupe.duplicate_observation_ids, canonicalIds);
          assert.equal(dedupe.outbox_enqueued, 0);
          const finalCursor = await client.sourceCursor(
            original.sourceStream,
            credential.agent_id,
            { signal: AbortSignal.timeout(10000) },
          );
          assert.equal(finalCursor.cursor_position, 1);
          results.push({
            window,
            target,
            repetition: index + 1,
            crash,
            sourceStream: original.sourceStream,
            eventId: original.eventId,
            outboxId: original.outboxId,
            wireBodyDigest: first.bodyDigest,
            batchKey: first.key,
            wireRequests: sent.length,
            ackForwardedAtCrash: acknowledged,
            remoteCursorAtCrash: remote.cursor_position,
            canonicalObservationId: canonicalIds[0],
            duplicateCanonicalWrites: 0,
            finalSourceCursor: "1",
            hostDelivered: 1,
          });
        } finally {
          try {
            if (host) await host.stop();
          } finally {
            await proxy.close();
          }
        }
        if ((index + 1) % 5 === 0 || repetitions === 1)
          console.info(`iris-observe-recovery: ${window} ${target} ${index + 1}/${repetitions}`);
      }
  return {
    status: repetitions === 20 ? "covered-windows-passed" : "smoke-passed",
    windows,
    targets,
    repetitionsPerCombination: repetitions,
    requiredRepetitions: 20,
    casesPassed: results.length,
    results,
    scope:
      "Trusted input Observation through real Runtime/DB Worker and installed SDK; actual HTTP forwarding withheld across process crashes, no fabricated Stage output or effect-transaction proof",
  };
}
