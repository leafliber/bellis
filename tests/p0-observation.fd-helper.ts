// Controlled observation transport fixture; no device, grant or SUT state is implemented here.
import { assertValid } from "../packages/contract-sdk/src/index.ts";
import { MonotonicClock } from "../packages/runtime/src/clock.ts";
import { ObservationWriter, writeCliResult } from "../packages/runtime/src/observation.ts";

const mode = process.argv[2];
if (mode !== "file" && mode !== "pipe") process.exit(3);
const writer = new ObservationWriter(
  "runner",
  "fd-transport-fixture",
  new MonotonicClock("c".repeat(256)),
  {
    max_message_bytes: 65536,
    max_pending_requests: 1024,
  },
);
const count = mode === "pipe" ? 1024 : 8;
const force = setTimeout(() => process.exit(4), 1000);
for (let i = 0; i < count; i++) {
  const record = writer.protocol("x".repeat(160), {
    kind: "local_failure",
    stage: "dispatch",
    request_id: `${i}${"r".repeat(156)}`,
    operation_id: "o".repeat(160),
    request_digest: "a".repeat(64),
    error: { kind: "internal", code: "unexpected_error" },
    frame_sha256: null,
    frame_bytes: null,
  });
  if (!record) throw new Error("CONTROLLED_OBSERVATION_SCHEMA_REJECTED");
  assertValid("P0ProtocolObservation", record);
}
setTimeout(
  async () => {
    // This actual timer must execute while fd 2 is not being drained by the parent.
    await writeCliResult(
      Buffer.from(`${JSON.stringify({ timer_progress: true, attempted: count })}\n`),
    );
    const result = await writer.finish(mode === "pipe" ? 30 : 100);
    await writeCliResult(Buffer.from(`${JSON.stringify({ finish: result })}\n`));
    clearTimeout(force);
    await writeCliResult(
      Buffer.from(
        `${JSON.stringify({ exit_strategy: writer.osWriteInFlight ? "self_sigkill" : "normal_exit" })}\n`,
      ),
    );
    if (writer.osWriteInFlight) process.kill(process.pid, "SIGKILL");
    process.exit(mode === "file" && !result.complete ? 2 : 0);
  },
  mode === "pipe" ? 50 : 0,
);
