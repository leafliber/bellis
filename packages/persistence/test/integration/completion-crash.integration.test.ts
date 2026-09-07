import { fork, type ChildProcess } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";
import type { StageEffectReceipt } from "@bellis/contracts";
import { createPersistenceClient } from "../../src/index.js";
import {
  createTempDataDirectory,
  cleanupTempDataDirectory,
  WORKER_FIXTURE,
  SESSION_ID,
} from "../helpers.js";
import { confirm } from "../phase4-effect-fixtures.js";

const harness = fileURLToPath(new URL("../fixtures/completion-crash-harness.ts", import.meta.url));
const windows = [
  "before_effect_transaction_commit",
  "after_effect_transaction_commit_before_ack",
] as const;
const cases: Array<Record<string, unknown>> = [];
afterAll(() => {
  const path = process.env.BELLIS_COMPLETION_CRASH_REPORT;
  if (path)
    writeFileSync(
      path,
      JSON.stringify(
        {
          schemaVersion: 1,
          status: cases.length === 40 ? "passed" : "incomplete",
          expectedCases: 40,
          casesPassed: cases.length,
          cases,
        },
        null,
        2,
      ) + "\n",
    );
});
interface Notice {
  type: string;
  checkpoint: string;
  receipt: StageEffectReceipt;
  backgroundStopped: boolean;
  message?: string;
}
function checkpoint(child: ChildProcess): Promise<Notice> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("completion checkpoint timed out"));
    }, 20_000);
    const message = (notice: Notice) => {
      if (notice.type === "checkpoint") {
        cleanup();
        resolve(notice);
      }
      if (notice.type === "failure") {
        cleanup();
        reject(new Error(notice.message));
      }
    };
    const exit = () => {
      cleanup();
      reject(new Error("child exited before checkpoint"));
    };
    function cleanup() {
      clearTimeout(timer);
      child.off("message", message);
      child.off("exit", exit);
    }
    child.on("message", message);
    child.once("exit", exit);
  });
}
async function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("SIGKILL did not terminate the child")),
      10_000,
    );
    child.once("exit", (_code, signal) => {
      clearTimeout(timer);
      if (signal !== "SIGKILL" && process.platform !== "win32")
        reject(new Error(`unexpected child exit ${signal}`));
      else resolve();
    });
    if (!child.kill("SIGKILL")) {
      clearTimeout(timer);
      reject(new Error("SIGKILL was not sent"));
    }
  });
}

it.each(windows)(
  "recovers atomic completion credits and facts after 20 real kills at %s",
  async (window) => {
    for (let iteration = 0; iteration < 20; iteration++) {
      const directory = createTempDataDirectory("completion-crash-");
      const child = fork(harness, [directory, window], {
        execArgv: [...WORKER_FIXTURE.execArgv],
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      let errors = "";
      child.stderr?.on("data", (chunk) => {
        errors = (errors + String(chunk)).slice(-2000);
      });
      let client: ReturnType<typeof createPersistenceClient> | undefined;
      try {
        const notice = await checkpoint(child);
        expect(notice.checkpoint).toBe(window);
        expect(notice.backgroundStopped).toBe(true);
        expect(statSync(`${directory}/state.db-wal`).size).toBeGreaterThan(16 * 1024 ** 2);
        const committed = window === "after_effect_transaction_commit_before_ack";
        const reader = new DatabaseSync(`${directory}/state.db`, { readOnly: true });
        try {
          expect(reader.prepare("SELECT count(*) AS n FROM phase4_effect_receipts").get()!.n).toBe(
            committed ? 1 : 0,
          );
          expect(reader.prepare("SELECT count(*) AS n FROM phase4_observations").get()!.n).toBe(
            committed ? 8 : 0,
          );
          expect(
            reader
              .prepare(
                "SELECT bindings_remaining AS b, confirmations_remaining AS c FROM phase4_completion_reservations",
              )
              .get(),
          ).toEqual({ b: 0, c: committed ? 31 : 32 });
        } finally {
          reader.close();
        }
        await kill(child);
        client = createPersistenceClient({
          dataDirectory: directory,
          worker: WORKER_FIXTURE,
          diskAdmission: { walHighWaterBytes: 16 * 1024 ** 2 },
        });
        await client.migrate();
        expect((await client.readDiskStatus()).capacity).toMatchObject({
          activeCompletionReservations: 0,
          stateReservedBytes: 0,
          stateReservedWalBytes: 0,
        });
        expect((await client.readOutboxStats()).pending).toBe(committed ? 8 : 0);
        if (committed) {
          expect((await confirm(client, notice.receipt)).outcome).toBe("duplicate");
          expect((await client.readOutboxStats()).pending).toBe(8);
          expect((await client.phase4ReadConfirmedSpeech(SESSION_ID))[0]?.text).toBe(
            "\0".repeat(1969),
          );
        } else {
          await expect(confirm(client, notice.receipt)).rejects.toMatchObject({
            code: "invalid_request",
          });
          expect(await client.phase4ReadConfirmedSpeech(SESSION_ID)).toEqual([]);
        }
        cases.push({
          window,
          repetition: iteration + 1,
          childPid: child.pid,
          exitSignal: child.signalCode,
          childExitCode: child.exitCode,
          backgroundStopped: notice.backgroundStopped,
          receiptId: notice.receipt.receiptId,
          sceneId: notice.receipt.sceneId,
          committedBeforeKill: committed,
          recoveredReceiptCount: committed ? 1 : 0,
          recoveredObservations: committed ? 8 : 0,
          completionReservationsAfterRestart: 0,
          duplicateAckAfterRestart: committed,
        });
      } catch (error) {
        throw new Error(`completion crash case ${window}/${iteration} failed; ${errors}`, {
          cause: error,
        });
      } finally {
        await kill(child);
        await client?.close();
        cleanupTempDataDirectory(directory);
      }
    }
  },
  120_000,
);
