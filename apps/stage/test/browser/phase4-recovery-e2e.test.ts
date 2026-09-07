/* oxlint-disable no-underscore-dangle -- test-only Stage diagnostics */
import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { StageEffectReceipt } from "@bellis/contracts";
import type { MemoryObserveEvent } from "@bellis/contracts/memory";
import "../../src/StagePage.js";
import { expect, test } from "./fixtures.js";

test.use({ phase: 4 });
const repetitions = Number(process.env.BELLIS_IRIS_RECOVERY_REPETITIONS ?? 1);
const observeRecovery = process.env.BELLIS_IRIS_RECOVERY_FAMILY === "observe";
const windows = observeRecovery
  ? [
      "observation_before_http_publish",
      "core_observation_committed_before_http_ack",
      "observation_sdk_ack_before_host_delivered",
    ]
  : ["before_effect_transaction_commit", "after_effect_transaction_commit_before_ack"];

/** Independent, read-only host audit also works while the DB Worker holds COMMIT. */
function audit(directory: string) {
  const db = new DatabaseSync(join(directory, "state.db"), { readOnly: true });
  try {
    return {
      manifests: db.prepare("SELECT * FROM phase4_context_manifests ORDER BY rowid").all(),
      receipts: db.prepare("SELECT * FROM phase4_effect_receipts ORDER BY rowid").all(),
      observations: db
        .prepare(`SELECT o.event_json, o.event_digest, b.status
        FROM phase4_observations o JOIN outbox b ON b.outbox_id = o.outbox_id
        ORDER BY o.rowid`)
        .all(),
      reservations: db.prepare("SELECT * FROM phase4_completion_reservations").all(),
      preparations: db.prepare("SELECT scene_id, closed FROM phase4_effect_preparations").all(),
    };
  } finally {
    db.close();
  }
}

for (const checkpoint of windows)
  for (let repetition = 1; repetition <= repetitions; repetition++)
    test(`Phase 4 Stage recovery: ${checkpoint} ${repetition}/${repetitions}`, async ({
      page,
      stageEnv,
    }) => {
      test.skip(!process.env.BELLIS_IRIS_RECOVERY_REPORT, "requires installed Core operator");
      expect([1, 20]).toContain(repetitions);
      const committed = checkpoint !== "before_effect_transaction_commit";
      const sentReceipts: StageEffectReceipt[] = [];
      const effectAcks: string[] = [];
      const sceneCommits: string[] = [];
      page.on("websocket", (socket) => {
        socket.on("framesent", ({ payload }) => {
          if (typeof payload !== "string") return;
          const message = JSON.parse(payload);
          if (message.type === "scene.effect.receipt") sentReceipts.push(message.payload);
        });
        socket.on("framereceived", ({ payload }) => {
          if (typeof payload !== "string") return;
          const message = JSON.parse(payload);
          if (message.type === "scene.effect.ack") effectAcks.push(message.payload.receiptId);
          if (message.type === "scene.commit") sceneCommits.push(message.payload.sceneId);
        });
      });
      const connect = async (resumeSessionId?: string) => {
        const url = new URL(stageEnv.pageUrl(await stageEnv.issueToken()));
        if (resumeSessionId) url.searchParams.set("resumeSessionId", resumeSessionId);
        const responsePromise = page.waitForResponse((response) =>
          response.url().endsWith("/api/v1/auth/exchange"),
        );
        await page.goto(url.href);
        const response = await responsePromise;
        expect(response.status()).toBe(200);
        const authenticated = await response.json();
        if (resumeSessionId)
          expect(authenticated).toMatchObject({ sessionId: resumeSessionId, resumed: true });
        await page.waitForFunction(() => window.__bellisStage?.appState() === "performance_ready");
        await page.getByRole("button", { name: "启用音频" }).click();
        await page.waitForFunction(() => window.__bellisStage?.audioArmed() === true);
      };
      const run = async (speech?: string) => {
        stageEnv.rpc({
          type: "set-script",
          events: [
            { type: "started" },
            ...(speech
              ? [
                  { type: "speech", delta: speech },
                  { type: "speech_meta", purpose: "answer", interruptible: true },
                ]
              : []),
            { type: "next", next: "finish" },
            { type: "final" },
          ],
        });
        await stageEnv.expectRpc("script-set");
        stageEnv.rpc({
          type: "ingest",
          signal: {
            schemaVersion: 1,
            id: randomUUID(),
            source: "browser-e2e",
            kind: "danmaku",
            occurredAt: Date.now(),
            priority: 100,
            payload: { text: "继续", userId: "u1" },
          },
        });
        expect((await stageEnv.expectRpc("ingest-result")).result).toBe("accepted");
      };
      const evidence = async () => {
        stageEnv.rpc({ type: "evidence" });
        return (await stageEnv.expectRpc("evidence")) as unknown as {
          memory: { observations: MemoryObserveEvent[]; observeRequests: unknown[] };
          provider: { prompts: string[]; callCount: number };
        };
      };
      await connect();
      stageEnv.rpc({ type: "arm-effect-checkpoint", checkpoint });
      await stageEnv.expectRpc("effect-checkpoint-armed");
      const prefix = `确认${repetition}。`;
      const suffix = "后面的完整语义片段仍在播放所以中途崩溃不能把剩余内容推断成已经确认的发言。";
      await run(prefix + suffix);
      const reached = await stageEnv.expectRpc("effect-checkpoint");
      expect(reached.checkpoint).toBe(checkpoint);
      const original = reached.receipt as StageEffectReceipt;
      await expect
        .poll(() => sentReceipts.some((item) => item.receiptId === original.receiptId))
        .toBe(true);
      expect(sentReceipts.find((item) => item.receiptId === original.receiptId)).toEqual(original);
      expect(original).toMatchObject({
        lane: "audio",
        boundary: "worklet_rendered",
        start: 0,
        end: prefix.length,
      });
      const stageAckBeforeCrash = effectAcks.includes(original.receiptId);
      if (!observeRecovery) expect(stageAckBeforeCrash).toBe(false);
      expect(sceneCommits).toEqual([original.sceneId]);
      expect(await page.evaluate(() => window.__bellisStage?.audioError())).toBeNull();
      const before = audit(stageEnv.dataDirectory);
      expect(before.manifests).toHaveLength(1);
      expect(before.receipts).toHaveLength(committed ? 1 : 0);
      expect(before.observations).toHaveLength(committed ? 1 : 0);
      if (observeRecovery) {
        expect(before.observations[0]!.status).toBe("in_flight");
        expect(reached.remoteCursor).toBe(
          checkpoint === "observation_before_http_publish" ? null : 1,
        );
        expect(reached.providerCursor).toBe(
          checkpoint === "observation_sdk_ack_before_host_delivered" ? "1" : null,
        );
        const liveEvents = await page.evaluate(() => window.__bellisStage?.sceneEvents() ?? []);
        expect(
          liveEvents.some(
            (event) =>
              event.sceneId === original.sceneId &&
              ["finished", "cancelled", "failed"].includes(event.state),
          ),
        ).toBe(false);
      }
      const crash = await stageEnv.crashAndRestartRuntime();
      expect(crash).toEqual({ signal: "SIGKILL", replacedProcess: true });
      await expect
        .poll(
          () =>
            audit(stageEnv.dataDirectory).observations.filter((row) => row.status === "delivered")
              .length,
        )
        .toBe(committed ? 1 : 0);
      const recovered = audit(stageEnv.dataDirectory);
      expect(recovered.manifests).toEqual(before.manifests);
      expect(recovered.receipts).toEqual(before.receipts);
      expect(
        recovered.observations.map(({ event_json, event_digest }) => ({
          event_json,
          event_digest,
        })),
      ).toEqual(
        before.observations.map(({ event_json, event_digest }) => ({ event_json, event_digest })),
      );
      expect(recovered.preparations.every((row) => row.closed === 1)).toBe(true);
      expect(recovered.reservations).toHaveLength(0);
      expect((await evidence()).provider.callCount).toBe(0);
      const commitsBeforeReconnect = [...sceneCommits];
      await connect(original.sessionId);
      await run();
      await expect.poll(async () => (await evidence()).provider.prompts.length).toBe(1);
      const after = await evidence();
      expect(after.provider.prompts[0]?.includes(prefix)).toBe(committed);
      expect(after.provider.prompts[0]?.includes("已确认输出片段")).toBe(committed);
      expect(after.provider.prompts[0]?.includes(original.receiptId)).toBe(committed);
      expect(after.provider.prompts[0]).not.toContain(suffix);
      expect(sceneCommits).toEqual(commitsBeforeReconnect);
      expect(audit(stageEnv.dataDirectory).receipts).toEqual(before.receipts);
      if (committed) {
        expect(after.memory.observations).toHaveLength(1);
        expect(after.memory.observations[0]).toEqual(
          JSON.parse(String(before.observations[0]!.event_json)),
        );
        expect(after.memory.observations[0]).toMatchObject({
          content: prefix,
          sourceCursor: "1",
          role: "assistant",
          effectState: "partial",
        });
        expect(after.memory.observeRequests).toHaveLength(1);
      } else {
        expect(after.memory.observations).toHaveLength(0);
        expect(after.memory.observeRequests).toHaveLength(0);
      }
      await appendFile(
        process.env.BELLIS_IRIS_RECOVERY_REPORT!,
        JSON.stringify({
          checkpoint,
          repetition,
          crash,
          originalReceipt: original,
          manifest: before.manifests[0],
          sourceStream: `bellis:stage-recovery-${basename(stageEnv.dataDirectory)}:output`,
          durableReceiptCount: recovered.receipts.length,
          observations: after.memory.observations,
          observeRequests: after.memory.observeRequests,
          ...(observeRecovery
            ? {
                requestAtCrash: reached.request,
                remoteCursorAtCrash: reached.remoteCursor,
                providerCursorAtCrash: reached.providerCursor,
                hostStatusAtCrash: before.observations[0]!.status,
                activeSceneAtCrash: true,
              }
            : {}),
          noAutomaticSceneReplay: true,
          confirmedPrefixInNextContext: committed,
          releasedReservations: true,
          stageAckBeforeCrash,
          resumedOriginalSession: true,
          confirmedReceiptInNextContext: committed,
        }) + "\n",
        { mode: 0o600 },
      );
      console.info(`iris-stage-recovery: ${checkpoint} ${repetition}/${repetitions}`);
    });
