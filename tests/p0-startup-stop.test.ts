import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, open, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { payloadDigest } from "../packages/contract-sdk/src/index.ts";
import { readServiceIdentity } from "../packages/runtime/src/files.ts";
import { safeChildEnvironment } from "../packages/runtime/src/processes.ts";
import { createProductionFixture } from "./p0-endpoint.helpers.ts";
import { repository, stopProcess } from "./p0-identity.helpers.ts";
import { processRecords, records } from "./p0-observation.helpers.ts";

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;

test("p0.startup-stop component: stopped real Host uses configured grace before the parent watchdog", {
  timeout: 20000,
}, async () => {
  // Real processes, but no grant/storage success substitute and no SUT acceptance claim.
  const fixture = await createProductionFixture();
  const base = join(repository, "reports/p0/w5stf/startup-stop");
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "run-"));
  const rawPath = join(directory, "stderr.ndjson");
  const timeline = join(directory, "parent.ndjson");
  const record = (value: object) =>
    appendFileSync(
      timeline,
      `${JSON.stringify({ observer_pid: process.pid, monotonic_ms: performance.now(), ...value })}\n`,
    );
  const file = await open(rawPath, "wx", 0o600);
  const supervisor = spawn(
    process.execPath,
    [join(repository, "apps/host/supervisor.ts"), "--config", fixture.configPath],
    { env: safeChildEnvironment(), stdio: ["ignore", "ignore", file.fd] },
  );
  await file.close();
  const kill = supervisor.kill.bind(supervisor);
  const parentSignals: Array<NodeJS.Signals | number> = [];
  supervisor.kill = (signal = "SIGTERM") => {
    parentSignals.push(signal);
    record({ kind: "kill", target_pid: supervisor.pid, signal });
    return kill(signal);
  };
  supervisor.on("exit", (code, signal) =>
    record({ kind: "exit", target_pid: supervisor.pid, code, signal }),
  );
  let overflow = false;
  const monitor = setInterval(() => {
    if (!overflow && statSync(rawPath).size > MAX_CAPTURE_BYTES) {
      overflow = true;
      record({ kind: "capture_overflow" });
      supervisor.kill("SIGKILL");
    }
  }, 10);
  const readComplete = async () => {
    const bytes = await readFile(rawPath);
    assert.ok(bytes.length <= MAX_CAPTURE_BYTES, "raw capture exceeded finite diagnostic limit");
    const raw = bytes.toString("utf8");
    const end = raw.lastIndexOf("\n");
    // Only inspect complete lines while inherited writers are active. Keep every raw byte on disk.
    return end < 0 ? "" : raw.slice(0, end + 1);
  };
  const processInfo = (pid: number): string | null => {
    try {
      return execFileSync("ps", ["-p", String(pid), "-o", "uid=,pid=,ppid=,command="], {
        encoding: "utf8",
      }).trim();
    } catch (error) {
      if ((error as { status?: number }).status === 1) return null;
      throw error;
    }
  };
  const assertOwned = (pid: number, entry: string) => {
    const actual = processInfo(pid);
    assert.ok(actual, "bound PID must still exist");
    assert.ok(actual.startsWith(`${process.getuid?.()} `), "PID must belong to this local user");
    assert.ok(actual.includes(entry), "PID must run this worktree's actual entry");
    record({ kind: "pid_verified", target_pid: pid, actual });
  };
  let hostPid: number | undefined;
  let supervisorInstance: string | undefined;
  let hostInstance: string | undefined;
  let rawAtExit = "";
  try {
    const until = performance.now() + 5000;
    while (performance.now() < until) {
      assert.equal(supervisor.exitCode, null);
      assert.equal(supervisor.signalCode, null);
      try {
        // The socket exists briefly before chmod/identity publication completes.
        // Wait for the published file, then apply the real controlled identity reader.
        if (
          !(await readFile(`${fixture.config.management_socket_path}.host.identity.json`)).length
        ) {
          await pause(1);
          continue;
        }
        const host = await readServiceIdentity(`${fixture.config.management_socket_path}.host`);
        const owner = await readServiceIdentity(fixture.config.management_socket_path);
        const raw = await readComplete();
        const observations = raw ? processRecords(raw) : [];
        const spawned = observations.find(
          (r) =>
            r.source_role === "supervisor" &&
            r.source_pid === supervisor.pid &&
            r.source_instance_id === owner.instance_id &&
            r.detail.kind === "spawned" &&
            r.detail.child_role === "host" &&
            r.detail.expected_instance_id === host.instance_id,
        );
        if (spawned?.detail.kind === "spawned") {
          const launchId = spawned.detail.launch_id;
          assert.ok(
            observations.some(
              (r) =>
                r.source_pid === supervisor.pid &&
                r.source_instance_id === owner.instance_id &&
                r.detail.kind === "spawn_attempt" &&
                r.detail.launch_id === launchId &&
                r.detail.command_digest ===
                  payloadDigest({
                    exec_path: process.execPath,
                    args: [join(repository, "apps/host/host.ts")],
                  }),
            ),
          );
          assert.equal(
            records(raw).some(
              (r) =>
                "record_type" in r &&
                r.record_type === "p0-protocol-observation" &&
                r.source_instance_id === owner.instance_id &&
                r.detail.kind === "response_received" &&
                r.detail.rpc.method === "simulation.query",
            ),
            false,
            "fault must precede Supervisor endpoint readiness",
          );
          hostPid = spawned.detail.actual_pid;
          supervisorInstance = owner.instance_id;
          hostInstance = host.instance_id;
          assertOwned(hostPid, join(repository, "apps/host/host.ts"));
          record({ kind: "fixture_binding", supervisorInstance, hostInstance });
          process.kill(hostPid, "SIGSTOP");
          record({ kind: "host_sigstop", target_pid: hostPid });
          break;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await pause(1);
    }
    assert.ok(hostPid, "real Host identity/spawn observation must arrive");
    // Keep the original parent's default 1000 ms; the implementation must fit its own child grace.
    await stopProcess(supervisor);
    rawAtExit = await readComplete();
  } finally {
    if (supervisor.exitCode === null && supervisor.signalCode === null)
      await stopProcess(supervisor);
    clearInterval(monitor);
    const cleanup: Array<{ pid: number; entry: string }> = [];
    if (hostPid) cleanup.push({ pid: hostPid, entry: join(repository, "apps/host/host.ts") });
    const raw = await readComplete();
    for (const r of raw ? processRecords(raw) : []) {
      if (
        r.source_pid === hostPid &&
        r.source_instance_id === hostInstance &&
        r.detail.kind === "spawned" &&
        r.detail.child_role === "endpoint"
      )
        cleanup.push({
          pid: r.detail.actual_pid,
          entry: join(repository, "apps/host/endpoint-launcher.mjs"),
        });
    }
    let absent = true;
    for (const child of cleanup) {
      if (processInfo(child.pid)) {
        assertOwned(child.pid, child.entry);
        process.kill(child.pid, "SIGCONT");
        process.kill(child.pid, "SIGTERM");
        record({ kind: "cleanup_resume_term", target_pid: child.pid });
        const until = performance.now() + 1000;
        while (performance.now() < until && processInfo(child.pid)) await pause(10);
        if (processInfo(child.pid)) {
          process.kill(child.pid, "SIGKILL");
          record({ kind: "cleanup_kill", target_pid: child.pid });
          await pause(50);
        }
      }
      const actual = processInfo(child.pid);
      record({ kind: "cleanup_final", target_pid: child.pid, actual });
      absent &&= actual === null;
    }
    const finalRaw = await readComplete();
    await writeFile(
      join(directory, "result.json"),
      `${JSON.stringify(
        {
          supervisor_pid: supervisor.pid,
          supervisor_exit: { code: supervisor.exitCode, signal: supervisor.signalCode },
          parent_signals: parentSignals,
          raw_path: rawPath,
          fixture: fixture.directory,
          overflow,
          cleanup_pids_absent: absent,
          // Diagnostic observations remain observations, never a substitute for authenticated cleanup.
          endpoint_observations: (finalRaw ? records(finalRaw) : []).filter(
            (r) => "endpoint_fact" in r,
          ),
          endpoint_cleanup_proof: "UNKNOWN: no authenticated query in this component test",
          host_owned_paths:
            "UNKNOWN: SIGKILL does not prove owner cleanup; fixture removal is test teardown only",
        },
        null,
        2,
      )}\n`,
    );
    // Retain this unique fixture: killing Host cannot prove all of its owned paths or
    // potentially unreported descendants were cleaned. Raw reports name it for inspection.
  }
  assert.equal(overflow, false);
  assert.deepEqual(parentSignals, ["SIGTERM"], "parent watchdog must not kill Supervisor");
  assert.equal(supervisor.signalCode, null);
  assert.equal(supervisor.exitCode, 0);
  const observed = processRecords(rawAtExit);
  assert.ok(
    observed.some(
      (r) =>
        r.source_pid === supervisor.pid &&
        r.source_instance_id === supervisorInstance &&
        r.detail.kind === "startup_rejected" &&
        r.detail.stage === "connect",
    ),
    // Together with the actual parent SIGTERM and exit 0, this identifies the
    // entrypoint's cancelled-startup branch, not an already-ready runtime.close().
    "Supervisor must actually cancel startup in the connect stage",
  );
  assert.ok(
    observed.some(
      (r) =>
        r.source_pid === supervisor.pid &&
        r.source_instance_id === supervisorInstance &&
        r.detail.kind === "exited" &&
        r.detail.actual_pid === hostPid &&
        r.detail.expected_instance_id === hostInstance &&
        r.detail.exit_code === null &&
        r.detail.signal === "SIGKILL",
    ),
    "Supervisor must retain the actual Host SIGKILL fact before exiting",
  );
  for (const stream of ["process", "protocol"]) {
    assert.ok(
      records(rawAtExit).some(
        (r) =>
          "record_type" in r &&
          r.record_type === "p0-observation-stream-end" &&
          r.source_instance_id === supervisorInstance &&
          r.stream === stream &&
          r.dropped_observations === 0,
      ),
    );
  }
});
