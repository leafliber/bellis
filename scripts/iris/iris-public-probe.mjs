import { runCredentialRevocationProbe } from "./iris-credential-revocation-probe.mjs";
import { runSnapshotRestoreProbe } from "./iris-snapshot-restore-probe.mjs";
import { runHostSnapshotProbe } from "./iris-host-snapshot-probe.mjs";
import { runObserveSnapshotProbe } from "./iris-observe-snapshot-probe.mjs";
import { runIrisLaunchProbe } from "./iris-launch-probe.mjs";
import { runIrisRecoveryProbe } from "./iris-recovery-probe.mjs";
import { runHistoryGapProbe } from "./iris-history-gap-probe.mjs";
import { runEventCheckpointProbe } from "./iris-event-checkpoint-probe.mjs";
import { runResourceInvalidationProbe } from "./iris-resource-invalidation-probe.mjs";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { summarizeReport } from "../evidence/summarize-report.mjs";
import { loadInstalledIrisSdk } from "./iris-installed-sdk.mjs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { runHostContextProbe } from "./iris-host-context-probe.mjs";
import { runIrisToolsProbe } from "./iris-tools-probe.mjs";
import { runIrisStageProbe } from "./iris-stage-probe.mjs";
import { setTimeout as delay } from "node:timers/promises";

// Trusted test operator owns CLI provisioning. Client operations use only SDK/HTTP.
const python = process.env.IRIS_CORE_PYTHON;
if (!python) {
  console.error(
    "Iris integration NOT RUN: set IRIS_CORE_PYTHON to an isolated wheel installation.",
  );
  process.exit(2);
}
const directory = await mkdtemp(join(tmpdir(), "bellis-iris-public-"));
let database = join(directory, "core.sqlite3");
const credentials = join(directory, "client.json");
const children = [];
const logs = [];
const cli = (...args) =>
  execFileSync(python, ["-I", "-m", "iris_memory_core", ...args], {
    cwd: directory,
    encoding: "utf8",
    timeout: 60_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
const launch = (...args) => {
  if (args[0] === "serve" && process.argv.includes("--credential-revocation")) {
    const port = args[args.indexOf("--port") + 1];
    args.push(
      "--enable-console",
      "--console-dev-http",
      "--console-origin",
      `http://127.0.0.1:${port}`,
      "--console-allowed-hosts",
      "127.0.0.1",
    );
  }
  const child = spawn(python, ["-I", "-m", "iris_memory_core", ...args], {
    cwd: directory,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  child.stdout.on("data", (chunk) => {
    if (logs.length < 256) logs.push(String(chunk));
  });
  child.stderr.on("data", (chunk) => {
    if (logs.length < 256) logs.push(String(chunk));
  });
  return child;
};
let provider;
try {
  const installation = JSON.parse(
    execFileSync(
      python,
      [
        "-I",
        "-c",
        [
          "import importlib.metadata as m,json,zipfile,pathlib,urllib.parse,hashlib",
          "d=m.distribution('iris-memory-core')",
          "direct=json.loads(d.read_text('direct_url.json') or '{}')",
          "wheel=pathlib.Path(urllib.parse.unquote(urllib.parse.urlparse(direct['url']).path))",
          "z=zipfile.ZipFile(wheel)",
          "paths=[p for p in z.namelist() if not p.endswith('/') and not p.endswith('.dist-info/RECORD')]",
          "verified=all(pathlib.Path(d.locate_file(p)).read_bytes()==z.read(p) for p in paths)",
          "print(json.dumps({'version':d.version,'direct':direct,'wheel_payload_verified':verified,'wheel_files_checked':len(paths),'wheel_sha256':hashlib.sha256(wheel.read_bytes()).hexdigest()}))",
        ].join("; "),
      ],
      { cwd: directory, encoding: "utf8" },
    ),
  );
  const candidateProfiles = {
    "65169f6067debfcf676f542bfc73e2054a28c7a33350d2aa97d567caed420ab9": {
      schema: 18,
      initializeSearch: true,
    },
    "645795c46c48faa5ba5adbeec257aa2c100131fa799824a147f97ccb7461803e": {
      schema: 19,
      initializeSearch: true,
    },
    "8b03aa2b65a98ddcaf3c5044d2ae2f9ad45a6094c2b5263171915c376e780646": {
      schema: 19,
      initializeSearch: true,
    },
    c3114eec8208aff4b527d261fcee285bc6f347cfb5837ac7e14dd23ef04b8beb: {
      schema: 19,
      initializeSearch: true,
    },
    "2183f77fbcbcc00abecb27bdb4440d7eb8f6fff19aaf125bf4487dc0a253642f": {
      schema: 20,
      initializeSearch: true,
    },
  };
  const profile =
    (installation.version === "0.13.0"
      ? candidateProfiles[installation.wheel_sha256]
      : undefined) ??
    {
      "0.12.0": { schema: 14, initializeSearch: false },
      "0.13.0": { schema: 15, initializeSearch: true },
    }[installation.version];
  assert.ok(profile, "Core installation is outside the explicit probe profiles");
  assert.ok(!installation.direct.dir_info?.editable, "editable Core is not installation evidence");
  assert.ok(installation.direct.url?.endsWith(".whl"), "Core must be installed from a wheel");
  const installedWheelHash = createHash("sha256")
    .update(await readFile(fileURLToPath(installation.direct.url)))
    .digest("hex");
  assert.equal(
    installation.wheel_payload_verified,
    true,
    "installed Core files must match wheel contents",
  );
  assert.ok(installation.wheel_files_checked > 100);
  assert.equal(installation.wheel_sha256, installedWheelHash);
  cli(
    "init",
    "--database",
    database,
    "--tenant",
    "bellis-probe",
    "--agent-name",
    "Bellis probe",
    "--app-instance",
    "bellis-probe",
    "--actor-provider",
    "bellis-test",
    "--actor-subject",
    "viewer",
    "--credential-file",
    credentials,
    ...(profile.initializeSearch ? ["--initialize-search"] : []),
    "--surface-mode",
    "off",
    "--allow-local-sqlite",
  );
  assert.equal(cli("schema-version", database).trim(), String(profile.schema));
  const credential = JSON.parse(await readFile(credentials, "utf8"));
  const port = await new Promise((resolve, reject) => {
    const listener = createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const selected = listener.address().port;
      listener.close(() => resolve(selected));
    });
  });
  let server = launch(
    "serve",
    "--database",
    database,
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--allow-local-sqlite",
  );
  let baseUrl;
  for (let attempt = 0; attempt < 300; attempt++) {
    const match = logs.join("").match(/http:\/\/127\.0\.0\.1:(\d+)/);
    if (match) {
      baseUrl = `http://127.0.0.1:${match[1]}`;
      break;
    }
    assert.equal(server.exitCode, null, `Core exited during startup: ${logs.join("")}`);
    await delay(100);
  }
  assert.ok(baseUrl, "Core did not report its loopback address");
  const module = await import("../../providers/memory-iris/dist/src/index.js");
  provider = new module.IrisMemoryProvider({
    baseUrl,
    bearerToken: credential.token,
    minimumCoreSchemaVersion: profile.schema,
    maximumCoreSchemaVersion: profile.schema,
  });
  const signal = AbortSignal.timeout(15_000);
  await provider.start({ appInstanceId: "bellis-probe", agentId: credential.agent_id });
  const capabilities = await provider.capabilities(signal);
  assert.equal(capabilities.coreSchemaVersion, profile.schema);
  const persona = await provider.current(credential.agent_id, signal);
  assert.equal(persona.origin, "live");
  assert.match(persona.contentHash, /^[0-9a-f]{64}$/); // Provider verifies canonical/legacy-bootstrap hash.
  const now = Date.now();
  const event = {
    schemaVersion: 1,
    eventId: randomUUID(),
    outboxId: randomUUID(),
    agentId: credential.agent_id,
    spaceId: credential.space_id,
    role: "assistant",
    kind: "message.text",
    occurredAtMs: now,
    committedAtMs: now,
    sourceStream: "bellis:probe",
    sourceCursor: "1",
    privacyLabels: [`space:${credential.space_id}`],
    effectState: "partial",
    content: "已确认片段",
    effectProof: { confirmed_range: { unit: "utf16", start: 0, end: 5 } },
  };
  // API must accept durably even while Worker is stopped.
  await provider.observe([event], signal);
  await provider.observe([event], signal);
  const {
    modulePath: sdkPath,
    AsyncIrisMemoryClient,
    metadata: sdkPackage,
    provenance: sdkProvenance,
  } = await loadInstalledIrisSdk();
  const client = new AsyncIrisMemoryClient(baseUrl, {
    bearerToken: credential.token,
    fetch: module.checkedIrisFetch(),
  });
  const cursor = await client.sourceCursor("bellis:probe", credential.agent_id, { signal });
  assert.equal(cursor.cursor_position, 1);
  let worker = launch("worker", "--database", database, "--allow-local-sqlite");
  const query = {
    schemaVersion: 1,
    queryId: randomUUID(),
    agentId: credential.agent_id,
    spaceId: credential.space_id,
    actors: [{ provider: "bellis-test", externalId: "viewer" }],
    topic: "已确认片段",
    purpose: "reply",
    privacyScope: `space:${credential.space_id}`,
  };
  let recall;
  for (let attempt = 0; attempt < 30; attempt++) {
    recall = await provider.provideContext(
      { ...query, queryId: randomUUID() },
      { tokenBudget: 2000, deadlineMs: 250 },
      signal,
    );
    if (recall.blocks.length) break;
    await delay(100);
  }
  assert.ok(recall.blocks.length > 0, "real Core recall must return the observed prefix");
  assert.ok(recall.blocks.some((block) => block.text.includes(event.content)));
  const ids = recall.blocks.map((block) => block.id);
  await provider.reportUsage(
    {
      schemaVersion: 1,
      requestId: recall.requestId,
      hostCycleId: randomUUID(),
      outboxId: randomUUID(),
      personaRevision: recall.personaRevision,
      returnedBlockIds: recall.returnedBlockIds,
      hostSelectedBlockIds: ids,
      modelVisibleBlockIds: ids,
      reportedAtMs: Date.now(),
    },
    signal,
  );
  await assert.rejects(
    provider.observe([{ ...event, effectProof: {} }], signal),
    /confirmed_range/,
  );
  const wrongAuth = new module.IrisMemoryProvider({
    baseUrl,
    bearerToken: "invalid",
    minimumCoreSchemaVersion: profile.schema,
    maximumCoreSchemaVersion: profile.schema,
  });
  await assert.rejects(
    wrongAuth.current(credential.agent_id, signal),
    (error) => error instanceof module.IrisBoundaryError && !error.retryable,
  );
  await provider.stop();
  provider = undefined;
  const hostContext = await runHostContextProbe(baseUrl, credential, directory, profile.schema);
  const continuous = process.argv.includes("--continuous");
  const stageRecovery =
    process.argv.includes("--stage-recovery") || process.argv.includes("--stage-observe-recovery")
      ? await runIrisStageProbe(
          baseUrl,
          credential,
          directory,
          client,
          profile.schema,
          3,
          process.argv.includes("--recovery-smoke") ? 1 : 20,
          process.argv.includes("--stage-observe-recovery") ? "observe" : "effects",
        )
      : undefined;
  const stageOutput =
    process.argv.includes("--stage") || continuous
      ? await runIrisStageProbe(
          baseUrl,
          credential,
          directory,
          client,
          profile.schema,
          continuous ? 100 : 3,
        )
      : undefined;
  const tools = process.argv.includes("--tools")
    ? await runIrisToolsProbe(baseUrl, credential, client, directory, profile.schema)
    : undefined;
  const resourceInvalidation =
    process.argv.includes("--invalidations") ||
    process.argv.includes("--event-checkpoint") ||
    process.argv.includes("--history-gap")
      ? await runResourceInvalidationProbe(baseUrl, credential, client, directory, profile.schema)
      : undefined;
  const resourceCorrection =
    process.argv.includes("--corrections") ||
    process.argv.includes("--recall-revalidation") ||
    process.argv.includes("--recall-batch-revalidation")
      ? await runResourceInvalidationProbe(baseUrl, credential, client, directory, profile.schema, {
          correction: true,
          revalidateRecall:
            process.argv.includes("--recall-revalidation") ||
            process.argv.includes("--recall-batch-revalidation"),
          revalidateBatch: process.argv.includes("--recall-batch-revalidation"),
          pauseWorker: async () => {
            const previous = worker;
            await new Promise((resolve, reject) => {
              const timeout = setTimeout(
                () => reject(new Error("Core Worker stop timed out")),
                10_000,
              );
              previous.once("exit", () => {
                clearTimeout(timeout);
                resolve();
              });
              previous.kill("SIGTERM");
            });
            assert.ok(previous.exitCode !== null || previous.signalCode !== null);
            return async () => {
              worker = launch("worker", "--database", database, "--allow-local-sqlite");
            };
          },
        })
      : undefined;
  const eventCheckpoint = process.argv.includes("--event-checkpoint")
    ? await runEventCheckpointProbe(baseUrl, credential, client)
    : undefined;
  const historyGap = process.argv.includes("--history-gap")
    ? await runHistoryGapProbe(baseUrl, credential, client, directory, profile.schema)
    : undefined;
  const launcher = process.argv.includes("--launch-config")
    ? await runIrisLaunchProbe(baseUrl, credential, directory, profile.schema)
    : undefined;
  const recovery = process.argv.includes("--recovery")
    ? await runIrisRecoveryProbe(
        baseUrl,
        credential,
        client,
        directory,
        profile.schema,
        {
          async restart(target) {
            const previous = target === "core-api" ? server : worker;
            assert.equal(previous.exitCode, null);
            assert.equal(previous.signalCode, null);
            const stopped = new Promise((resolve) =>
              previous.once("exit", (code, signal) => resolve({ code, signal })),
            );
            previous.kill("SIGKILL");
            assert.equal((await stopped).signal, "SIGKILL");
            const next =
              target === "core-api"
                ? launch(
                    "serve",
                    "--database",
                    database,
                    "--host",
                    "127.0.0.1",
                    "--port",
                    String(port),
                    "--allow-local-sqlite",
                  )
                : launch("worker", "--database", database, "--allow-local-sqlite");
            assert.notEqual(next.pid, previous.pid);
            await new Promise((resolve, reject) => {
              next.once("spawn", resolve);
              next.once("error", reject);
            });
            if (target === "core-api") {
              let ready = false;
              for (let attempt = 0; attempt < 200; attempt++) {
                assert.equal(next.exitCode, null);
                try {
                  await client.sourceCursor("bellis:probe", credential.agent_id, {
                    signal: AbortSignal.timeout(500),
                  });
                  ready = true;
                  break;
                } catch {
                  await delay(50);
                }
              }
              assert.ok(ready, "restarted Core API did not serve its public boundary");
              server = next;
            } else {
              worker = next;
            }
            return { signal: "SIGKILL", replacedProcess: true };
          },
        },
        process.argv.includes("--recovery-smoke") ? 1 : 20,
      )
    : undefined;
  const observeSnapshotRestore = process.argv.includes("--observe-snapshot-restore")
    ? await runObserveSnapshotProbe(baseUrl, credential, client, directory, profile.schema)
    : undefined;
  const hostSnapshotRestore = process.argv.includes("--host-snapshot-restore")
    ? await runHostSnapshotProbe(baseUrl, credential, client, directory, profile.schema)
    : undefined;
  const snapshotRestore = process.argv.includes("--snapshot-restore")
    ? await runSnapshotRestoreProbe(baseUrl, credential, client, directory, profile.schema, {
        async backup(label) {
          const snapshot = join(directory, `core-backup-${label}`);
          const target = join(directory, `core-restored-${label}`);
          const keyPath = join(directory, `backup-key-${label}`);
          await writeFile(keyPath, randomBytes(32), { mode: 0o600, flag: "wx" });
          const result = cli(
            "migrate",
            database,
            "--with-backup",
            snapshot,
            "--backup-key-file",
            keyPath,
          );
          assert.match(result, new RegExp(`schema_version=${profile.schema} applied=0`));
          return async () => {
            const stop = async (child) => {
              assert.equal(child.exitCode, null);
              const exit = await new Promise((resolve, reject) => {
                const timer = setTimeout(
                  () => reject(new Error("Core snapshot stop timed out")),
                  10000,
                );
                child.once("exit", (code, signal) => {
                  clearTimeout(timer);
                  resolve({ code, signal });
                });
                child.kill("SIGTERM");
              });
              assert.ok(exit.code === 0 || exit.signal === "SIGTERM");
              return exit;
            };
            const stopped = await Promise.all([stop(server), stop(worker)]);
            assert.match(
              cli("restore", snapshot, target, "--backup-key-file", keyPath),
              /restored target=/,
            );
            database = join(target, "canonical.sqlite3");
            server = launch(
              "serve",
              "--database",
              database,
              "--host",
              "127.0.0.1",
              "--port",
              String(port),
              "--allow-local-sqlite",
            );
            worker = launch("worker", "--database", database, "--allow-local-sqlite");
            let ready = false;
            for (let n = 0; n < 200; n++) {
              assert.equal(server.exitCode, null);
              assert.equal(worker.exitCode, null);
              try {
                await client.sourceCursor("bellis:probe", credential.agent_id, {
                  signal: AbortSignal.timeout(1000),
                });
                ready = true;
                break;
              } catch {
                await delay(25);
              }
            }
            assert.ok(ready, "Restored Core did not become reachable");
            return { stopped, signedBackupVerified: true, restoreCli: "passed" };
          };
        },
      })
    : undefined;
  const credentialRevocation = process.argv.includes("--credential-revocation")
    ? await runCredentialRevocationProbe(
        baseUrl,
        credential,
        directory,
        profile.schema,
        JSON.parse(
          cli(
            "console",
            "key",
            "issue",
            "--database",
            database,
            "--tenant",
            "bellis-probe",
            "--role",
            "owner",
            "--can-delegate",
            "--label",
            "isolated-bellis-revocation-probe",
            "--data-purpose",
            "reply",
            "--data-purpose",
            "planning",
            "--data-purpose",
            "reflection",
            "--data-purpose",
            "tool",
            "--allow-local-sqlite",
          ),
        ).secret,
        client,
      )
    : undefined;
  const evidence = {
    ...(stageRecovery === undefined ? {} : { stageRecovery }),
    ...(observeSnapshotRestore === undefined ? {} : { observeSnapshotRestore }),
    ...(hostSnapshotRestore === undefined ? {} : { hostSnapshotRestore }),
    ...(snapshotRestore === undefined ? {} : { snapshotRestore }),
    ...(credentialRevocation === undefined ? {} : { credentialRevocation }),
    ...(launcher === undefined ? {} : { launcher }),
    ...(eventCheckpoint === undefined ? {} : { eventCheckpoint }),
    ...(historyGap === undefined ? {} : { historyGap }),
    ...(recovery === undefined ? {} : { recovery }),
    ...(resourceInvalidation === undefined ? {} : { resourceInvalidation }),
    ...(resourceCorrection === undefined ? {} : { resourceCorrection }),
    ...(tools === undefined ? {} : { tools }),
    hostContext,
    ...(stageOutput === undefined ? {} : { stageOutput }),
    stage:
      stageRecovery !== undefined
        ? "A0/A1 and A2 real Chromium effect transaction Runtime crash probe"
        : stageOutput === undefined
          ? "A0/A1 and A2 trusted-input public boundary probe"
          : "A0/A1 and A2 real Chromium output/input public boundary probe",
    coreVersion: installation.version,
    searchInitialization: profile.initializeSearch
      ? "trusted-cli-verified-generation"
      : "not-requested",
    coreWheelSha256: installedWheelHash,
    installedCoreFilesVerified: installation.wheel_files_checked,
    schemaVersion: capabilities.coreSchemaVersion,
    sdkVersion: sdkPackage.version,
    sdkTarballSha256: sdkProvenance.sha256,
    installedSdkFilesVerified: Object.keys(sdkProvenance.files).length,
    sdkInstalledSha256: createHash("sha256")
      .update(await readFile(sdkPath))
      .digest("hex"),
    developmentSqliteOverride: true,
    surfaceMode: "off",
    persona: "verified",
    recallBlocks: ids.length,
    usage: "accepted",
    partialProof: "accepted",
    duplicateObserve: "accepted",
    workerStoppedAcceptance: "passed",
    scope:
      stageRecovery !== undefined
        ? stageRecovery.scope
        : recovery !== undefined
          ? recovery.scope
          : stageOutput === undefined
            ? "Core API/Worker + installed SDK + Bellis Decision Host/DB Worker; no Stage effect confirmation or A4 crash-matrix evidence"
            : "Core API/Worker + installed SDK + real Chromium Stage + Bellis Decision Host/DB Worker; no A4 crash/stress-matrix evidence",
  };
  const reportPath = process.env.IRIS_PROBE_REPORT ??
    fileURLToPath(new URL("../../artifacts/evidence/iris-probe-raw.json", import.meta.url));
  const rawReport = `${JSON.stringify(evidence, null, 2)}\n`;
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, rawReport);
  const incomplete = tools?.status === "incomplete" || recovery?.status === "incomplete";
  if (incomplete) process.exitCode = 2;
  console.info(
    `iris-public-probe: ${incomplete ? "incomplete" : "ok"} ${JSON.stringify(summarizeReport(rawReport, { path: reportPath }))}`,
  );
} finally {
  await provider?.stop();
  for (const child of children.reverse()) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const stopped = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
    await stopped;
    clearTimeout(timeout);
  }
  await rm(directory, { recursive: true, force: true });
}
