import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, statSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { after, before, test } from "node:test";
import {
  assertValid,
  type P0EndpointConfig,
  payloadDigest,
  validateManifest,
  validateProfile,
} from "../packages/contract-sdk/src/index.ts";
import { RpcConnection } from "../packages/runtime/src/client.ts";
import { MonotonicClock } from "../packages/runtime/src/clock.ts";
import { loadRuntimeConfig, verifyInstallation } from "../packages/runtime/src/config.ts";
import { readServiceIdentity } from "../packages/runtime/src/files.ts";
import {
  exportPrivate,
  generateIdentity,
  operatorRequest,
  peerRequest,
} from "../packages/runtime/src/identity.ts";
import {
  safeChildEnvironment,
  startSupervisor,
  terminateChild,
} from "../packages/runtime/src/processes.ts";
import { JsonChannel } from "../packages/runtime/src/transport.ts";
import { createProductionFixture } from "./p0-endpoint.helpers.ts";
import {
  createFixture,
  limits,
  repository,
  runCli,
  stopProcess,
  waitFor,
} from "./p0-identity.helpers.ts";

let fixture: Awaited<ReturnType<typeof createFixture>>;

test("p0.identity: production startup refuses a renamed installation even with matching file and Manifest digests", async () => {
  const fixture = await createProductionFixture();
  try {
    const manifest = { ...fixture.manifest, plugin_id: "renamed-fake" };
    const path = join(fixture.directory, "fake/manifest.json");
    const bytes = Buffer.from(JSON.stringify(manifest));
    await writeFile(path, bytes);
    fixture.config.installation.plugin_id = manifest.plugin_id;
    fixture.config.installation.manifest_digest = payloadDigest(manifest);
    const artifact = fixture.config.installation.artifacts.find((item) => item.path === path);
    assert.ok(artifact);
    artifact.sha256 = createHash("sha256").update(bytes).digest("hex");
    await assert.doesNotReject(verifyInstallation(fixture.config.installation));
    await writeFile(fixture.configPath, JSON.stringify(fixture.config));
    await assert.rejects(loadRuntimeConfig(fixture.configPath), /INSTALLATION_IDENTITY_DENIED/);
  } finally {
    await fixture.cleanup();
  }
});
before(async () => {
  fixture = await createFixture();
});
after(async () => {
  await fixture?.cleanup();
});

test("p0.identity: installation verifies actual SDK/runtime closure and refuses omissions and substitution", async () => {
  const verified = await verifyInstallation(fixture.config.installation);
  assert.ok(
    fixture.config.installation.artifacts.some((a) =>
      a.path.endsWith("packages/runtime/src/service.ts"),
    ),
  );
  assert.ok(
    fixture.config.installation.artifacts.some((a) =>
      a.path.endsWith("contracts/generated/validators.mjs"),
    ),
  );
  assert.doesNotThrow(() => validateProfile(fixture.config.profile, verified.context));
  assert.doesNotThrow(() => validateManifest(fixture.manifest, undefined, verified.context));
  assert.throws(() => validateProfile(fixture.config.profile), /SIMULATION_INSTALLATION_REQUIRED/);
  assert.throws(() => validateManifest(fixture.manifest), /SIMULATION_INSTALLATION_REQUIRED/);
  const missing = structuredClone(fixture.config.installation);
  missing.artifacts = missing.artifacts.filter(
    (a) => !a.path.endsWith("packages/runtime/src/service.ts"),
  );
  await assert.rejects(verifyInstallation(missing), /INSTALLATION_IDENTITY_DENIED/);
  await assert.rejects(
    verifyInstallation({ ...fixture.config.installation, manifest_digest: "0".repeat(64) }),
    /INSTALLATION_IDENTITY_DENIED/,
  );
  const bytes = await readFile(fixture.entry);
  try {
    await writeFile(fixture.entry, "process.exit(0);\n");
    await assert.rejects(
      verifyInstallation(fixture.config.installation),
      /INSTALLATION_IDENTITY_DENIED/,
    );
  } finally {
    await writeFile(fixture.entry, bytes);
  }
});

test("p0.identity: exact config rejects mode/phase/capability changes, missing/extra fields and unsafe paths", async () => {
  const fixture = await createProductionFixture();
  await assert.doesNotReject(loadRuntimeConfig(fixture.configPath));
  const good = JSON.stringify(fixture.config);
  const variants = [
    { ...fixture.config, surprise: true },
    { ...fixture.config, public_broadcast_allowed: true },
    ...["test_only", "public"].map((mode) => ({
      ...fixture.config,
      profile: { ...fixture.config.profile, mode },
    })),
    ...[["P0", "P1"], ["P3"]].map((enabled_phases) => ({
      ...fixture.config,
      profile: { ...fixture.config.profile, enabled_phases },
    })),
    {
      ...fixture.config,
      profile: {
        ...fixture.config.profile,
        enabled_capabilities: [{ name: "real.output", version: "0.8.0" }],
      },
    },
    { ...fixture.config, limits: undefined },
    { ...fixture.config, limits: { ...fixture.config.limits, max_message_bytes: "65536" } },
  ];
  try {
    for (const value of variants) {
      await writeFile(fixture.configPath, JSON.stringify(value));
      await assert.rejects(loadRuntimeConfig(fixture.configPath));
    }
    await writeFile(fixture.configPath, good);
    await chmod(fixture.config.operator_credentials_path, 0o644);
    await assert.rejects(loadRuntimeConfig(fixture.configPath), /INSTALLATION_IDENTITY_DENIED/);
    await chmod(fixture.config.operator_credentials_path, 0o600);
    const alias = join(fixture.directory, "alias.json");
    await symlink(fixture.config.operator_credentials_path, alias);
    await writeFile(
      fixture.configPath,
      JSON.stringify({ ...fixture.config, operator_credentials_path: alias }),
    );
    await assert.rejects(loadRuntimeConfig(fixture.configPath), /INSTALLATION_IDENTITY_DENIED/);
    await unlink(alias);
    await writeFile(fixture.configPath, good);
    await writeFile(fixture.config.management_socket_path, "foreign-owner", { mode: 0o600 });
    await assert.rejects(loadRuntimeConfig(fixture.configPath), /INSTALLATION_IDENTITY_DENIED/);
    assert.equal(await readFile(fixture.config.management_socket_path, "utf8"), "foreign-owner");
    await unlink(fixture.config.management_socket_path);
  } finally {
    await writeFile(fixture.configPath, good);
    await chmod(fixture.config.operator_credentials_path, 0o600);
    await fixture.cleanup();
  }
});

test("p0.identity: child shutdown handles failed spawn and escalates a nonresponsive child", {
  timeout: 10000,
}, async () => {
  const failed = spawn(join(fixture.directory, "does-not-exist"), [], { stdio: "ignore" });
  await new Promise<void>((resolve) => failed.once("error", () => resolve()));
  assert.equal(failed.pid, undefined);
  await terminateChild(failed);
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); process.stdout.write("ready");',
    ],
    { env: safeChildEnvironment(), stdio: ["ignore", "pipe", "ignore"] },
  );
  assert.ok(child.stdout);
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.stdout?.once("data", () => resolve());
    });
    await terminateChild(child);
    assert.equal(child.signalCode, "SIGKILL");
    await terminateChild(child);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

test("p0.identity: real Supervisor/Host/CLI authenticate and query; effects remain closed", {
  timeout: 20000,
}, async () => {
  const fixture = await createProductionFixture();
  const supervisor = spawn(
    process.execPath,
    [join(repository, "apps/host/supervisor.ts"), "--config", fixture.configPath],
    { env: safeChildEnvironment(), stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  supervisor.stderr.on("data", (b: Buffer) => {
    stderr += b.toString();
  });
  let stdout = "";
  supervisor.stdout.on("data", (b: Buffer) => {
    stdout += b.toString();
  });
  try {
    await waitFor(`${fixture.config.management_socket_path}.host.identity.json`, supervisor);
    const authentication = await runCli(fixture.configPath, "authenticate");
    assert.equal(authentication.code, 0, authentication.stderr);
    assertValid("P0OperatorIdentity", JSON.parse(authentication.stdout).result);
    const query = await runCli(fixture.configPath, "query");
    assert.equal(query.code, 0, query.stderr);
    const snapshot: unknown = JSON.parse(query.stdout).result;
    assertValid("P0SessionSnapshot", snapshot);
    assert.equal(snapshot.supervision.state, "stopped");
    assert.equal(snapshot.grants.length, 0);
    if (snapshot.endpoint.fact) assert.equal(snapshot.endpoint.fact.completed_effect_count, 0);
    assert.equal(snapshot.persistence, "blocked");
    const identity = await readServiceIdentity(fixture.config.management_socket_path);
    const connection = await RpcConnection.connect(
      fixture.config.management_socket_path,
      identity,
      limits,
    );
    try {
      const bad = { ...fixture.credential, authentication_key_sha256: "0".repeat(64) };
      await assert.rejects(
        connection.operatorCall(
          "session.query",
          { session_id: connection.announcement.session_id },
          bad,
        ),
        /AUTHENTICATION_REQUIRED/,
      );
    } finally {
      connection.close();
    }
    const hostPath = `${fixture.config.management_socket_path}.host`;
    const host = await RpcConnection.connect(
      hostPath,
      await readServiceIdentity(hostPath),
      limits,
      undefined,
      undefined,
      identity,
    );
    try {
      await assert.rejects(
        host.operatorCall(
          "session.execute",
          {
            session_id: host.announcement.session_id,
            grant_id: "not-issued",
            endpoint_instance_id: snapshot.endpoint.source_instance_id,
            action: {
              target_ref: fixture.config.installation.allowed_targets[0],
              capability: "simulation.execute",
              units: 1,
              interval_ms: 10,
              cost_units: 0,
            },
          },
          fixture.credential,
        ),
        /PERSISTENCE_NOT_READY/,
      );
    } finally {
      host.close();
    }
    assert.equal(stdout, "");
    assert.equal(stderr.includes(fixture.credential.authentication_key_sha256), false);
  } finally {
    await stopProcess(supervisor);
  }
  await assert.rejects(
    readFile(`${fixture.config.management_socket_path}.identity.json`),
    /ENOENT/,
  );
  await assert.rejects(
    readFile(`${fixture.config.management_socket_path}.host.identity.json`),
    /ENOENT/,
  );
  await fixture.cleanup();
});

test("p0.identity: startup SIGTERM before and after identity publication cancels and cleans owned paths", {
  timeout: 20000,
}, async (t) => {
  const fixture = await createProductionFixture();
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(startSupervisor(fixture.configPath, aborted.signal), { name: "AbortError" });
  for (const suffix of ["", ".identity.json", ".host.identity.json"]) {
    const supervisor = spawn(
      process.execPath,
      [join(repository, "apps/host/supervisor.ts"), "--config", fixture.configPath],
      { env: safeChildEnvironment(), stdio: "ignore" },
    );
    t.diagnostic(
      `startup boundary=${suffix || "socket-before-identity"} supervisor_pid=${supervisor.pid}`,
    );
    try {
      await waitFor(`${fixture.config.management_socket_path}${suffix}`, supervisor);
    } finally {
      await stopProcess(supervisor);
    }
    assert.equal(supervisor.signalCode, null);
    assert.equal(supervisor.exitCode, 0);
    for (const path of [
      fixture.config.management_socket_path,
      `${fixture.config.management_socket_path}.identity.json`,
      `${fixture.config.management_socket_path}.host`,
      `${fixture.config.management_socket_path}.host.identity.json`,
    ]) {
      await assert.rejects(readFile(path), /ENOENT/);
    }
  }
  await fixture.cleanup();
});

test("p0.identity: actual management rejects old challenges and invalid target clock mappings", {
  timeout: 20000,
}, async (t) => {
  const fixture = await createProductionFixture();
  t.after(() => fixture.cleanup());
  const base = join(repository, "reports/p0/w5stf/identity-management");
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "run-"));
  const rawPath = join(directory, "stderr.ndjson");
  const file = await open(rawPath, "wx", 0o600);
  const supervisor = spawn(
    process.execPath,
    [join(repository, "apps/host/supervisor.ts"), "--config", fixture.configPath],
    { env: safeChildEnvironment(), stdio: ["ignore", "ignore", file.fd] },
  );
  await file.close();
  const record = (detail: object) =>
    appendFileSync(
      join(directory, "parent.ndjson"),
      `${JSON.stringify({ observer_pid: process.pid, monotonic_ms: performance.now(), ...detail })}\n`,
    );
  const kill = supervisor.kill.bind(supervisor);
  supervisor.kill = (signal = "SIGTERM") => {
    record({ kind: "kill", target_pid: supervisor.pid, signal });
    return kill(signal);
  };
  supervisor.on("exit", (code, signal) =>
    record({ kind: "exit", target_pid: supervisor.pid, code, signal }),
  );
  let overflow = false;
  const monitor = setInterval(() => {
    if (!overflow && statSync(rawPath).size > 16 * 1024 * 1024) {
      overflow = true;
      record({ kind: "capture_overflow" });
      supervisor.kill("SIGKILL");
    }
  }, 10);
  t.after(() => clearInterval(monitor));
  t.diagnostic(`actual management raw=${rawPath} supervisor_pid=${supervisor.pid}`);
  try {
    await waitFor(`${fixture.config.management_socket_path}.host.identity.json`, supervisor);
    const identity = await readServiceIdentity(fixture.config.management_socket_path);
    const first = await RpcConnection.connect(
      fixture.config.management_socket_path,
      identity,
      limits,
    );
    const original = operatorRequest(
      "session.query",
      { session_id: first.announcement.session_id, mapping: first.mapping },
      first.context("same-business-operation"),
      first.announcement,
      fixture.credential,
    );
    try {
      await first.request(original);
      await assert.rejects(first.request({ ...original, id: "replay" }), /AUTHENTICATION_REQUIRED/);
    } finally {
      first.close();
    }
    const old = await RpcConnection.connect(
      fixture.config.management_socket_path,
      identity,
      limits,
      original.params.context.caller_instance_id,
    );
    try {
      const wrongConnection = operatorRequest(
        "session.query",
        { session_id: old.announcement.session_id, mapping: old.mapping },
        old.context(),
        first.announcement,
        fixture.credential,
      );
      await assert.rejects(old.request(wrongConnection), /AUTHENTICATION_REQUIRED/);
    } finally {
      old.close();
    }
    for (const kind of ["instance", "error", "expired", "domain"] as const) {
      const client = await RpcConnection.connect(
        fixture.config.management_socket_path,
        identity,
        limits,
      );
      try {
        const mapping = structuredClone(client.mapping);
        const context = client.context();
        if (kind === "instance") mapping.target_instance_id = "old-instance";
        if (kind === "error") mapping.max_error_ms = limits.max_clock_error_ms + 1;
        if (kind === "expired") mapping.target_valid_until_ms = 0;
        if (kind === "domain") context.deadline.clock_domain = "foreign-domain";
        const request = operatorRequest(
          "session.query",
          { session_id: client.announcement.session_id, mapping },
          context,
          client.announcement,
          fixture.credential,
        );
        await assert.rejects(
          client.request(request),
          kind === "domain" ? /COMMAND_CLOCK_MISMATCH/ : /CLOCK_MAPPING_INVALID/,
        );
      } finally {
        client.close();
      }
    }
  } finally {
    try {
      await stopProcess(supervisor);
    } finally {
      clearInterval(monitor);
      record({ kind: "capture_end", bytes: statSync(rawPath).size, overflow });
    }
  }
  assert.equal(overflow, false, "finite raw capture must not overflow");
  assert.equal(supervisor.signalCode, null, "Supervisor must handle shutdown even during startup");
  await assert.rejects(
    readFile(`${fixture.config.management_socket_path}.identity.json`),
    /ENOENT/,
  );
  await assert.rejects(
    readFile(`${fixture.config.management_socket_path}.host.identity.json`),
    /ENOENT/,
  );
});

test("p0.identity: stdio fixture uses actual signatures and rejects peer impersonation and challenge reuse", {
  timeout: 15000,
}, async () => {
  const host = generateIdentity("host"),
    supervisor = generateIdentity("supervisor"),
    endpoint = generateIdentity("endpoint");
  const config: P0EndpointConfig = {
    session_id: "stdio-fixture-session",
    endpoint_instance_id: endpoint.public.instance_id,
    identity_key_id: endpoint.public.identity_key_id,
    identity_private_key_pkcs8: exportPrivate(endpoint),
    host_identity: { ...host.public, role: "host" },
    supervisor_identity: { ...supervisor.public, role: "supervisor" },
    safety_socket_path: fixture.config.safety_socket_path,
    limits,
    installation_id: fixture.config.installation.installation_id,
    entry_artifact: structuredClone(fixture.config.installation.entry),
    manifest: fixture.manifest,
    fault: { target: "endpoint", fault: "none", duration_ms: 0 },
  };
  for (const impersonate of [false, true]) {
    const clock = new MonotonicClock();
    const sent = clock.now();
    const child = spawn(process.execPath, [fixture.entry], {
      env: safeChildEnvironment(),
      stdio: ["pipe", "pipe", "ignore", "pipe"],
    });
    const fd = child.stdio[3];
    assert.ok(fd && "end" in fd);
    fd.end(JSON.stringify(config));
    assert.ok(child.stdout && child.stdin);
    const channel = new JsonChannel(
      child.stdout,
      child.stdin,
      limits.max_message_bytes,
      limits.max_pending_requests,
    );
    try {
      const client = await RpcConnection.fromChannel(
        channel,
        endpoint.public,
        limits,
        supervisor.public.instance_id,
        clock,
        sent,
        supervisor.public,
      );
      if (impersonate) {
        const attacker = generateIdentity("supervisor");
        attacker.public.instance_id = supervisor.public.instance_id;
        const request = peerRequest(
          { mapping: client.mapping },
          client.context(),
          client.announcement,
          attacker,
        );
        await assert.rejects(client.request(request), /AUTHENTICATION_REQUIRED/);
      } else {
        const request = peerRequest(
          { mapping: client.mapping },
          client.context(),
          client.announcement,
          supervisor,
        );
        await client.request(request);
        const sample = await client.peerCall("clock.sample", { source_sent_at: clock.point() });
        assertValid("P0ClockSampleResult", sample);
        await assert.rejects(
          client.request({ ...request, id: "peer-replay" }),
          /AUTHENTICATION_REQUIRED/,
        );
      }
      client.close();
    } finally {
      channel.close();
      await stopProcess(child);
    }
  }
});

test("p0.identity: end immediately rejects frames after malformed prefix in the same chunk", async () => {
  const input = new PassThrough(),
    output = new PassThrough();
  const channel = new JsonChannel(input, output, 1024, 4);
  const seen: unknown[] = [];
  channel.on("invalid", () => {
    seen.push("invalid");
    channel.send({ error: "invalid" });
    channel.end();
  });
  channel.on("message", (value) => seen.push(value));
  output.resume();
  input.write(Buffer.from('not-json\n{"must_not_run":true}\n'));
  assert.deepEqual(seen, ["invalid"]);
  assert.equal(channel.send({ late: true }), false);
  channel.close();
});

test("p0.identity: raw socket rejects malformed UTF8, duplicate keys, batch, unknown methods and oversized frames", {
  timeout: 15000,
}, async (t) => {
  const fixture = await createProductionFixture();
  t.after(() => fixture.cleanup());
  const supervisor = spawn(
    process.execPath,
    [join(repository, "apps/host/supervisor.ts"), "--config", fixture.configPath],
    { env: safeChildEnvironment(), stdio: "ignore" },
  );
  try {
    await waitFor(`${fixture.config.management_socket_path}.host.identity.json`, supervisor);
    const frames = [
      Buffer.from([0xff, 10]),
      Buffer.from('{"x":1,"x":2}\n'),
      Buffer.from("[]\n"),
      Buffer.from('{"jsonrpc":"2.0","id":"bad","method":"invented","params":{}}\n'),
    ];
    for (const frame of frames) {
      const socket = createConnection(fixture.config.management_socket_path);
      const channel = new JsonChannel(
        socket,
        socket,
        limits.max_message_bytes,
        limits.max_pending_requests,
      );
      try {
        const response = await new Promise<unknown>((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error(`RAW_TIMEOUT:${frame.toString("hex")}`)),
            3000,
          );
          channel.once("closed", () => {
            clearTimeout(timeout);
            reject(new Error(`RAW_CLOSED_BEFORE_RESPONSE:${frame.toString("hex")}`));
          });
          let announcement = false;
          channel.on("message", (value) => {
            if (!announcement) {
              announcement = true;
              socket.write(frame);
            } else {
              clearTimeout(timeout);
              resolve(value);
            }
          });
        });
        assertValid("RpcFailure", response);
      } finally {
        channel.close();
      }
    }
    const socket = createConnection(fixture.config.management_socket_path);
    const channel = new JsonChannel(
      socket,
      socket,
      limits.max_message_bytes,
      limits.max_pending_requests,
    );
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("OVERSIZE_NOT_CLOSED")), 3000);
      channel.once("message", () => socket.write(Buffer.alloc(limits.max_message_bytes + 1, 32)));
      channel.once("closed", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  } finally {
    await stopProcess(supervisor);
  }
});
