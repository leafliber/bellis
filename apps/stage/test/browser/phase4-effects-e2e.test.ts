/* oxlint-disable no-underscore-dangle -- test-only Stage diagnostics */
import { randomUUID } from "node:crypto";
import "../../src/StagePage.js";
import { expect, test } from "./fixtures.js";

test.use({ phase: 4 });

test("Phase 4: Worklet-rendered segments reach durable Observe and the next model context", async ({
  page,
  stageEnv,
}) => {
  const cycles = Number(process.env.BELLIS_IRIS_E2E_CYCLES ?? 3);
  expect(Number.isSafeInteger(cycles) && cycles >= 3 && cycles <= 100).toBe(true);
  test.setTimeout(90_000 + (cycles - 3) * 6_000);
  const released = new Set<string>();
  page.on("websocket", (socket) =>
    socket.on("framereceived", (event) => {
      if (typeof event.payload !== "string") return;
      const message = JSON.parse(event.payload) as {
        type?: string;
        payload?: { sceneId?: string };
      };
      if (message.type === "scene.effect.released" && message.payload?.sceneId)
        released.add(message.payload.sceneId);
    }),
  );
  await page.goto(stageEnv.pageUrl(await stageEnv.issueToken()));
  await page.waitForFunction(() => window.__bellisStage?.appState() === "performance_ready", null, {
    timeout: 45_000,
  });
  await page.getByRole("button", { name: "启用音频" }).click();
  await page.waitForFunction(() => window.__bellisStage?.audioArmed() === true);
  const speech = "第一句。第二句。";
  const run = async (text: string) => {
    stageEnv.rpc({
      type: "set-script",
      events: [
        { type: "started" },
        { type: "speech", delta: text },
        { type: "speech_meta", purpose: "answer", interruptible: true },
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
  await run(speech);
  await page
    .waitForFunction(
      () => (window.__bellisStage?.sceneEvents() ?? []).some((event) => event.state === "finished"),
      null,
      { timeout: 30_000 },
    )
    .catch(async (error) => {
      console.info(
        "Stage effects failure",
        await page.evaluate(() => ({
          events: window.__bellisStage?.sceneEvents(),
          audio: window.__bellisStage?.audioError(),
          state: window.__bellisStage?.appState(),
        })),
      );
      stageEnv.rpc({ type: "evidence" });
      console.info("Host effects failure", JSON.stringify(await stageEnv.expectRpc("evidence")));
      throw error;
    });
  const evidence = async () => {
    stageEnv.rpc({ type: "evidence" });
    return (await stageEnv.expectRpc("evidence")) as unknown as {
      memory: {
        observations: {
          content: string;
          role: string;
          effectState: string;
          sourceCursor: string;
          effectProof: { confirmed_range: { start: number; end: number; lane: string } };
        }[];
        usageCount: number;
      };
      provider: { prompts: string[] };
    };
  };
  await expect.poll(async () => (await evidence()).memory.observations.length).toBe(2);
  const first = await evidence();
  expect(first.memory.observations).toMatchObject([
    {
      content: "第一句。",
      role: "assistant",
      effectState: "partial",
      sourceCursor: "1",
      effectProof: { confirmed_range: { start: 0, end: 4, lane: "audio" } },
    },
    {
      content: "第二句。",
      role: "assistant",
      effectState: "partial",
      sourceCursor: "2",
      effectProof: { confirmed_range: { start: 4, end: 8, lane: "audio" } },
    },
  ]);
  expect(first.memory.usageCount).toBe(1);
  expect(await page.evaluate(() => window.__bellisStage?.audioError())).toBeNull();
  await run("收到。");
  await expect.poll(async () => (await evidence()).provider.prompts.length).toBe(2);
  const second = await evidence();
  expect(second.provider.prompts[1]).toContain("已确认输出片段");
  expect(second.provider.prompts[1]).toContain("第一句。");
  expect(second.provider.prompts[1]).toContain("第二句。");
  await expect.poll(async () => (await evidence()).memory.observations.length).toBe(3);
  expect((await evidence()).memory.observations[2]).toMatchObject({
    content: "收到。",
    effectState: "committed",
    sourceCursor: "3",
  });
  // Keep one real Runtime/DB Worker, Core service and Chromium session alive.
  // Wait for durable output and Scene release before admitting the next turn.
  for (let index = 2; index < cycles - 1; index++) {
    await expect.poll(() => released.size).toBe(index);
    const text = `第${index + 1}轮。`;
    await run(text);
    await expect.poll(async () => (await evidence()).provider.prompts.length).toBe(index + 1);
    await expect.poll(async () => (await evidence()).memory.observations.length).toBe(index + 2);
    await expect.poll(async () => (await evidence()).memory.usageCount).toBe(index + 1);
    expect((await evidence()).memory.observations[index + 1]).toMatchObject({
      content: text,
      effectState: "committed",
      sourceCursor: String(index + 2),
    });
    expect(await page.evaluate(() => window.__bellisStage?.audioError())).toBeNull();
    if ((index + 1) % 10 === 0) console.info(`iris-continuous: ${index + 1}/${cycles} cycles`);
  }
  await expect.poll(() => released.size).toBe(cycles - 1);
  // A trusted privacy transition stops playback during the next semantic segment.
  // The visible subtitle and late receipts must not create another memory fact.
  await run("完成。后面的这个完整语义片段仍在合成播放中所以中途取消时不能把整段写进记忆。");
  await expect.poll(async () => (await evidence()).memory.observations.length).toBe(cycles + 1);
  stageEnv.rpc({ type: "privacy-interrupt" });
  expect(await stageEnv.expectRpc("privacy-interrupted")).toMatchObject({
    generation: 1,
    blocked: true,
  });
  await expect.poll(() => released.size).toBe(cycles);
  const interrupted = await evidence();
  expect(interrupted.memory.observations).toHaveLength(cycles + 1);
  expect(interrupted.memory.observations[cycles]).toMatchObject({
    content: "完成。",
    effectState: "partial",
    sourceCursor: String(cycles + 1),
  });
  expect(await page.evaluate(() => window.__bellisStage?.subtitleTexts() ?? [])).toHaveLength(0);
  await expect.poll(async () => (await evidence()).memory.usageCount).toBe(cycles);
  if (process.env.BELLIS_IRIS_E2E_REPORT) {
    stageEnv.rpc({ type: "save-output-evidence" });
    const saved = await stageEnv.expectRpc("output-evidence-saved");
    expect(saved.ok, String(saved.error ?? "output audit failed")).toBe(true);
  }
});
