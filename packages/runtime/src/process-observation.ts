import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { type P0ProcessObservation, payloadDigest } from "../../contract-sdk/src/index.ts";
import { type ObservationWriter, observationError } from "./observation.ts";

/** Parent-only module. Never imported by the single-artifact endpoint. */
export function observedSpawn(
  execPath: string,
  args: string[],
  options: SpawnOptions,
  writer: ObservationWriter | undefined,
  role: "host" | "endpoint" | "operator" | "supervisor",
  expectedInstance: string | null,
): ChildProcess {
  const child = {
    launch_id: randomUUID(),
    child_role: role,
    expected_instance_id: expectedInstance,
  };
  const emit = (detail: P0ProcessObservation["detail"]) => writer?.process(detail);
  emit({
    kind: "spawn_attempt",
    ...child,
    actual_pid: null,
    command_digest: payloadDigest({ exec_path: execPath, args }),
  });
  let process: ChildProcess;
  try {
    process = spawn(execPath, args, options);
  } catch (error) {
    emit({ kind: "spawn_error", ...child, actual_pid: null, error: observationError(error) });
    throw error;
  }
  process.once("spawn", () => {
    if (process.pid) emit({ kind: "spawned", ...child, actual_pid: process.pid });
  });
  process.on("error", (error) =>
    emit({
      kind: "spawn_error",
      ...child,
      actual_pid: process.pid ?? null,
      error: observationError(error),
    }),
  );
  process.once("exit", (exit_code, signal) => {
    if (process.pid) emit({ kind: "exited", ...child, actual_pid: process.pid, exit_code, signal });
  });
  return process;
}
