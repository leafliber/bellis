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
import {
  observationError,
  StartupObservation,
  writeCliResult,
} from "../../packages/runtime/src/observation.ts";
import {
  operatorTarget,
  parseOperatorCommand,
  prepareOperatorCommand,
} from "../../packages/runtime/src/operator-command.ts";

const startup = new StartupObservation("operator");
let connection: RpcConnection | undefined;
let issuing = false;
let output: Buffer | undefined;
try {
  requireRuntimeVersion();
  startup.stage = "arguments";
  const command = parseOperatorCommand(process.argv.slice(2));
  startup.stage = "configuration";
  const config = decodeJson(await readControlled(command.configPath));
  assertValid("P0RuntimeConfig", config);
  const instance = randomUUID();
  const observation = startup.bind(instance, config.limits);
  const credential = await readCredential(config.operator_credentials_path);
  const authority = await readServiceIdentity(config.management_socket_path);
  if (authority.role !== "supervisor") throw new Error("SUPERVISOR_IDENTITY_MISMATCH");
  const hostTarget = operatorTarget(command) === "host";
  const socket = hostTarget
    ? `${config.management_socket_path}.host`
    : config.management_socket_path;
  const peer = hostTarget ? await readServiceIdentity(socket) : authority;
  if (peer.role !== (hostTarget ? "host" : "supervisor"))
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
  const prepared = prepareOperatorCommand(command, config, connection, credential);
  issuing = true;
  const exchange = await connection.sendPrepared(prepared, credential);
  output = Buffer.from(`${JSON.stringify(exchange.response)}\n`);
  if ("error" in exchange.response) process.exitCode = 1;
} catch (error) {
  if (!issuing) await startup.failed(error);
  else {
    // A transport failure (including a late response) has no timely business result.
    connection?.observation?.failure("dispatch", observationError(error));
  }
  process.exitCode = 1;
} finally {
  connection?.close();
  const [, stdoutResult] = await Promise.all([
    startup.writer?.finish(),
    output ? writeCliResult(output) : Promise.resolve(undefined),
  ]);
  if (startup.writer?.osWriteInFlight || stdoutResult?.writer.inFlight)
    process.kill(process.pid, "SIGKILL");
  process.exit(stdoutResult?.complete === false ? 1 : Number(process.exitCode ?? 0));
}
