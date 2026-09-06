/* oxlint-disable no-underscore-dangle -- test-only Stage diagnostics */
import { randomUUID } from "node:crypto";
import "../../src/StagePage.js";
import { expect, test } from "./fixtures.js";

test.use({ phase: 3 });

test("Phase 3: real Chromium renders two cycles with parallel tools, then cancels on urgent input", async ({
  page,
  stageEnv,
}) => {
  await page.goto(stageEnv.pageUrl(await stageEnv.issueToken()));
  await page.waitForFunction(() => window.__bellisStage?.appState() === "performance_ready", null, {
    timeout: 45_000,
  });
  await page.getByRole("button", { name: "启用音频" }).click();
  await page.waitForFunction(() => window.__bellisStage?.audioArmed() === true);
  const quest = randomUUID();
  const readStage = randomUUID();
  const script = async (events: Record<string, unknown>[]) => {
    stageEnv.rpc({ type: "set-script", events });
    await stageEnv.expectRpc("script-set");
  };
  await script([
    { type: "started" },
    { type: "speech", delta: "好" },
    { type: "speech_meta", purpose: "tool_notice", interruptible: true },
    { type: "tool_call_start", toolRunId: quest, toolName: "lookup_quest" },
    { type: "tool_args", toolRunId: quest, delta: '{"quest":"main"}' },
    { type: "tool_call_end", toolRunId: quest },
    { type: "tool_call_start", toolRunId: readStage, toolName: "read_stage" },
    { type: "tool_args", toolRunId: readStage, delta: "{}" },
    { type: "tool_call_end", toolRunId: readStage },
    { type: "next", next: "after_tools" },
    { type: "final" },
  ]);
  // Model streaming takes longer than the short notice; no fake Stage readiness or playback.
  await script([
    { type: "started" },
    ...Array.from("任务进度已经过半，我们继续观察并保持当前节奏。".repeat(2), (delta) => ({
      type: "speech",
      delta,
    })),
    { type: "speech_meta", purpose: "answer", interruptible: true },
    { type: "next", next: "finish" },
    { type: "final" },
  ]);
  const ingest = async (priority: number) => {
    stageEnv.rpc({
      type: "ingest",
      signal: {
        schemaVersion: 1,
        id: randomUUID(),
        source: "browser-e2e",
        kind: "danmaku",
        occurredAt: Date.now(),
        priority,
        payload: { text: "看看任务", userId: "u1" },
      },
    });
    expect((await stageEnv.expectRpc("ingest-result")).result).toBe("accepted");
  };
  await ingest(100);
  await page.waitForFunction(
    () =>
      (window.__bellisStage?.sceneEvents() ?? []).filter((event) => event.state === "running")
        .length >= 2,
    null,
    { timeout: 30_000 },
  );
  stageEnv.rpc({ type: "evidence" });
  const snapshot = (await stageEnv.expectRpc("evidence")) as unknown as {
    evidence: {
      adopted: number;
      toolRuns: { toolRunId: string; startedAtUs: string; finishedAtUs: string }[];
      sceneSpans: { submittedAtUs: string; settledAtUs: string | null }[];
    };
    provider: { prompts: string[] };
  };
  expect(snapshot.evidence.adopted).toBe(2);
  expect(snapshot.provider.prompts[1]).toContain("55");
  const a = snapshot.evidence.toolRuns.find((run) => run.toolRunId === quest)!;
  const b = snapshot.evidence.toolRuns.find((run) => run.toolRunId === readStage)!;
  expect(
    BigInt(a.startedAtUs) < BigInt(b.finishedAtUs) &&
      BigInt(b.startedAtUs) < BigInt(a.finishedAtUs),
  ).toBe(true);
  const first = snapshot.evidence.sceneSpans[0]!;
  expect(BigInt(first.submittedAtUs)).toBeLessThan(BigInt(a.finishedAtUs));
  expect(BigInt(first.settledAtUs!)).toBeGreaterThan(BigInt(a.startedAtUs));
  const active = await page.evaluate(
    () =>
      (window.__bellisStage?.sceneEvents() ?? [])
        .filter((event) => event.state === "running")
        .at(-1)!.sceneId,
  );
  await ingest(900);
  await page.waitForFunction(
    (sceneId) =>
      (window.__bellisStage?.sceneEvents() ?? []).some(
        (event) => event.sceneId === sceneId && event.state === "cancelled",
      ),
    active,
    { timeout: 10_000 },
  );
  expect(await page.evaluate(() => window.__bellisStage?.subtitleTexts() ?? [])).toHaveLength(0);
  expect(await page.evaluate(() => window.__bellisStage?.audioError())).toBeNull();
});
