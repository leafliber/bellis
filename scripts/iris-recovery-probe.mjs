import { runObserveRecoveryProbe } from "./iris-observe-recovery-probe.mjs";
import assert from "node:assert/strict";
import { launchRecoveryChild } from "./iris-recovery-process.mjs";
import { runCycleRecoveryProbe } from "./iris-cycle-recovery-probe.mjs";
import { randomUUID } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const childPath = fileURLToPath(new URL("./iris-recovery-child.mjs", import.meta.url));
const launch = (configPath, mode) => launchRecoveryChild(configPath, mode, childPath);

/** Only the trusted operator controls processes; client data uses public SDK/HTTP. */
export async function runIrisRecoveryProbe(
  baseUrl,
  credential,
  client,
  directory,
  schemaVersion,
  operator,
  repetitions = 20,
) {
  assert.ok(Number.isSafeInteger(repetitions) && repetitions >= 1 && repetitions <= 20);
  const cycleRecovery = await runCycleRecoveryProbe(
    baseUrl,
    credential,
    client,
    directory,
    schemaVersion,
    operator,
    repetitions,
  );
  const observeRecovery = await runObserveRecoveryProbe(
    baseUrl,
    credential,
    client,
    directory,
    schemaVersion,
    operator,
    repetitions,
  );
  const windows = ["pending-persisted-before-host-ack", "policy-committed-before-provider-cursor"];
  const targets = ["bellis-runtime", "core-api", "core-worker"];
  const results = [];
  let baselineCursor = "0";
  // Drain the public event page sequence; never infer a cursor from Core database state.
  for (let page = 0; page < 100; page++) {
    const events = await client.events({
      after: baselineCursor,
      signal: AbortSignal.timeout(10_000),
    });
    if (!events.length) break;
    baselineCursor = events.at(-1).cursor;
    if (page === 99) throw new Error("recovery event baseline exceeds bounded history");
  }
  for (const window of windows)
    for (const target of targets)
      for (let index = 0; index < repetitions; index++) {
        const number = results.length + 1,
          caseDirectory = join(directory, `recovery-${number}`);
        await mkdir(caseDirectory);
        const now = Date.now() * 1000,
          privacy = `space:${credential.space_id}`;
        const observed = await client.observeBatch(
          [
            {
              agent_id: credential.agent_id,
              space_id: credential.space_id,
              actor_external_identity_id: credential.actor_external_identity_id,
              role: "user",
              kind: "message.text",
              content: `Recovery fixture ${number}`,
              privacy_labels: [privacy],
              idempotency_key: randomUUID(),
              occurred_us: now,
              committed_us: now,
              effect_state: "committed",
            },
          ],
          { idempotencyKey: randomUUID(), signal: AbortSignal.timeout(10_000) },
        );
        const claim = await client.rememberClaim(
          {
            agent_id: credential.agent_id,
            space_id: credential.space_id,
            subject_is_self: true,
            predicate: `probe.recovery_${number}`,
            value: "fixture",
            canonical_text: `Recovery fixture ${number}`,
            privacy_labels: [privacy],
            source_authority: "user_statement",
            evidence: [
              {
                source_type: "observation",
                source_id: observed.accepted_observation_ids[0],
                relation: "supports",
                source_authority: "user_statement",
              },
            ],
          },
          { idempotencyKey: randomUUID(), signal: AbortSignal.timeout(10_000) },
        );
        const configPath = join(caseDirectory, "operator.json");
        await writeFile(
          configPath,
          JSON.stringify({
            baseUrl,
            token: credential.token,
            agentId: credential.agent_id,
            spaceId: credential.space_id,
            schemaVersion,
            dataDirectory: join(caseDirectory, "host"),
            appInstanceId: `recovery-${number}`,
            sessionId: randomUUID(),
            resourceRef: `iris:claim:${encodeURIComponent(claim.claim_id)}`,
            window,
            baselineCursor,
          }),
          { mode: 0o600 },
        );
        let host = launch(configPath, "fault");
        try {
          await host.expect("ready");
          const key = randomUUID();
          const request = {
            selector: { kind: "resource", resource_type: "claim", resource_id: claim.claim_id },
            erase_content: true,
            reason: "authorized recovery fixture deletion",
          };
          const receipt = await client.forgetMemory(request, {
            idempotencyKey: key,
            signal: AbortSignal.timeout(10_000),
          });
          assert.equal(receipt.erased_count, 1);
          const checkpoint = await host.expect("checkpoint");
          assert.equal(checkpoint.pendingEventId, checkpoint.eventId);
          assert.ok(BigInt(checkpoint.persistedCursor ?? "0") < BigInt(checkpoint.eventCursor));
          assert.equal(checkpoint.tombstone, window === "policy-committed-before-provider-cursor");
          if (checkpoint.tombstone) assert.equal(checkpoint.contextCancelled, true);
          const oldPid = target === "bellis-runtime" ? host.child.pid : undefined;
          let crash;
          if (target === "bellis-runtime") {
            const killed = await host.stop("SIGKILL");
            assert.equal(killed.signal, "SIGKILL");
            host = launch(configPath, "recover");
            assert.notEqual(host.child.pid, oldPid);
            crash = { signal: "SIGKILL", replacedProcess: true };
          } else {
            crash = await operator.restart(target);
            host.child.send({ type: "release" });
          }
          const recovered = await host.expect("recovered");
          assert.equal(recovered.permanentTombstone, true);
          assert.equal(recovered.blocked, false);
          assert.ok(BigInt(recovered.eventCursor) >= BigInt(checkpoint.eventCursor));
          assert.equal(
            recovered.generation,
            checkpoint.generation + (checkpoint.tombstone ? 0 : 1),
            "replay must not create a second policy transition",
          );
          await assert.rejects(client.getClaim(claim.claim_id), (error) => error.status === 404);
          const replay = await client.forgetMemory(request, {
            idempotencyKey: key,
            signal: AbortSignal.timeout(10_000),
          });
          assert.deepEqual(
            replay,
            receipt,
            "original public deletion receipt must survive recovery",
          );
          const events = await client.events({
            after: baselineCursor,
            signal: AbortSignal.timeout(10_000),
          });
          assert.ok(
            events.some(
              (event) =>
                event.event_id === checkpoint.eventId &&
                event.resource_refs.some((ref) => ref.resource_id === claim.claim_id),
            ),
          );
          baselineCursor = recovered.eventCursor;
          results.push({
            window,
            target,
            repetition: index + 1,
            crash,
            pendingDurableAtCrash: true,
            tombstoneDurableAtCrash: checkpoint.tombstone,
            eventId: checkpoint.eventId,
            eventCursor: checkpoint.eventCursor,
            recoveredCursor: recovered.eventCursor,
            recoveredGeneration: recovered.generation,
            originalDeleteReceiptReplayed: true,
            deletedClaimRead: "404",
          });
        } finally {
          await host.stop();
        }
        if ((index + 1) % 5 === 0 || repetitions === 1)
          console.info(`iris-recovery: ${window} ${target} ${index + 1}/${repetitions}`);
      }
  return {
    status: "incomplete",
    coveredWindows: windows,
    targets,
    repetitionsPerWindowAndTarget: repetitions,
    requiredRepetitions: 20,
    casesPassed: results.length + cycleRecovery.casesPassed + observeRecovery.casesPassed,
    observeRecovery,
    sseCasesPassed: results.length,
    cycleRecovery,
    results,
    scope:
      "Real Runtime/MemoryHost/DB Worker and installed Core API/Worker SIGKILL recovery of public deletion SSE; no Stage effect crash claim",
    remaining: [
      "Inside-adoption transaction rollback and complete Stage effect crash coupling",
      "effect record/Observe projection transaction before and after commit",
      "Active Stage output confirmation and effect projection crash coupling",
      "both-side older snapshots and all cursor divergence cases",
      "disk/WAL quotas, active-scene reserved capacity and full Runtime/Stage recovery",
    ],
  };
}
