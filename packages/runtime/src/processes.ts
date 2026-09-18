import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertValid,
  type P0HostBootstrap,
  type P0RuntimeConfig,
  type P0SessionSnapshot,
  payloadDigest,
} from "../../contract-sdk/src/index.ts";
import { RpcConnection } from "./client.ts";
import { MonotonicClock } from "./clock.ts";
import { loadRuntimeConfig, validateBootstrap } from "./config.ts";
import {
  readControlled,
  readCredential,
  readServiceIdentity,
  requireRuntimeVersion,
} from "./files.ts";
import { exportPrivate, generateIdentity, identityFromKey } from "./identity.ts";
import { P0Service } from "./service.ts";

export function safeChildEnvironment(): NodeJS.ProcessEnv {
  return { PATH: dirname(process.execPath), LANG: "C.UTF-8" };
}

export function initialSnapshot(
  sessionId: string,
  supervisorId: string,
  hostId: string,
  endpointId: string,
  targets: P0RuntimeConfig["installation"]["allowed_targets"],
): P0SessionSnapshot {
  const snapshot: P0SessionSnapshot = {
    session_id: sessionId,
    supervision: {
      session_id: sessionId,
      supervision_epoch: 0,
      operator_id: null,
      human_lease_deadline: null,
      connection_healthy: false,
      grace_deadline: null,
      blocked_scopes: structuredClone(targets),
      active_grant_refs: [],
      incident_ref: null,
      state: "stopped",
      supervisor_instance_id: supervisorId,
      host_instance_id: hostId,
      source_revision: 0,
      record_status: "pending",
    },
    grants: [],
    admissions: [],
    stops: [],
    cleanup: [],
    isolation: [],
    endpoint: {
      source_instance_id: endpointId,
      received_at: { clock_domain: `unobserved-${sessionId}`, monotonic_ms: 0 },
      quality: "unknown",
      fact: null,
    },
    persistence: "blocked",
    outbox_pending: 0,
  };
  assertValid("P0SessionSnapshot", snapshot);
  return snapshot;
}

export async function terminateChild(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      clearTimeout(escalation);
      clearTimeout(deadline);
      child.off("exit", finish);
      resolve();
    };
    const escalation = setTimeout(() => child.kill("SIGKILL"), 1000);
    const deadline = setTimeout(() => {
      child.off("exit", finish);
      reject(new Error("CHILD_STOP_UNCONFIRMED"));
    }, 2000);
    child.once("exit", finish);
    child.kill("SIGTERM");
  });
}

export async function startSupervisor(
  configPath: string,
  signal?: AbortSignal,
): Promise<{ close: () => Promise<void>; host: ChildProcess }> {
  requireRuntimeVersion();
  signal?.throwIfAborted();
  const { config, installation, credential } = await loadRuntimeConfig(configPath);
  signal?.throwIfAborted();
  const supervisor = identityFromKey(
    "supervisor",
    randomUUID(),
    randomUUID(),
    (await readControlled(config.service_identity_key_path, 4096)).toString("utf8"),
  );
  const host = generateIdentity("host");
  const endpoint = generateIdentity("endpoint");
  const sessionId = randomUUID();
  const clock = new MonotonicClock();
  const snapshot = initialSnapshot(
    sessionId,
    supervisor.public.instance_id,
    host.public.instance_id,
    endpoint.public.instance_id,
    config.installation.allowed_targets,
  );
  snapshot.endpoint.received_at = clock.point();
  let lastHostHealth: number | null = null;
  let child: ChildProcess | undefined;
  const service = new P0Service({
    identity: supervisor,
    sessionId,
    clock,
    limits: config.limits,
    credential,
    peers: [host.public],
    snapshot: () => {
      const healthy =
        !!child &&
        child.exitCode === null &&
        child.signalCode === null &&
        lastHostHealth !== null &&
        clock.now() - lastHostHealth < config.limits.peer_health_timeout_ms;
      if (snapshot.supervision.connection_healthy !== healthy) {
        snapshot.supervision.connection_healthy = healthy;
        snapshot.supervision.source_revision++;
      }
      return structuredClone(snapshot);
    },
    onHealth: () => {
      lastHostHealth = clock.now();
    },
    faultInjectionEnabled: config.fault_injection_enabled,
  });
  const bootstrap: P0HostBootstrap = {
    session_id: sessionId,
    host_instance_id: host.public.instance_id,
    identity_key_id: host.public.identity_key_id,
    identity_private_key_pkcs8: exportPrivate(host),
    supervisor_identity: { ...supervisor.public, role: "supervisor" },
    supervisor_socket_path: config.management_socket_path,
    host_socket_path: `${config.management_socket_path}.host`,
    profile: config.profile,
    installation: config.installation,
    limits: config.limits,
    operator_credentials_path: config.operator_credentials_path,
    fault_injection_enabled: config.fault_injection_enabled,
    endpoint_config: {
      session_id: sessionId,
      endpoint_instance_id: endpoint.public.instance_id,
      identity_key_id: endpoint.public.identity_key_id,
      identity_private_key_pkcs8: exportPrivate(endpoint),
      host_identity: { ...host.public, role: "host" },
      supervisor_identity: { ...supervisor.public, role: "supervisor" },
      safety_socket_path: config.safety_socket_path,
      limits: config.limits,
      installation_id: config.installation.installation_id,
      manifest: installation.manifest,
      fault: { target: "endpoint", fault: "none", duration_ms: 0 },
    },
  };
  assertValid("P0HostBootstrap", bootstrap);
  try {
    signal?.throwIfAborted();
    await service.listen(config.management_socket_path);
    signal?.throwIfAborted();
    child = spawn(
      process.execPath,
      [fileURLToPath(new URL("../../../apps/host/host.ts", import.meta.url))],
      { env: safeChildEnvironment(), stdio: ["ignore", "ignore", "pipe", "pipe"] },
    );
    const hostChild = child;
    // Do not relay arbitrary child output: secrets and protocol payloads are not diagnostic text.
    hostChild.stderr?.resume();
    const descriptor = hostChild.stdio[3];
    if (!descriptor || !("end" in descriptor)) throw new Error("BOOTSTRAP_CHANNEL_MISSING");
    descriptor.on("error", () => {});
    descriptor.end(JSON.stringify(bootstrap));
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error("HOST_STARTUP_TIMEOUT")), 5000);
      const poll = setInterval(() => {
        if (lastHostHealth !== null) finish();
      }, 10);
      const exited = () => finish(new Error("HOST_STARTUP_FAILED"));
      const failed = () => finish(new Error("HOST_STARTUP_FAILED"));
      const aborted = () => finish(new Error("STARTUP_CANCELLED"));
      const finish = (error?: Error) => {
        clearTimeout(timeout);
        clearInterval(poll);
        hostChild.off("exit", exited);
        hostChild.off("error", failed);
        signal?.removeEventListener("abort", aborted);
        error ? reject(error) : resolve();
      };
      hostChild.once("exit", exited);
      hostChild.once("error", failed);
      signal?.addEventListener("abort", aborted, { once: true });
      if (signal?.aborted) aborted();
    });
    signal?.throwIfAborted();
    let closing = false;
    return {
      host: hostChild,
      close: async () => {
        if (closing) return;
        closing = true;
        try {
          await terminateChild(hostChild);
        } finally {
          await service.close();
        }
      },
    };
  } catch (error) {
    try {
      if (child) await terminateChild(child);
    } finally {
      await service.close();
    }
    throw error;
  }
}

export async function startHost(
  raw: unknown,
  signal?: AbortSignal,
): Promise<{ close: () => Promise<void> }> {
  requireRuntimeVersion();
  signal?.throwIfAborted();
  const bootstrap = await validateBootstrap(raw);
  signal?.throwIfAborted();
  const identity = identityFromKey(
    "host",
    bootstrap.host_instance_id,
    bootstrap.identity_key_id,
    bootstrap.identity_private_key_pkcs8,
  );
  const pinned = await readServiceIdentity(bootstrap.supervisor_socket_path);
  if (payloadDigest(pinned) !== payloadDigest(bootstrap.supervisor_identity))
    throw new Error("SUPERVISOR_IDENTITY_MISMATCH");
  const credential = await readCredential(bootstrap.operator_credentials_path);
  signal?.throwIfAborted();
  const clock = new MonotonicClock();
  const snapshot = initialSnapshot(
    bootstrap.session_id,
    pinned.instance_id,
    identity.public.instance_id,
    bootstrap.endpoint_config.endpoint_instance_id,
    bootstrap.installation.allowed_targets,
  );
  snapshot.endpoint.received_at = clock.point();
  const service = new P0Service({
    identity,
    sessionId: bootstrap.session_id,
    clock,
    limits: bootstrap.limits,
    credential,
    peers: [pinned],
    snapshot: () => structuredClone(snapshot),
    faultInjectionEnabled: bootstrap.fault_injection_enabled,
  });
  let closed = false;
  let active: RpcConnection | undefined;
  let busy = false;
  const health = async (): Promise<void> => {
    if (closed || busy) return;
    busy = true;
    try {
      active = await RpcConnection.connect(
        bootstrap.supervisor_socket_path,
        pinned,
        bootstrap.limits,
        identity.public.instance_id,
        clock,
      );
      if (closed) return;
      await active.authenticatePeer(identity);
      await active.peerCall("supervisor.health", {
        session_id: bootstrap.session_id,
        peer_instance_id: identity.public.instance_id,
        peer_role: "host",
      });
    } finally {
      active?.close();
      active = undefined;
      busy = false;
    }
  };
  try {
    signal?.throwIfAborted();
    await service.listen(bootstrap.host_socket_path);
    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const aborted = () => reject(new Error("STARTUP_CANCELLED"));
      signal?.addEventListener("abort", aborted, { once: true });
      void health()
        .then(resolve, reject)
        .finally(() => signal?.removeEventListener("abort", aborted));
      if (signal?.aborted) aborted();
    });
    signal?.throwIfAborted();
  } catch (error) {
    closed = true;
    active?.close();
    await service.close();
    throw error;
  }
  const interval = setInterval(
    () => {
      void health().catch(() => {
        snapshot.supervision.connection_healthy = false;
      });
    },
    Math.max(10, Math.floor(bootstrap.limits.peer_health_timeout_ms / 3)),
  );
  return {
    close: async () => {
      if (closed) return;
      closed = true;
      clearInterval(interval);
      active?.close();
      await service.close();
    },
  };
}
