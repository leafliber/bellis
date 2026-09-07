import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

/** Actual command, installed Provider/SDK, Core and DB Worker. No credential
 * values in command arguments, files, returned evidence or assertion text. */
export async function runIrisLaunchProbe(baseUrl, credential, directory, schemaVersion) {
  const configPath = join(directory, "iris-launch.json");
  const sessionId = randomUUID();
  const config = {
    schemaVersion: 1,
    runtime: {
      dataDirectory: join(directory, "iris-launch-data"),
      runtimeVersion: "0.1.0-launch-probe",
      port: 0,
      phase2: { enabled: true, sessionId },
      phase3: { enabled: true, sessionId },
    },
    iris: {
      enabled: true,
      baseUrl,
      allowedOrigins: [baseUrl],
      credential: { kind: "environment", name: "BELLIS_IRIS_LAUNCH_PROBE_TOKEN" },
      appInstanceId: "iris-launch-probe",
      agentId: credential.agent_id,
      spaceId: credential.space_id,
      identityScope: "profile:launch-probe",
      privacyRevision: "1",
      scope: { kind: "space", acknowledgeCrossSession: true },
      actors: [{ provider: "bellis-test", externalId: "viewer" }],
      publicLabels: [`space:${credential.space_id}`],
      coreSchema: { minimum: schemaVersion, maximum: schemaVersion },
      historyRecovery: { intervalMs: 100, timeoutMs: 10000 },
    },
  };
  const results = [];
  for (const mode of ["enabled", "restart", "disabled", "missing-credential"]) {
    const disabled = mode === "disabled";
    await writeFile(
      configPath,
      JSON.stringify(
        disabled
          ? {
              schemaVersion: 1,
              runtime: {
                dataDirectory: join(directory, "iris-disabled-data"),
                runtimeVersion: "0.1.0-launch-probe",
                port: 0,
              },
              iris: { enabled: false },
            }
          : config,
      ),
      { mode: 0o600 },
    );
    const env = { ...process.env };
    delete env.BELLIS_IRIS_LAUNCH_PROBE_TOKEN;
    if (!disabled && mode !== "missing-credential")
      env.BELLIS_IRIS_LAUNCH_PROBE_TOKEN = credential.token;
    const child = spawn(
      process.execPath,
      ["scripts/start-iris-runtime.mjs", "--config", configPath],
      {
        cwd: new URL("..", import.meta.url),
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "",
      exited = false,
      exitCode;
    const complete = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => {
        exited = true;
        exitCode = code;
        resolve(code);
      });
    });
    const capture = (bytes) => {
      if (output.length + bytes.length > 1024 * 1024) child.kill("SIGKILL");
      else output += bytes.toString("utf8");
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    try {
      const deadline = Date.now() + 15000;
      let match;
      while (
        !exited &&
        Date.now() < deadline &&
        !(match = /iris-runtime: ready on loopback port (\d+)/u.exec(output))
      )
        await delay(20);
      if (mode === "missing-credential") {
        assert.ok(exited, "missing credential must fail before listening");
        assert.equal(exitCode, 1);
        assert.ok(!/iris-runtime: ready/u.test(output));
      } else {
        assert.ok(match, `configured runtime must become ready (${mode}, exit=${exitCode})`);
        const origin = `http://127.0.0.1:${match[1]}`;
        for (const endpoint of ["live", "ready"])
          assert.equal(
            (
              await fetch(`${origin}/api/v1/health/${endpoint}`, {
                headers: { origin },
                signal: AbortSignal.timeout(5000),
              })
            ).status,
            200,
          );
        child.kill("SIGTERM");
        let timer;
        try {
          await Promise.race([
            complete,
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error("launcher shutdown timeout")), 10000);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
        assert.equal(exitCode, 0);
      }
      assert.ok(!output.includes(credential.token), "launcher must not expose the credential");
      results.push({ mode, status: "passed", exitCode });
    } finally {
      if (!exited) child.kill("SIGKILL");
      await complete;
    }
  }
  return {
    status: "passed",
    results,
    credentialSource: "environment-reference",
    schemaVersion,
    defaultSupportWindowChanged: false,
    scope:
      "Actual CLI startup/restart/disabled/missing-credential and graceful SIGTERM with installed Provider/SDK and real Core; no new model turn or full production authorization claim",
  };
}
