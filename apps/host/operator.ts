import { randomUUID } from "node:crypto";
import { assertValid } from "../../packages/contract-sdk/src/index.ts";
import { RpcConnection } from "../../packages/runtime/src/client.ts";
import {
  decodeJson,
  readControlled,
  readCredential,
  readServiceIdentity,
  requireRuntimeVersion,
} from "../../packages/runtime/src/files.ts";
import { observationError, StartupObservation } from "../../packages/runtime/src/observation.ts";

const startup = new StartupObservation("operator");
let connection: RpcConnection | undefined;
let issuing = false;
try {
  requireRuntimeVersion();
  startup.stage = "arguments";
  const args = process.argv.slice(2);
  if (
    args.length !== 4 ||
    args[0] !== "--config" ||
    !args[1] ||
    args[2] !== "--command" ||
    !["authenticate", "query", "host-query"].includes(args[3] ?? "")
  )
    throw new Error("INVALID_ARGUMENTS");
  startup.stage = "configuration";
  const config = decodeJson(await readControlled(args[1]));
  assertValid("P0RuntimeConfig", config);
  const instance = randomUUID();
  const observation = startup.bind(instance, config.limits);
  const credential = await readCredential(config.operator_credentials_path);
  const authority = await readServiceIdentity(config.management_socket_path);
  if (authority.role !== "supervisor") throw new Error("SUPERVISOR_IDENTITY_MISMATCH");
  const hostQuery = args[3] === "host-query";
  const socket = hostQuery
    ? `${config.management_socket_path}.host`
    : config.management_socket_path;
  const peer = hostQuery ? await readServiceIdentity(socket) : authority;
  if (peer.role !== (hostQuery ? "host" : "supervisor"))
    throw new Error("SERVICE_IDENTITY_MISMATCH");
  startup.stage = "connect";
  connection = await RpcConnection.connect(
    socket,
    peer,
    config.limits,
    instance,
    startup.clock,
    authority,
    undefined,
    observation,
  );
  const method =
    args[3] === "authenticate"
      ? "operator.authenticate"
      : hostQuery
        ? "host.query"
        : "session.query";
  const input =
    method === "operator.authenticate" ? {} : { session_id: connection.announcement.session_id };
  issuing = true;
  await connection.operatorCall(method, input, credential);
  process.stdout.write(`${JSON.stringify(connection.lastResponse)}\n`);
} catch (error) {
  if (!issuing) await startup.failed(error);
  else {
    // Exactly one management command is issued on this connection. Preserve its real failure response.
    const response = connection?.lastResponse;
    if (response && "error" in response) process.stdout.write(`${JSON.stringify(response)}\n`);
    else connection?.observation?.failure("dispatch", observationError(error));
  }
  process.exitCode = 1;
} finally {
  connection?.close();
  await startup.writer?.finish();
}
