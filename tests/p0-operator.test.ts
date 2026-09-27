import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { assertValid, type RpcRequest } from "../packages/contract-sdk/src/index.ts";
import { MonotonicClock } from "../packages/runtime/src/clock.ts";
import {
  announce,
  announcementEvent,
  ConnectionAuthentication,
  generateIdentity,
} from "../packages/runtime/src/identity.ts";
import {
  parseOperatorCommand,
  prepareOperatorCommand,
} from "../packages/runtime/src/operator-command.ts";
import { safeChildEnvironment } from "../packages/runtime/src/processes.ts";
import { JsonChannel } from "../packages/runtime/src/transport.ts";
import { connectionFixture, credential } from "./p0-client.helpers.ts";
import { createProductionFixture } from "./p0-endpoint.helpers.ts";
import { repository, stopProcess, waitFor } from "./p0-identity.helpers.ts";
import { capture, protocolRecords } from "./p0-observation.helpers.ts";
import { actionFlags, operator } from "./p0-operator.helpers.ts";

test("p0.operator module: nine fixed actions reject unknown, duplicate, inapplicable and incomplete flags", () => {
  for (const action of ["authenticate", "query", "host-query", ...Object.keys(actionFlags)]) {
    const extra = actionFlags[action as keyof typeof actionFlags] ?? [];
    const args = ["--config", "/controlled/config", "--command", action, ...extra];
    assert.equal(parseOperatorCommand(args).action, action);
    for (const bad of [
      ["--role", "test_operator"],
      ["--payload", "{}"],
      ["--proof", "{}"],
      ["--skip", "yes"],
      ["--__proto__", "x"],
      ["--command", action],
      ["--config", "other"],
      ["position"],
      ["--timeout-ms"],
    ])
      assert.throws(() => parseOperatorCommand([...args, ...bad]));
  }
  for (const action of ["authorize", "renew", "revoke", "stop", "execute", "fault"])
    assert.throws(() => parseOperatorCommand(["--config", "c", "--command", action]));
  const base = ["--config", "c", "--command", "query"];
  for (const bad of ["0", "-1", "+1", "1.0", "1e2", "12ms", "01", " 1", "9007199254740992"])
    assert.throws(() => parseOperatorCommand([...base, "--timeout-ms", bad]));
  assert.throws(() => parseOperatorCommand([...base, "--target", "SimulationCounter", "counter"]));
  assert.throws(() =>
    parseOperatorCommand([
      "--config",
      "c",
      "--command",
      "authorize",
      ...actionFlags.authorize,
      "--target",
      "SimulationCounter",
      "fixture-counter",
    ]),
  );
  assert.throws(() =>
    parseOperatorCommand([
      "--config",
      "c",
      "--command",
      "authorize",
      ...actionFlags.authorize,
      "--capability",
      "simulation.execute",
    ]),
  );
});

test("p0.operator module: actions are closed requests with exact budgets, grant binding and registered fault pairs", async (t) => {
  const fixture = await createProductionFixture();
  t.after(fixture.cleanup);
  const f = await connectionFixture();
  t.after(f.cleanup);
  for (const action of ["authorize", "renew", "revoke", "stop", "fault"] as const) {
    const command = parseOperatorCommand([
      "--config",
      "c",
      "--command",
      action,
      ...actionFlags[action],
    ]);
    const p = prepareOperatorCommand(command, fixture.config, f.connection, credential);
    assertValid("RpcRequest", p.request);
    assert.equal(p.request.params.context.operation_id, command.operation);
    if (p.request.method === "session.authorize") {
      assert.equal(p.request.params.input.mode, "simulation");
      assert.equal(p.request.params.input.public_broadcast_allowed, false);
      assert.equal(p.request.params.input.supervision_mode, "supervised");
    }
    if (p.request.method === "session.revoke")
      assert.equal(p.request.params.context.grant_ref, "unissued-grant");
    if (p.request.method === "session.renew")
      assert.equal(p.request.params.input.supervision_epoch, 0);
  }
  const changed = (args: string[], key: string, value: string) => {
    const result = [...args];
    result[result.indexOf(key) + 1] = value;
    return result;
  };
  const authorize = ["--config", "c", "--command", "authorize", ...actionFlags.authorize];
  for (const [key, value] of [
    ["--effect-limit", "100001"],
    ["--queue-limit", "1025"],
    ["--cost-limit", "100001"],
    ["--human-lease-ms", "3600001"],
    ["--grant-ms", "600"],
    ["--endpoint-instance", "x".repeat(161)],
  ]) {
    assert.ok(key && value);
    assert.throws(() =>
      prepareOperatorCommand(
        parseOperatorCommand(changed(authorize, key, value)),
        fixture.config,
        f.connection,
        credential,
      ),
    );
  }
  const foreign = [...authorize];
  foreign[foreign.indexOf("--target") + 2] = "outside-installation";
  assert.throws(() =>
    prepareOperatorCommand(parseOperatorCommand(foreign), fixture.config, f.connection, credential),
  );
  const fault = ["--config", "c", "--command", "fault", ...actionFlags.fault];
  assert.throws(() =>
    prepareOperatorCommand(
      parseOperatorCommand(changed(fault, "--fault-target", "persistence")),
      fixture.config,
      f.connection,
      credential,
    ),
  );
  const config = structuredClone(fixture.config);
  const capability = config.installation.allowed_capabilities[0];
  assert.ok(capability);
  capability.version = "9.9.9";
  assert.throws(() =>
    prepareOperatorCommand(parseOperatorCommand(authorize), config, f.connection, credential),
  );
});

test("p0.operator: real CLI routes all nine actions through actual authentication and reports each real failure", {
  timeout: 30000,
}, async (t) => {
  const fixture = await createProductionFixture();
  t.after(fixture.cleanup);
  fixture.config.fault_injection_enabled = true;
  await writeFile(fixture.configPath, JSON.stringify(fixture.config));
  const supervisor = capture(
    [join(repository, "apps/host/supervisor.ts"), "--config", fixture.configPath],
    "supervisor",
    safeChildEnvironment(),
    join(repository, "reports/p0/w5sl/cli-raw", `supervisor-${randomUUID()}`),
  );
  t.after(async () => {
    await stopProcess(supervisor.child);
    await supervisor.closed;
    await supervisor.save();
  });
  await waitFor(`${fixture.config.management_socket_path}.host.identity.json`, supervisor.child);
  const methods = {
    authenticate: "operator.authenticate",
    query: "session.query",
    "host-query": "host.query",
    authorize: "session.authorize",
    renew: "session.renew",
    revoke: "session.revoke",
    stop: "session.stop",
    execute: "session.execute",
    fault: "fault.configure",
  };
  for (const [action, method] of Object.entries(methods)) {
    const result = await operator(
      fixture.configPath,
      action,
      actionFlags[action as keyof typeof actionFlags] ?? [],
    );
    assert.equal(result.signal, null, result.stderr);
    const response: unknown = JSON.parse(result.stdout);
    const raw = protocolRecords(result.stderr);
    const announced = raw.find((r) => r.detail.kind === "announcement_received");
    assert.ok(announced?.detail.kind === "announcement_received");
    assert.equal(
      announced.detail.fixed_peer.role,
      ["host-query", "execute"].includes(action) ? "host" : "supervisor",
    );
    const requests = raw.filter((r) => r.detail.kind === "request_queued");
    assert.equal(requests.length, 1, "no implicit preflight query or authentication probe");
    const sent = requests[0];
    assert.ok(sent?.detail.kind === "request_queued");
    assert.equal(sent.detail.request.method, method);
    const received = raw.find((r) => r.detail.kind === "response_received");
    assert.ok(received?.detail.kind === "response_received");
    assert.equal(result.stderr.includes(fixture.credential.authentication_key_sha256), false);
    if (["authenticate", "query", "host-query"].includes(action)) {
      assert.equal(result.code, 0, result.stdout);
      assert.ok(response && typeof response === "object" && "result" in response);
    } else {
      assert.equal(result.code, 1);
      assertValid("RpcFailure", response);
      assert.equal(response.id, sent.detail.request.id);
      assert.equal(
        response.error.data?.reason_code,
        ["authorize", "execute"].includes(action)
          ? "PERSISTENCE_NOT_READY"
          : action === "fault"
            ? "SERVICE_NOT_READY"
            : "CONTROLLER_NOT_READY",
      );
    }
  }
  const wrong = join(fixture.directory, "wrong-credential.json");
  await writeFile(
    wrong,
    JSON.stringify({ ...fixture.credential, authentication_key_sha256: "0".repeat(64) }),
    { mode: 0o600 },
  );
  const wrongConfig = join(fixture.directory, "wrong-config.json");
  await writeFile(
    wrongConfig,
    JSON.stringify({ ...fixture.config, operator_credentials_path: wrong }),
    { mode: 0o600 },
  );
  const denied = await operator(wrongConfig, "query");
  assert.equal(denied.code, 1);
  assert.equal(JSON.parse(denied.stdout).error.data.reason_code, "AUTHENTICATION_REQUIRED");
  for (const flags of [
    ["--operator-id", "spoof"],
    ["--timeout-ms", "1e3"],
    ["--operation-id", "a", "--operation-id", "b"],
  ]) {
    const rejected = await operator(fixture.configPath, "query", flags);
    assert.equal(rejected.code, 1);
    assert.equal(rejected.stdout, "");
    assert.equal(
      protocolRecords(rejected.stderr).some((r) => r.detail.kind === "request_queued"),
      false,
    );
  }
});

test("p0.operator: actual UDS close after authentication produces no invented or previous RPC result", {
  timeout: 10000,
}, async (t) => {
  const fixture = await createProductionFixture();
  t.after(fixture.cleanup);
  const identity = generateIdentity("supervisor"),
    clock = new MonotonicClock();
  const channels: JsonChannel[] = [];
  let authenticated = false;
  const server = createServer((socket) => {
    const channel = new JsonChannel(socket, socket, fixture.config.limits.max_message_bytes, 2);
    channels.push(channel);
    const a = announce(
      identity,
      "closed-session",
      clock,
      fixture.config.limits.clock_mapping_ttl_ms,
      identity.public,
      0,
    );
    const auth = new ConnectionAuthentication(a);
    channel.on("message", (r: RpcRequest) => {
      auth.operator(r, fixture.credential, clock.now());
      authenticated = true;
      channel.close();
    });
    channel.send(announcementEvent(a));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(fixture.config.management_socket_path, resolve);
  });
  t.after(async () => {
    for (const c of channels) c.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await chmod(fixture.config.management_socket_path, 0o600);
  await writeFile(
    `${fixture.config.management_socket_path}.identity.json`,
    JSON.stringify(identity.public),
    { mode: 0o600 },
  );
  const result = await operator(fixture.configPath, "authenticate");
  assert.equal(authenticated, true);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.equal(
    protocolRecords(result.stderr).some((r) => r.detail.kind === "response_received"),
    false,
  );
});
