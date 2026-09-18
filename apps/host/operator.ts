import { assertValid } from "../../packages/contract-sdk/src/index.ts";
import { connectOperator } from "../../packages/runtime/src/client.ts";
import { RuntimeRejection } from "../../packages/runtime/src/errors.ts";
import {
  decodeJson,
  readControlled,
  readCredential,
  requireRuntimeVersion,
} from "../../packages/runtime/src/files.ts";

try {
  requireRuntimeVersion();
  const args = process.argv.slice(2);
  if (
    args.length !== 4 ||
    args[0] !== "--config" ||
    !args[1] ||
    args[2] !== "--command" ||
    !["authenticate", "query"].includes(args[3] ?? "")
  )
    throw new Error("INVALID_ARGUMENTS");
  const config = decodeJson(await readControlled(args[1]));
  assertValid("P0RuntimeConfig", config);
  const credential = await readCredential(config.operator_credentials_path);
  const connection = await connectOperator(config.management_socket_path, config.limits);
  try {
    const method = args[3] === "query" ? "session.query" : "operator.authenticate";
    const input =
      method === "session.query" ? { session_id: connection.announcement.session_id } : {};
    await connection.operatorCall(method, input, credential);
    // Stdout is exactly the checked response; credentials/proofs are never echoed.
    process.stdout.write(`${JSON.stringify(connection.lastResponse)}\n`);
  } finally {
    connection.close();
  }
} catch (error) {
  process.stderr.write(
    `${error instanceof RuntimeRejection ? error.reason : "P0_OPERATOR_REJECTED"}\n`,
  );
  process.exitCode = 1;
}
