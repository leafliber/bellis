import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Runs the exact Chromium output/cancellation assertions while the caller's
 * installed Core API and Worker remain alive. No alternate Stage receipt path. */
export async function runIrisStageProbe(
  baseUrl,
  credential,
  directory,
  client,
  coreSchemaVersion = 14,
  cycles = 3,
  recoveryRepetitions,
  recoveryFamily = "effects",
) {
  assert.ok(["effects", "observe"].includes(recoveryFamily));
  assert.ok(Number.isSafeInteger(cycles) && cycles >= 3 && cycles <= 100);
  const configPath = join(directory, "stage-core-config.json");
  const reportPath = join(directory, "stage-core-evidence.json");
  await writeFile(
    configPath,
    JSON.stringify({
      coreSchemaVersion,
      baseUrl,
      token: credential.token,
      agent_id: credential.agent_id,
      space_id: credential.space_id,
      ...(recoveryRepetitions === undefined ? {} : { stageRecovery: true }),
    }),
    { mode: 0o600 },
  );
  const stageDirectory = fileURLToPath(new URL("../apps/stage", import.meta.url));
  const command = fileURLToPath(
    new URL("../apps/stage/node_modules/@playwright/test/cli.js", import.meta.url),
  );
  if (recoveryRepetitions !== undefined) assert.ok([1, 20].includes(recoveryRepetitions));
  const child = spawn(
    process.execPath,
    [
      command,
      "test",
      recoveryRepetitions === undefined
        ? "phase4-effects-e2e.test.ts"
        : "phase4-recovery-e2e.test.ts",
    ],
    {
      cwd: stageDirectory,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        BELLIS_IRIS_E2E_CONFIG: configPath,
        BELLIS_IRIS_E2E_REPORT: reportPath,
        BELLIS_IRIS_E2E_CYCLES: String(cycles),
        ...(recoveryRepetitions === undefined
          ? {}
          : {
              BELLIS_IRIS_RECOVERY_REPETITIONS: String(recoveryRepetitions),
              BELLIS_IRIS_RECOVERY_REPORT: reportPath,
              BELLIS_IRIS_RECOVERY_FAMILY: recoveryFamily,
            }),
      },
    },
  );
  let output = "";
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      output = (output + String(chunk)).slice(-64 * 1024);
      const progress = String(chunk).match(/iris-continuous: [0-9]+\/[0-9]+ cycles/g);
      for (const line of progress ?? []) console.info(line);
      for (const line of String(chunk).match(/iris-stage-recovery: [a-z_]+ [0-9]+\/[0-9]+/g) ?? [])
        console.info(line);
    });
  const killGroup = (signal) => {
    if (!Number.isSafeInteger(child.pid)) return;
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  let timedOut = false;
  let forced;
  const timeout = setTimeout(
    () => {
      timedOut = true;
      killGroup("SIGTERM");
      forced = setTimeout(() => killGroup("SIGKILL"), 5000);
    },
    recoveryRepetitions === undefined
      ? 120_000 + (cycles - 3) * 6_000
      : recoveryRepetitions * 180_000,
  );
  let code;
  try {
    code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
  } finally {
    clearTimeout(timeout);
    clearTimeout(forced);
    // The process group contains only this test's Runtime/Vite children.
    killGroup(timedOut ? "SIGKILL" : "SIGTERM");
  }
  assert.equal(timedOut, false, "Core-backed Chromium output test timed out");
  assert.equal(code, 0, output);
  if (recoveryRepetitions !== undefined) {
    const results = (await readFile(reportPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const windows =
      recoveryFamily === "observe"
        ? [
            "observation_before_http_publish",
            "core_observation_committed_before_http_ack",
            "observation_sdk_ack_before_host_delivered",
          ]
        : ["before_effect_transaction_commit", "after_effect_transaction_commit_before_ack"];
    assert.equal(results.length, recoveryRepetitions * windows.length);
    for (const checkpoint of windows)
      assert.deepEqual(
        results.filter((item) => item.checkpoint === checkpoint).map((item) => item.repetition),
        Array.from({ length: recoveryRepetitions }, (_, index) => index + 1),
      );
    for (const result of results) {
      const committed = result.checkpoint !== "before_effect_transaction_commit";
      const source = await client.sourceCursor(result.sourceStream, credential.agent_id, {
        signal: AbortSignal.timeout(10000),
      });
      assert.equal(source.cursor_position, committed ? 1 : null);
      assert.equal(result.observeRequests.length, committed ? 1 : 0);
      if (committed) {
        const request = result.observeRequests[0];
        const original = result.observations[0];
        assert.equal(request.records[0].idempotency_key, original.eventId);
        if (recoveryFamily === "observe") {
          assert.deepEqual(request.records, result.requestAtCrash.records);
          assert.equal(request.key, result.requestAtCrash.key);
          assert.equal(request.bodyDigest, result.requestAtCrash.bodyDigest);
          assert.match(request.bodyDigest, /^[a-f0-9]{64}$/);
          assert.equal(result.hostStatusAtCrash, "in_flight");
          assert.equal(result.activeSceneAtCrash, true);
          if (result.requestAtCrash.receipt)
            assert.deepEqual(request.receipt, result.requestAtCrash.receipt);
          result.actualObserveHttpRequests = result.requestAtCrash.receipt ? 2 : 1;
        }
        const replay = await client.observeBatch(request.records, {
          idempotencyKey: request.key,
          signal: AbortSignal.timeout(10000),
        });
        assert.deepEqual(replay, request.receipt);
        const ids = [...replay.accepted_observation_ids, ...replay.duplicate_observation_ids];
        assert.equal(ids.length, 1);
        const duplicate = await client.observeBatch(request.records, {
          idempotencyKey: randomUUID(),
          signal: AbortSignal.timeout(10000),
        });
        assert.deepEqual(duplicate.accepted_observation_ids, []);
        assert.deepEqual(duplicate.duplicate_observation_ids, ids);
        assert.equal(duplicate.outbox_enqueued, 0);
        result.canonicalObservationId = ids[0];
        result.duplicateCanonicalWrites = 0;
      }
      result.coreSourceCursor = source.cursor_position;
    }
    return {
      status: recoveryRepetitions === 20 ? "covered-windows-passed" : "smoke-passed",
      chromium: "passed",
      target: "bellis-runtime",
      repetitionsPerCombination: recoveryRepetitions,
      casesPassed: results.length,
      recoveryFamily,
      results,
      scope:
        recoveryFamily === "observe"
          ? "Active Chromium Worklet output -> durable effect/Observe -> HTTP publication, Core committed response withheld, or SDK ACK before host delivered -> Runtime SIGKILL -> original Session and local confirmed receipt recovered. Original wire body/key, ACK and Canonical ID preserved. Does not cover Core process crashes or capacity pressure."
          : "Real Chromium Worklet receipt -> effect transaction before/after COMMIT -> Runtime SIGKILL -> same host database/Session -> installed SDK/Core; committed prefix preserved, uncommitted effects absent, no Scene replay. Does not cover Core crashes or Observe HTTP ACK windows during active Stage output.",
    };
  }
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.equal(report.mode, "real-core");
  assert.equal(report.adoptedCycles, cycles);
  assert.equal(
    report.privacyGeneration,
    1,
    "trusted privacy transition must be durable before shutdown",
  );
  assert.equal(report.usageCount, cycles);
  assert.equal(report.cycleAudit.length, cycles);
  assert.equal(report.confirmedConversationInNextRequest, true);
  const expectedContents = [
    "第一句。",
    "第二句。",
    "收到。",
    ...Array.from({ length: cycles - 3 }, (_, index) => `第${index + 3}轮。`),
    "完成。",
  ];
  assert.deepEqual(
    report.observations.map((item) => item.content),
    expectedContents,
  );
  assert.deepEqual(
    report.observations.map((item) => item.sourceCursor),
    Array.from({ length: cycles + 1 }, (_, index) => String(index + 1)),
  );
  assert.equal(new Set(report.observations.map((item) => item.eventId)).size, cycles + 1);
  const source = await client.sourceCursor("bellis:browser-effects:output", credential.agent_id, {
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(
    source.cursor_position,
    cycles + 1,
    "Core must durably accept exactly the actual output facts",
  );
  return {
    ...report,
    coreSourceCursor: String(source.cursor_position),
    chromium: "passed",
    scope:
      "Real Chromium Worklet -> Runtime/DB Worker -> installed SDK -> Core API/Worker; partial cancellation and next-context confirmed history. Per-cycle durable Manifest/Persona/Recall/budget/Usage audit; not the A4 crash or resource-growth matrix.",
  };
}
