import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { RpcConnection } from "../packages/runtime/src/client.ts";
import { MonotonicClock } from "../packages/runtime/src/clock.ts";
import { validateBootstrap } from "../packages/runtime/src/config.ts";
import {
  announce,
  announcementEvent,
  exportPrivate,
  generateIdentity,
  operatorRequest,
  verifyAnnouncement,
} from "../packages/runtime/src/identity.ts";
import { P0Service } from "../packages/runtime/src/service.ts";
import { createFixture, limits } from "./p0-identity.helpers.ts";

let fixture: Awaited<ReturnType<typeof createFixture>>;
before(async () => {
  fixture = await createFixture();
});
after(async () => {
  await fixture?.cleanup();
});

test("p0.authority: signed owner and epoch are distinct from the pinned announcement publisher", () => {
  const supervisor = generateIdentity("supervisor"),
    host = generateIdentity("host"),
    other = generateIdentity("supervisor");
  const a = announce(
    host,
    "controlled-session",
    new MonotonicClock(),
    limits.clock_mapping_ttl_ms,
    supervisor.public,
    7,
  );
  const event = announcementEvent(a);
  assert.equal(event.params.authority_id, "host");
  assert.equal(event.params.source_instance, host.public.instance_id);
  assert.equal(a.authority_id, "supervisor");
  assert.equal(a.authority_instance_id, supervisor.public.instance_id);
  assert.equal(event.params.authority_epoch, 7);
  assert.deepEqual(verifyAnnouncement(event, host.public, supervisor.public), a);
  assert.throws(() => verifyAnnouncement(event, host.public), /AUTHENTICATION_REQUIRED/);
  assert.throws(
    () => verifyAnnouncement(event, host.public, other.public),
    /AUTHENTICATION_REQUIRED/,
  );
  const outer = structuredClone(event);
  outer.params.authority_epoch = 8;
  assert.throws(
    () => verifyAnnouncement(outer, host.public, supervisor.public),
    /AUTHENTICATION_REQUIRED/,
  );
  const payload = {
    ...event,
    params: { ...event.params, authority_epoch: 8, payload: { ...a, authority_epoch: 8 } },
  };
  assert.throws(
    () => verifyAnnouncement(payload, host.public, supervisor.public),
    /AUTHENTICATION_REQUIRED/,
  );
  const wrongOwner = announcementEvent(
    announce(
      host,
      "controlled-session",
      new MonotonicClock(),
      limits.clock_mapping_ttl_ms,
      other.public,
      7,
    ),
  );
  assert.throws(
    () => verifyAnnouncement(wrongOwner, host.public, supervisor.public),
    /AUTHENTICATION_REQUIRED/,
  );
  assert.throws(
    () =>
      announce(
        supervisor,
        "controlled-session",
        new MonotonicClock(),
        limits.clock_mapping_ttl_ms,
        other.public,
        7,
      ),
    /AUTHENTICATION_REQUIRED/,
  );
  assert.throws(
    () =>
      announce(
        host,
        "controlled-session",
        new MonotonicClock(),
        limits.clock_mapping_ttl_ms,
        host.public,
        7,
      ),
    /AUTHENTICATION_REQUIRED/,
  );
});

test("p0.authority: actual socket uses signed epoch and refuses an announcement made before a trusted epoch change", {
  timeout: 10000,
}, async () => {
  // Controlled module state only: no network command mutates epoch or grants.
  let epoch = 7;
  const supervisor = generateIdentity("supervisor");
  const socket = join(fixture.directory, "authority.sock");
  const service = new P0Service({
    identity: supervisor,
    authority: supervisor.public,
    currentAuthorityEpoch: () => epoch,
    sessionId: "controlled-session",
    clock: new MonotonicClock(),
    limits,
    credential: fixture.credential,
    peers: [],
    snapshot: () => {
      throw new Error("NO_SUT_SNAPSHOT");
    },
    faultInjectionEnabled: false,
  });
  await service.listen(socket);
  const connect = () => RpcConnection.connect(socket, supervisor.public, limits);
  try {
    const good = await connect();
    try {
      assert.equal(good.context().authority_epoch, 7);
      await good.operatorCall("operator.authenticate", {}, fixture.credential);
    } finally {
      good.close();
    }
    const stale = await connect();
    const oldRequest = operatorRequest(
      "operator.authenticate",
      { mapping: stale.mapping },
      stale.context(),
      stale.announcement,
      fixture.credential,
    );
    epoch = 8;
    try {
      await assert.rejects(stale.request(oldRequest), /SCOPED_EPOCH_CONFLICT/);
      const promoted = operatorRequest(
        "operator.authenticate",
        { mapping: stale.mapping },
        { ...stale.context(), authority_epoch: 8 },
        stale.announcement,
        fixture.credential,
      );
      await assert.rejects(stale.request(promoted), /SCOPED_EPOCH_CONFLICT/);
    } finally {
      stale.close();
    }
    const current = await connect();
    try {
      assert.equal(current.context().authority_epoch, 8);
      const external = operatorRequest(
        "operator.authenticate",
        { mapping: current.mapping },
        { ...current.context(), authority_epoch: 999 },
        current.announcement,
        fixture.credential,
      );
      await assert.rejects(current.request(external), /SCOPED_EPOCH_CONFLICT/);
      assert.equal(epoch, 8);
      await current.operatorCall("operator.authenticate", {}, fixture.credential);
    } finally {
      current.close();
    }
  } finally {
    await service.close();
  }
});

test("p0.authority: Host bootstrap pins endpoint entry bytes to the actual trusted installation", async () => {
  const host = generateIdentity("host"),
    supervisor = generateIdentity("supervisor"),
    endpoint = generateIdentity("endpoint");
  const bootstrap = {
    session_id: "controlled-session",
    host_instance_id: host.public.instance_id,
    identity_key_id: host.public.identity_key_id,
    identity_private_key_pkcs8: exportPrivate(host),
    supervisor_identity: supervisor.public,
    supervisor_socket_path: fixture.config.management_socket_path,
    host_socket_path: `${fixture.config.management_socket_path}.host`,
    profile: fixture.config.profile,
    installation: fixture.config.installation,
    limits,
    operator_credentials_path: fixture.config.operator_credentials_path,
    fault_injection_enabled: false,
    endpoint_config: {
      session_id: "controlled-session",
      endpoint_instance_id: endpoint.public.instance_id,
      identity_key_id: endpoint.public.identity_key_id,
      identity_private_key_pkcs8: exportPrivate(endpoint),
      host_identity: host.public,
      supervisor_identity: supervisor.public,
      safety_socket_path: fixture.config.safety_socket_path,
      limits,
      installation_id: fixture.config.installation.installation_id,
      manifest: fixture.manifest,
      entry_artifact: structuredClone(fixture.config.installation.entry),
      fault: { target: "endpoint", fault: "none", duration_ms: 0 },
    },
  };
  await assert.doesNotReject(validateBootstrap(bootstrap));
  for (const entry_artifact of [
    { ...bootstrap.endpoint_config.entry_artifact, sha256: "0".repeat(64) },
    {
      ...bootstrap.endpoint_config.entry_artifact,
      path: join(fixture.directory, "different-entry.mjs"),
    },
  ]) {
    await assert.rejects(
      validateBootstrap({
        ...bootstrap,
        endpoint_config: { ...bootstrap.endpoint_config, entry_artifact },
      }),
      /INSTALLATION_IDENTITY_DENIED/,
    );
  }
});
