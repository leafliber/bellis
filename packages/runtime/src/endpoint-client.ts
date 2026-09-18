import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  assertValid,
  type P0EndpointConfig,
  type P0EndpointSnapshot,
  type P0PeerIdentity,
  payloadDigest,
  schemaDigest,
} from "../../contract-sdk/src/index.ts";
import { RpcConnection } from "./client.ts";
import type { MonotonicClock } from "./clock.ts";
import { type Identity, identityFromKey } from "./identity.ts";
import { safeChildEnvironment, terminateChild } from "./processes.ts";
import { JsonChannel } from "./transport.ts";

export function endpointIdentity(config: P0EndpointConfig): P0PeerIdentity {
  return identityFromKey(
    "endpoint",
    config.endpoint_instance_id,
    config.identity_key_id,
    config.identity_private_key_pkcs8,
  ).public;
}

export function validateEndpointFact(
  fact: unknown,
  config: P0EndpointConfig,
  connection: RpcConnection,
): P0EndpointSnapshot {
  assertValid("P0EndpointSnapshot", fact);
  if (
    fact.endpoint_instance_id !== config.endpoint_instance_id ||
    fact.session_id !== config.session_id ||
    fact.supervisor_instance_id !== config.supervisor_identity.instance_id ||
    fact.observed_at.clock_domain !== connection.mapping.target_clock_domain
  )
    throw new Error("ENDPOINT_FACT_IDENTITY_MISMATCH");
  return structuredClone(fact);
}

export async function queryEndpoint(
  connection: RpcConnection,
  config: P0EndpointConfig,
): Promise<P0EndpointSnapshot> {
  return validateEndpointFact(
    await connection.peerCall("simulation.query", {
      session_id: config.session_id,
      endpoint_instance_id: config.endpoint_instance_id,
    }),
    config,
    connection,
  );
}

export async function launchEndpoint(
  config: P0EndpointConfig,
  host: Identity,
  clock: MonotonicClock,
  onFact: (fact: P0EndpointSnapshot) => void,
  signal?: AbortSignal,
): Promise<{ child: ChildProcess; connection: RpcConnection }> {
  signal?.throwIfAborted();
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("../../../apps/host/endpoint-launcher.mjs", import.meta.url))],
    { env: safeChildEnvironment(), stdio: ["pipe", "pipe", "inherit", "pipe"] },
  );
  let connection: RpcConnection | undefined;
  let channel: JsonChannel | undefined;
  const aborted = () => {
    channel?.close();
    connection?.close();
    child.stdin?.destroy();
  };
  signal?.addEventListener("abort", aborted, { once: true });
  try {
    if (!child.stdout || !child.stdin) throw new Error("ENDPOINT_STDIO_MISSING");
    channel = new JsonChannel(
      child.stdout,
      child.stdin,
      config.limits.max_message_bytes,
      config.limits.max_pending_requests,
    );
    const ready = RpcConnection.fromChannel(
      channel,
      endpointIdentity(config),
      config.limits,
      host.public.instance_id,
      clock,
      clock.now(),
      config.supervisor_identity,
    );
    const fd = child.stdio[3];
    if (!fd || !("end" in fd)) throw new Error("ENDPOINT_BOOTSTRAP_MISSING");
    fd.on("error", () => {});
    fd.end(JSON.stringify(config));
    connection = await ready;
    signal?.throwIfAborted();
    connection.onEndpointFact(onFact, () => 0);
    await connection.authenticatePeer(host);
    const result = await connection.peerCall("plugin.handshake", {
      host_instance_id: host.public.instance_id,
      protocol_versions: ["0.8.0"],
      schema_digest: schemaDigest,
      enabled_phases: ["P0"],
    });
    assertValid("HandshakeResult", result);
    if (
      result.plugin_instance_id !== config.endpoint_instance_id ||
      result.schema_digest !== schemaDigest ||
      payloadDigest(result.manifest) !== payloadDigest(config.manifest)
    )
      throw new Error("ENDPOINT_HANDSHAKE_MISMATCH");
    onFact(await queryEndpoint(connection, config));
    signal?.throwIfAborted();
    return { child, connection };
  } catch (error) {
    connection?.close();
    await terminateChild(child);
    throw error;
  } finally {
    signal?.removeEventListener("abort", aborted);
  }
}
