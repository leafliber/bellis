import type { ChildProcess } from "node:child_process";
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
import { loadRuntimeConfig, validateBootstrap } from "./config.ts";
import { endpointIdentity, launchEndpoint, queryEndpoint } from "./endpoint-client.ts";
import {
  readControlled,
  readCredential,
  readServiceIdentity,
  requireRuntimeVersion,
} from "./files.ts";
import { exportPrivate, generateIdentity, identityFromKey } from "./identity.ts";
import { observationError, StartupObservation } from "./observation.ts";
import { observedSpawn } from "./process-observation.ts";
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

export async function terminateChild(child: ChildProcess, graceMs = 1000): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      clearTimeout(escalation);
      clearTimeout(deadline);
      child.off("exit", finish);
      resolve();
    };
    const escalation = setTimeout(() => child.kill("SIGKILL"), graceMs);
    const deadline = setTimeout(() => {
      child.off("exit", finish);
      reject(new Error("CHILD_STOP_UNCONFIRMED"));
    }, graceMs + 1000);
    child.once("exit", finish);
    child.kill("SIGTERM");
  });
}

export async function startSupervisor(
  configPath: string,
  signal?: AbortSignal,
): Promise<{ close: () => Promise<void>; host: ChildProcess }> {
  const startup = new StartupObservation("supervisor");
  try {
    return await supervisorRuntime(configPath, startup, signal);
  } catch (error) {
    await startup.failed(error);
    throw error;
  }
}

async function supervisorRuntime(
  configPath: string,
  startup: StartupObservation,
  signal?: AbortSignal,
): Promise<{ close: () => Promise<void>; host: ChildProcess }> {
  requireRuntimeVersion();
  signal?.throwIfAborted();
  const { config, installation, credential } = await loadRuntimeConfig(configPath, (stage) => {
    startup.stage = stage;
  });
  signal?.throwIfAborted();
  startup.stage = "configuration";
  const supervisor = identityFromKey(
    "supervisor",
    randomUUID(),
    randomUUID(),
    (await readControlled(config.service_identity_key_path, 4096)).toString("utf8"),
  );
  const host = generateIdentity("host");
  const endpoint = generateIdentity("endpoint");
  const sessionId = randomUUID();
  const clock = startup.clock;
  const observation = startup.bind(supervisor.public.instance_id, config.limits);
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
  let endpointInterval: ReturnType<typeof setInterval> | undefined;
  let endpointConnection: RpcConnection | undefined;
  let endpointBusy = false;
  let closed = false;
  const service = new P0Service({
    identity: supervisor,
    authority: supervisor.public,
    currentAuthorityEpoch: () => 0,
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
    observation,
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
      entry_artifact: structuredClone(config.installation.entry),
      manifest: installation.manifest,
      fault: { target: "endpoint", fault: "none", duration_ms: 0 },
    },
  };
  assertValid("P0HostBootstrap", bootstrap);
  const pollEndpoint = async (): Promise<void> => {
    if (closed || endpointBusy) return;
    endpointBusy = true;
    try {
      endpointConnection = await RpcConnection.connect(
        config.safety_socket_path,
        endpointIdentity(bootstrap.endpoint_config),
        config.limits,
        supervisor.public.instance_id,
        clock,
        supervisor.public,
        undefined,
        observation,
      );
      if (closed) return;
      const project = (fact: NonNullable<P0SessionSnapshot["endpoint"]["fact"]>) => {
        const previous = snapshot.endpoint.fact;
        if (previous && fact.source_revision < previous.source_revision) return;
        if (
          previous &&
          fact.source_revision === previous.source_revision &&
          payloadDigest(previous) !== payloadDigest(fact)
        )
          throw new Error("ENDPOINT_REVISION_CONFLICT");
        snapshot.endpoint = {
          source_instance_id: fact.endpoint_instance_id,
          received_at: clock.point(),
          quality: "fresh",
          fact,
        };
      };
      endpointConnection.onEndpointFact(project, () => 0);
      await endpointConnection.authenticatePeer(supervisor);
      project(await queryEndpoint(endpointConnection, bootstrap.endpoint_config));
    } catch (error) {
      endpointConnection?.observation?.failure("dispatch", observationError(error));
      snapshot.endpoint.quality = snapshot.endpoint.fact ? "stale" : "unknown";
    } finally {
      endpointConnection?.close();
      endpointConnection = undefined;
      endpointBusy = false;
    }
  };
  const stopEndpoint = async (): Promise<void> => {
    endpointConnection?.close();
    let connection: RpcConnection | undefined;
    const deadline = new AbortController();
    const timer = setTimeout(() => {
      deadline.abort();
      connection?.close();
    }, config.limits.stop_timeout_ms);
    try {
      connection = await RpcConnection.connect(
        config.safety_socket_path,
        endpointIdentity(bootstrap.endpoint_config),
        config.limits,
        supervisor.public.instance_id,
        clock,
        supervisor.public,
        deadline.signal,
        observation,
      );
      deadline.signal.throwIfAborted();
      connection.onEndpointFact(
        () => {},
        () => 0,
      );
      await connection.authenticatePeer(supervisor);
      await connection.peerCall("controller.dispose", { instance_id: endpoint.public.instance_id });
    } catch (error) {
      connection?.observation?.failure("dispatch", observationError(error));
      snapshot.endpoint.quality = "unknown";
    } finally {
      clearTimeout(timer);
      connection?.close();
    }
  };
  try {
    signal?.throwIfAborted();
    startup.stage = "listen";
    await service.listen(config.management_socket_path);
    signal?.throwIfAborted();
    startup.stage = "launch";
    child = observedSpawn(
      process.execPath,
      [fileURLToPath(new URL("../../../apps/host/host.ts", import.meta.url))],
      { env: safeChildEnvironment(), stdio: ["ignore", "ignore", "inherit", "pipe"] },
      observation,
      "host",
      host.public.instance_id,
    );
    const hostChild = child;
    // Descriptor inheritance preserves endpoint observations even while Host is blocked or gone.
    const descriptor = hostChild.stdio[3];
    if (!descriptor || !("end" in descriptor)) throw new Error("BOOTSTRAP_CHANNEL_MISSING");
    descriptor.on("error", () => {});
    descriptor.end(JSON.stringify(bootstrap));
    endpointInterval = setInterval(
      () => {
        void pollEndpoint();
      },
      Math.max(10, Math.floor(config.limits.peer_health_timeout_ms / 3)),
    );
    void pollEndpoint();
    startup.stage = "connect";
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error("HOST_STARTUP_TIMEOUT")), 5000);
      const poll = setInterval(() => {
        if (
          lastHostHealth !== null &&
          snapshot.endpoint.quality === "fresh" &&
          snapshot.endpoint.fact?.host_connection_deadline
        )
          finish();
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
        closed = true;
        clearInterval(endpointInterval);
        try {
          const results = await Promise.allSettled([
            stopEndpoint(),
            terminateChild(hostChild, config.limits.stop_timeout_ms),
            service.close(),
          ]);
          const failed = results.find((result) => result.status === "rejected");
          if (failed?.status === "rejected") throw failed.reason;
        } finally {
          await service.close();
          await observation.finish();
        }
      },
    };
  } catch (error) {
    closed = true;
    clearInterval(endpointInterval);
    endpointConnection?.close();
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
  const startup = new StartupObservation("host");
  try {
    return await hostRuntime(raw, startup, signal);
  } catch (error) {
    await startup.failed(error);
    throw error;
  }
}

async function hostRuntime(
  raw: unknown,
  startup: StartupObservation,
  signal?: AbortSignal,
): Promise<{ close: () => Promise<void> }> {
  requireRuntimeVersion();
  signal?.throwIfAborted();
  startup.stage = "bootstrap";
  assertValid("P0HostBootstrap", raw);
  const observation = startup.bind(raw.host_instance_id, raw.limits);
  const bootstrap = await validateBootstrap(raw, (stage) => {
    startup.stage = stage;
  });
  signal?.throwIfAborted();
  const identity = identityFromKey(
    "host",
    bootstrap.host_instance_id,
    bootstrap.identity_key_id,
    bootstrap.identity_private_key_pkcs8,
  );
  const clock = startup.clock;
  startup.stage = "bootstrap";
  const pinned = await readServiceIdentity(bootstrap.supervisor_socket_path);
  if (payloadDigest(pinned) !== payloadDigest(bootstrap.supervisor_identity))
    throw new Error("SUPERVISOR_IDENTITY_MISMATCH");
  startup.stage = "configuration";
  const credential = await readCredential(bootstrap.operator_credentials_path);
  signal?.throwIfAborted();
  const snapshot = initialSnapshot(
    bootstrap.session_id,
    pinned.instance_id,
    identity.public.instance_id,
    bootstrap.endpoint_config.endpoint_instance_id,
    bootstrap.installation.allowed_targets,
  );
  snapshot.endpoint.received_at = clock.point();
  let endpoint: Awaited<ReturnType<typeof launchEndpoint>> | undefined;
  const service = new P0Service({
    identity,
    authority: pinned,
    currentAuthorityEpoch: () => 0,
    sessionId: bootstrap.session_id,
    clock,
    limits: bootstrap.limits,
    credential,
    peers: [pinned],
    snapshot: () => structuredClone(snapshot),
    faultInjectionEnabled: bootstrap.fault_injection_enabled,
    observation,
    hostEndpoint: {
      instanceId: bootstrap.endpoint_config.endpoint_instance_id,
      projection: () => {
        const projection = structuredClone(snapshot.endpoint);
        if (!projection.fact) projection.quality = "unknown";
        else if (
          !endpoint ||
          endpoint.connection.channel.closed ||
          clock.now() - projection.received_at.monotonic_ms >=
            bootstrap.limits.peer_health_timeout_ms ||
          clock.now() >= endpoint.connection.mapping.source_valid_until_ms
        )
          projection.quality = "stale";
        return projection;
      },
    },
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
        pinned,
        undefined,
        observation,
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
    startup.stage = "listen";
    await service.listen(bootstrap.host_socket_path);
    signal?.throwIfAborted();
    startup.stage = "launch";
    endpoint = await launchEndpoint(
      bootstrap.endpoint_config,
      identity,
      clock,
      (fact) => {
        const previous = snapshot.endpoint.fact;
        if (previous && fact.source_revision < previous.source_revision) return;
        if (
          previous &&
          fact.source_revision === previous.source_revision &&
          payloadDigest(previous) !== payloadDigest(fact)
        )
          throw new Error("ENDPOINT_REVISION_CONFLICT");
        snapshot.endpoint = {
          source_instance_id: fact.endpoint_instance_id,
          received_at: clock.point(),
          quality: "fresh",
          fact,
        };
      },
      signal,
      observation,
      (stage) => {
        startup.stage = stage;
      },
    );
    endpoint.connection.channel.on("closed", () => {
      snapshot.endpoint.quality = "stale";
    });
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
    endpoint?.connection.close();
    if (endpoint) await terminateChild(endpoint.child);
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
      endpoint?.connection.close();
      // Normal Host shutdown ends business traffic; Supervisor retains its independent cleanup path.
      endpoint?.child.unref();
      await service.close();
      await observation.finish();
    },
  };
}
