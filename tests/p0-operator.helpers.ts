import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { safeChildEnvironment } from "../packages/runtime/src/processes.ts";
import { repository } from "./p0-identity.helpers.ts";
import { capture } from "./p0-observation.helpers.ts";

export async function operator(configPath: string, action: string, flags: string[] = []) {
  const run = capture(
    [
      join(repository, "apps/host/operator.ts"),
      "--config",
      configPath,
      "--command",
      action,
      ...flags,
    ],
    action,
    safeChildEnvironment(),
    join(repository, "reports/p0/w5sl/cli-raw", `${action}-${randomUUID()}`),
  );
  const [code, signal] = await run.closed;
  await run.save();
  return { ...run.output(), code, signal, directory: run.directory };
}
export const actionFlags = {
  authorize: [
    "--endpoint-instance",
    "observed-endpoint",
    "--target",
    "SimulationCounter",
    "fixture-counter",
    "--capability",
    "simulation.execute",
    "--effect-limit",
    "2",
    "--queue-limit",
    "1",
    "--cost-limit",
    "0",
    "--human-lease-ms",
    "500",
    "--grant-ms",
    "400",
  ],
  renew: ["--supervision-epoch", "0", "--human-lease-ms", "500"],
  revoke: ["--grant-id", "unissued-grant"],
  stop: ["--target", "SimulationCounter", "fixture-counter"],
  execute: [
    "--grant-id",
    "unissued-grant",
    "--endpoint-instance",
    "observed-endpoint",
    "--target",
    "SimulationCounter",
    "fixture-counter",
    "--units",
    "1",
    "--interval-ms",
    "10",
    "--cost-units",
    "0",
  ],
  fault: ["--fault-target", "endpoint", "--fault", "ack_delay", "--duration-ms", "5"],
};
