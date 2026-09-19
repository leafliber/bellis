import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { payloadDigest } from "../packages/contract-sdk/src/index.ts";
import { readServiceIdentity } from "../packages/runtime/src/files.ts";
import { safeChildEnvironment, terminateChild } from "../packages/runtime/src/processes.ts";
import { createProductionFixture } from "./p0-endpoint.helpers.ts";
import { repository } from "./p0-identity.helpers.ts";
import { processRecords, records } from "./p0-observation.helpers.ts";

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const missing = async (path: string) => {
  try {
    await access(path);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
};
function processInfo(pid: number) {
  try {
    const raw = execFileSync(
      "ps",
      ["-p", String(pid), "-o", "uid=,pid=,ppid=,stat=,lstart=,command="],
      {
        encoding: "utf8",
      },
    ).trim();
    const fields = raw.split(/\s+/);
    return {
      uid: Number(fields[0]),
      pid: Number(fields[1]),
      parent: Number(fields[2]),
      state: fields[3] ?? "",
      started: fields.slice(4, 9).join(" "),
      command: fields.slice(9).join(" "),
      raw,
    };
  } catch (error) {
    if ((error as { status?: number }).status === 1) return null;
    throw error;
  }
}
type Owned = NonNullable<ReturnType<typeof processInfo>>;

for (const cancelled of ["host", "supervisor"] as const) {
  test(`p0.startup-cleanup component: ${cancelled} cancellation removes local paths while endpoint is stopped`, {
    timeout: 20000,
  }, async () => {
    const fixture = await createProductionFixture();
    // A declared finite test budget leaves time to observe independence; production defaults are unchanged.
    fixture.config.limits.stop_timeout_ms = 1500;
    await writeFile(fixture.configPath, JSON.stringify(fixture.config));
    const base = join(repository, "reports/p0/w5sf/startup-cleanup");
    await mkdir(base, { recursive: true });
    const directory = await mkdtemp(join(base, "run-"));
    const rawPath = join(directory, "stderr.ndjson");
    const timeline = join(directory, "parent.ndjson");
    await writeFile(rawPath, "", { flag: "wx", mode: 0o600 });
    const record = (value: object) =>
      appendFileSync(
        timeline,
        `${JSON.stringify({ observer_pid: process.pid, monotonic_ms: performance.now(), ...value })}\n`,
      );
    const supervisor = spawn(
      process.execPath,
      [join(repository, "apps/host/supervisor.ts"), "--config", fixture.configPath],
      {
        env: safeChildEnvironment(),
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let raw = "",
      bytes = 0,
      eof = false,
      overflow = false;
    supervisor.stderr.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 16 * 1024 * 1024) {
        overflow = true;
        supervisor.kill("SIGKILL");
        supervisor.stderr.destroy();
        return;
      }
      appendFileSync(rawPath, chunk);
      raw += chunk.toString("utf8");
    });
    supervisor.stderr.on("end", () => {
      eof = true;
      record({ kind: "capture_eof", bytes });
    });
    supervisor.on("exit", (code, signal) => record({ kind: "supervisor_exit", code, signal }));
    const complete = () => raw.slice(0, raw.lastIndexOf("\n") + 1);
    const observed = () => (complete() ? processRecords(complete()) : []);
    const owned = new Map<number, Owned>();
    const bind = (pid: number, parent: number, entry: string): Owned => {
      const info = processInfo(pid);
      assert.ok(info, "actual child PID must exist");
      assert.equal(info.uid, process.getuid?.());
      assert.equal(info.parent, parent);
      assert.equal(info.command, `${process.execPath} ${entry}`);
      owned.set(pid, info);
      record({ kind: "pid_verified", info });
      return info;
    };
    const signalOwned = (pid: number, signal: NodeJS.Signals) => {
      const expected = owned.get(pid);
      const actual = processInfo(pid);
      if (!actual) return;
      assert.ok(expected);
      assert.deepEqual(
        [actual.uid, actual.started, actual.command],
        [expected.uid, expected.started, expected.command],
      );
      process.kill(pid, signal);
      record({ kind: "signal", pid, signal, actual });
    };
    let host: Owned | undefined, endpoint: Owned | undefined;
    let hostInstance: string | undefined;
    let sampled: object | undefined;
    let independent = false;
    try {
      const readyUntil = performance.now() + 5000;
      while (performance.now() < readyUntil && !endpoint) {
        assert.equal(supervisor.exitCode, null);
        assert.equal(supervisor.signalCode, null);
        const items = observed();
        const h = items.find(
          (r) =>
            r.source_pid === supervisor.pid &&
            r.detail.kind === "spawned" &&
            r.detail.child_role === "host",
        );
        if (h?.detail.kind === "spawned") {
          hostInstance = h.detail.expected_instance_id ?? undefined;
          if (!host)
            host = bind(
              h.detail.actual_pid,
              Number(supervisor.pid),
              join(repository, "apps/host/host.ts"),
            );
          const e = items.find(
            (r) =>
              r.source_pid === host?.pid &&
              r.source_instance_id === hostInstance &&
              r.detail.kind === "spawned" &&
              r.detail.child_role === "endpoint",
          );
          if (e?.detail.kind === "spawned") {
            const launch = e.detail.launch_id;
            assert.ok(
              items.some(
                (r) =>
                  r.source_pid === host?.pid &&
                  r.source_instance_id === hostInstance &&
                  r.detail.kind === "spawn_attempt" &&
                  r.detail.launch_id === launch &&
                  r.detail.command_digest ===
                    payloadDigest({
                      exec_path: process.execPath,
                      args: [join(repository, "apps/host/endpoint-launcher.mjs")],
                    }),
              ),
            );
            endpoint = bind(
              e.detail.actual_pid,
              host.pid,
              join(repository, "apps/host/endpoint-launcher.mjs"),
            );
            signalOwned(host.pid, "SIGSTOP");
          }
        }
        if (!endpoint) await pause(1);
      }
      assert.ok(host && endpoint, "actual parent-bound endpoint must launch");
      // Host cannot finish its handshake while paused. The real safety listener
      // is installed only after Endpoint's SIGTERM handler, unlike an early PID.
      const listeningUntil = performance.now() + 2000;
      while (await missing(fixture.config.safety_socket_path)) {
        assert.ok(performance.now() < listeningUntil, "real endpoint safety socket must listen");
        await pause(2);
      }
      record({ kind: "endpoint_safety_socket_present", pid: endpoint.pid });
      signalOwned(endpoint.pid, "SIGSTOP");
      const hostPath = `${fixture.config.management_socket_path}.host`;
      assert.equal((await readServiceIdentity(hostPath)).instance_id, hostInstance);
      assert.equal(
        records(complete()).some(
          (r) =>
            "record_type" in r &&
            r.record_type === "p0-protocol-observation" &&
            r.source_instance_id === hostInstance &&
            r.detail.kind === "response_received" &&
            r.detail.rpc.method === "simulation.query",
        ),
        false,
        "fault must precede Host endpoint readiness",
      );
      assert.ok(processInfo(endpoint.pid)?.state.includes("T"));
      const started = performance.now();
      if (cancelled === "host") signalOwned(host.pid, "SIGTERM");
      else {
        record({ kind: "signal", pid: supervisor.pid, signal: "SIGTERM" });
        supervisor.kill("SIGTERM");
      }
      signalOwned(host.pid, "SIGCONT");
      // Inspect before the existing child budget; the assertion also requires a still-stopped endpoint.
      const until = started + fixture.config.limits.stop_timeout_ms / 2;
      while (performance.now() < until) {
        const hostRemoved =
          (await missing(hostPath)) && (await missing(`${hostPath}.identity.json`));
        const supervisorRemoved =
          cancelled === "host" ||
          ((await missing(fixture.config.management_socket_path)) &&
            (await missing(`${fixture.config.management_socket_path}.identity.json`)));
        if (hostRemoved && supervisorRemoved) {
          const actual = processInfo(endpoint.pid);
          sampled = {
            hostRemoved,
            supervisorRemoved,
            actual,
            elapsed_ms: performance.now() - started,
          };
          independent = !!actual?.state.includes("T");
          break;
        }
        await pause(5);
      }
      sampled ??= {
        host_identity_present: !(await missing(`${hostPath}.identity.json`)),
        endpoint: processInfo(endpoint.pid),
        elapsed_ms: performance.now() - started,
      };
      record({ kind: "independence_sample", independent, sampled });
    } finally {
      // Resume only the verified child so the actual parent can collect exit status.
      if (endpoint) signalOwned(endpoint.pid, "SIGCONT");
      if (host) signalOwned(host.pid, "SIGCONT");
      if (supervisor.exitCode === null && supervisor.signalCode === null) {
        record({ kind: "teardown_supervisor_term", pid: supervisor.pid });
        await terminateChild(supervisor, fixture.config.limits.stop_timeout_ms + 1000);
      }
      for (const child of [...owned.values()].reverse()) {
        if (processInfo(child.pid)) signalOwned(child.pid, "SIGTERM");
        const until = performance.now() + 1000;
        while (performance.now() < until && processInfo(child.pid)) await pause(10);
        if (processInfo(child.pid)) signalOwned(child.pid, "SIGKILL");
      }
      const until = performance.now() + 1000;
      while (!eof && performance.now() < until) await pause(10);
      if (!eof) supervisor.stderr.destroy();
      await writeFile(
        join(directory, "result.json"),
        `${JSON.stringify(
          {
            cancelled,
            fixture: fixture.directory,
            limits: fixture.config.limits,
            independent,
            sampled,
            supervisor_exit: { code: supervisor.exitCode, signal: supervisor.signalCode },
            raw_bytes: bytes,
            capture_eof: eof,
            overflow,
            sha256: createHash("sha256")
              .update(await readFile(rawPath))
              .digest("hex"),
            actual_parent_exits: observed().filter((r) => r.detail.kind === "exited"),
            endpoint_cleanup:
              "UNKNOWN: no authenticated endpoint cleanup query; PID exit and path removal are not device proof",
            sut: "PENDING",
          },
          null,
          2,
        )}\n`,
      );
    }
    assert.equal(overflow, false);
    assert.equal(eof, true, "actual inherited PIPE EOF is required, not parent process exit");
    assert.equal(
      independent,
      true,
      "owned management paths must disappear while endpoint is still stopped, before child termination budget",
    );
  });
}
