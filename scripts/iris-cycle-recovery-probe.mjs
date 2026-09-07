import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchRecoveryChild } from "./iris-recovery-process.mjs";

const childPath = fileURLToPath(new URL("./iris-cycle-recovery-child.mjs", import.meta.url));
export async function runCycleRecoveryProbe(
  baseUrl,
  credential,
  client,
  directory,
  schemaVersion,
  operator,
  repetitions,
) {
  const windows = [
    "manifest-formed-before-adoption",
    "adoption-committed-before-usage-ack",
    "usage-ack-before-host-delivered",
  ];
  const targets = ["bellis-runtime", "core-api", "core-worker"];
  const results = [];
  for (const window of windows)
    for (const target of targets)
      for (let index = 0; index < repetitions; index++) {
        const caseDirectory = join(directory, `cycle-recovery-${results.length + 1}`);
        await mkdir(caseDirectory);
        const configPath = join(caseDirectory, "operator.json");
        const config = {
          baseUrl,
          token: credential.token,
          agentId: credential.agent_id,
          spaceId: credential.space_id,
          schemaVersion,
          appInstanceId: `cycle-recovery-${results.length + 1}`,
          sessionId: randomUUID(),
          dataDirectory: join(caseDirectory, "host"),
          window,
        };
        await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
        let host = launchRecoveryChild(configPath, "fault", childPath);
        try {
          await host.expect("ready");
          host.child.send({ type: "run" });
          const checkpoint = await host.expect("checkpoint");
          const beforeAdoption = window === "manifest-formed-before-adoption";
          assert.equal(checkpoint.persisted, !beforeAdoption);
          assert.equal(
            checkpoint.persistedDigest,
            beforeAdoption ? null : checkpoint.manifestDigest,
          );
          assert.equal(
            checkpoint.coreAckCount,
            window === "usage-ack-before-host-delivered" ? 1 : 0,
          );
          assert.equal(checkpoint.outbox.delivered, 0);
          assert.equal(
            checkpoint.outbox.pending + checkpoint.outbox.inFlight,
            beforeAdoption ? 0 : 1,
          );
          const original = {
            cycleId: checkpoint.cycleId,
            manifestId: checkpoint.manifestId,
            manifestDigest: checkpoint.manifestDigest,
          };
          let crash;
          if (target === "bellis-runtime") {
            const oldPid = host.child.pid;
            const killed = await host.stop("SIGKILL");
            assert.equal(killed.signal, "SIGKILL");
            await writeFile(configPath, JSON.stringify({ ...config, original }), { mode: 0o600 });
            host = launchRecoveryChild(configPath, "recover", childPath);
            assert.notEqual(host.child.pid, oldPid);
            crash = { signal: "SIGKILL", replacedProcess: true };
          } else {
            crash = await operator.restart(target);
            host.child.send({ type: "release", original });
          }
          const recovered = await host.expect("recovered");
          assert.equal(
            recovered.newPendingInputCycle,
            beforeAdoption && target === "bellis-runtime",
          );
          assert.equal(recovered.originalManifestStable, !recovered.newPendingInputCycle);
          assert.equal(recovered.cycles, 1);
          assert.equal(recovered.outbox.delivered, 1);
          const usage = recovered.usage;
          if (!recovered.newPendingInputCycle) assert.deepEqual(usage, checkpoint.usage);
          const body = {
            host_cycle_id: usage.hostCycleId,
            persona_revision: Number(usage.personaRevision),
            returned_candidate_ids: usage.returnedBlockIds,
            host_selected_candidate_ids: usage.hostSelectedBlockIds,
            model_visible_candidate_ids: usage.modelVisibleBlockIds,
            reported_at: new Date(usage.reportedAtMs).toISOString(),
          };
          const replay = await client.reportRecallUsage(usage.requestId, body, {
            idempotencyKey: usage.outboxId,
            signal: AbortSignal.timeout(10_000),
          });
          const naturalReplay = await client.reportRecallUsage(usage.requestId, body, {
            idempotencyKey: randomUUID(),
            signal: AbortSignal.timeout(10_000),
          });
          assert.equal(naturalReplay.created, false);
          assert.equal(naturalReplay.report_id, replay.report_id);
          assert.equal(replay.stages.returned_count, usage.returnedBlockIds.length);
          assert.equal(replay.stages.host_selected_count, usage.hostSelectedBlockIds.length);
          assert.equal(replay.stages.model_visible_count, usage.modelVisibleBlockIds.length);
          results.push({
            window,
            target,
            repetition: index + 1,
            crash,
            original,
            originalManifestStable: recovered.originalManifestStable,
            unadoptedCandidateAbsent: recovered.newPendingInputCycle,
            newPendingInputCycle: recovered.newPendingInputCycle,
            modelRequestsAfterStart: recovered.modelRequestsAfterStart,
            recoveredCycleId: recovered.cycleId,
            recoveredManifestDigest: recovered.manifestDigest,
            consumed: recovered.consumed,
            usageOutboxId: usage.outboxId,
            coreReportId: replay.report_id,
            uniqueCoreUsage: true,
          });
        } finally {
          await host.stop();
        }
        if ((index + 1) % 5 === 0 || repetitions === 1)
          console.info(`iris-cycle-recovery: ${window} ${target} ${index + 1}/${repetitions}`);
      }
  return {
    status: "covered-windows-passed",
    windows,
    targets,
    repetitionsPerCombination: repetitions,
    requiredRepetitions: 20,
    casesPassed: results.length,
    results,
    scope:
      "Real Runtime/Loop/DB Worker and Core API/Worker; before/after adoption and Usage ACK, no active Stage or inside-SQL-transaction crash evidence",
  };
}
