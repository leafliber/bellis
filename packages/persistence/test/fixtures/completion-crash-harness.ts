import { DatabaseSync } from "node:sqlite";
import { createPersistenceClient } from "../../src/index.js";
import type { PersistenceCheckpoint } from "../../src/index.js";
import { fixture, target, adopt, commit, confirm } from "../phase4-effect-fixtures.js";
import { SESSION_ID, TRACE, WORKER_FIXTURE } from "../helpers.js";

const [directory, window] = process.argv.slice(2) as [string, PersistenceCheckpoint];
if (
  !process.send ||
  !["before_effect_transaction_commit", "after_effect_transaction_commit_before_ack"].includes(
    window,
  )
)
  throw new Error("private test IPC and known window required");
const f = fixture("audio", 32);
f.preparation.targets = Array.from({ length: 8 }, (_, i) => ({
  ...target,
  providerId: `provider-${i}`,
  sourceStream: "o".repeat(200),
  privacyLabels: Array.from({ length: 30 }, () => "l".repeat(250)),
}));
const receipt = f.receipt(31);
let backgroundStopped = false;
const client = createPersistenceClient({
  dataDirectory: directory,
  worker: WORKER_FIXTURE,
  defaultDeadlineMs: 30_000,
  diskAdmission: { walHighWaterBytes: 16 * 1024 ** 2 },
  checkpointObserver: {
    reached: async (checkpoint) => {
      if (checkpoint !== window) return;
      process.send?.({ type: "checkpoint", checkpoint, receipt, backgroundStopped });
      await new Promise<void>(() => {});
    },
  },
});
try {
  await client.migrate();
  await client.ensureSession({ sessionId: SESSION_ID, createdAtMs: 0, trace: TRACE });
  await adopt(client, f);
  await client.phase4PrepareEffects(f.preparation);
  await commit(client, f);
  // This real old reader disappears only when the owner process is killed.
  const reader = new DatabaseSync(`${directory}/state.db`, { readOnly: true });
  reader.exec("BEGIN");
  reader.prepare("SELECT count(*) FROM phase4_effect_preparations").get();
  const scope = { scopeKey: "f".repeat(64), providerId: "background" };
  let revision = 0;
  for (let i = 0; i < 200; i++) {
    try {
      revision = await client.phase4WriteProviderState({
        ...scope,
        expectedRevision: revision,
        state: { text: String.fromCharCode(65 + (i % 26)).repeat(250_000) },
      });
    } catch (error) {
      if ((error as { code?: string }).code !== "storage_not_ready") throw error;
      backgroundStopped = true;
      break;
    }
  }
  if (!backgroundStopped || (await client.readDiskStatus()).reason !== "wal_pressure")
    throw new Error("WAL pressure was not reached");
  for (let index = 0; index < 32; index++) await client.phase4BindAudioSegment(f.binding(index));
  await confirm(client, receipt);
  throw new Error("confirmation escaped the requested checkpoint");
} catch (error) {
  process.send?.({
    type: "failure",
    message: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
  await client.close();
}
