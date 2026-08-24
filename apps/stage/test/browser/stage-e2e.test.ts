import { randomUUID } from "node:crypto";
/* 测试专用全局句柄（window.__bellisStage/__bellisSubtitleHiddenAt）。 */
/* oxlint-disable no-underscore-dangle -- 测试诊断全局 */
import { expect, test } from "./fixtures.js";

/**
 * Phase 2 浏览器纵向链路 E2E（真实 Chromium；Gate 2 硬性前置）：
 *
 * 1. /stage/e2e?token=… 启动 → 认证（真实 /api/v1/auth/exchange + Cookie）
 *    → Control/Media 连接 → 时钟校准 ≥3 样本 → performance_ready；
 * 2. 用户手势启用音频（真实 AudioContext 48k + AudioWorklet 模块加载）；
 * 3. Fake Signal → announce → PCM 帧入 Worklet 有界缓冲（预缓冲达标才
 *    ready）→ durable commit → 三 Lane 到点生效：
 *    - audioWorklet=started（帧数、underruns 有界）；
 *    - subtitle=visible（文本节点，textContent；完成后释放）；
 *    - avatarAdapter=started（语义命令 prepare→start）；
 * 4. hardLaneSkewMs：各 Lane startedAtStageUs − targetLocalUs ≤ 50ms；
 * 5. 紧急打断：MutationObserver 计量字幕撤下时延（100ms 预算 + 观测
 *    余量），打断后被打断 Scene 的媒体帧不再累积。
 */

const SPEECH_TEXT = "浏览器端到端验证";

interface LaneStart {
  readonly sceneId: string;
  readonly lane: string;
  readonly targetLocalUs: string;
  readonly startedAtStageUs: string;
  readonly late: boolean;
}

test("Audio Arm → 媒体流 → 三 Lane 生效 → 偏差/打断指标", async ({ page, stageEnv }) => {
  test.setTimeout(150_000);
  page.on("pageerror", (error) => console.info(`[browser-error] ${error.message}`));
  const token = await stageEnv.issueToken();
  await page.goto(stageEnv.pageUrl(token));

  // 1. 启动链路：booting → … → performance_ready（时钟校准 ≥3 样本）。
  await page.waitForFunction(() => window.__bellisStage?.appState() === "performance_ready", null, {
    timeout: 45_000,
  });

  // 2. 用户手势 Arm（真实 AudioContext + AudioWorklet 模块加载）。
  await page.getByRole("button", { name: "启用音频" }).click();
  await page.waitForFunction(() => window.__bellisStage?.audioArmed() === true, null, {
    timeout: 15_000,
  });

  // 3. Fake Signal → 完整链路。
  stageEnv.rpc({
    type: "submit",
    cycleId: randomUUID(),
    traceId: randomUUID().replaceAll("-", "").slice(0, 32),
    text: SPEECH_TEXT,
  });
  const submitted = (await stageEnv.expectRpc("submit-result")) as unknown as {
    ok: boolean;
    sceneId?: string;
  };
  expect(submitted.ok).toBe(true);
  const sceneId = submitted.sceneId ?? "";

  // 音频帧进入 Worklet 有界缓冲（预缓冲 ≥6 帧后才宣告 audio ready）。
  await page.waitForFunction(
    (scene) => (window.__bellisStage?.bufferedFrames()[scene] ?? 0) >= 6,
    sceneId,
    { timeout: 30_000 },
  );

  // 三 Lane 到点生效：started（带双域时刻）→ finished → 资源释放。
  await page.waitForFunction(
    (scene) =>
      (window.__bellisStage?.laneStarts() ?? []).filter((start) => start.sceneId === scene)
        .length >= 3,
    sceneId,
    { timeout: 30_000 },
  );
  await page.waitForFunction(
    (scene) =>
      (window.__bellisStage?.sceneEvents() ?? []).some(
        (event) => event.sceneId === scene && event.state === "finished",
      ),
    sceneId,
    { timeout: 30_000 },
  );

  const diagnostics = await page.evaluate(
    (scene) => ({
      laneStarts: (window.__bellisStage?.laneStarts() ?? []).filter(
        (start) => start.sceneId === scene,
      ),
      subtitleTexts: window.__bellisStage?.subtitleTexts() ?? [],
      avatarCommands: window.__bellisStage?.avatarCommands() ?? 0,
      mediaStats: window.__bellisStage?.mediaStats() ?? null,
      underruns: window.__bellisStage?.underruns() ?? -1,
      audioError: window.__bellisStage?.audioError() ?? null,
    }),
    sceneId,
  );

  const laneStarts = diagnostics.laneStarts as LaneStart[];
  expect(diagnostics.audioError).toBeNull();
  expect(laneStarts.length).toBeGreaterThanOrEqual(3);
  // 终态后字幕行已撤下（资源释放）。
  expect(diagnostics.subtitleTexts).toHaveLength(0);
  expect(diagnostics.avatarCommands).toBeGreaterThanOrEqual(2);
  const mediaStats = diagnostics.mediaStats as { acceptedFrames: number } | null;
  expect(mediaStats?.acceptedFrames ?? 0).toBeGreaterThanOrEqual(6);
  expect(diagnostics.underruns).toBeLessThanOrEqual(8);

  // 4. 硬同步偏差：各 Lane startedAtStageUs − targetLocalUs ≤ 50ms。
  const skewsMs = laneStarts.map(
    (start) => Number(BigInt(start.startedAtStageUs) - BigInt(start.targetLocalUs)) / 1000,
  );
  for (const skew of skewsMs) {
    expect(Math.abs(skew)).toBeLessThanOrEqual(50);
  }
  console.info(`audioWorklet=started(frames=${mediaStats?.acceptedFrames ?? 0})`);
  console.info(`subtitle=visible(textNodes,releasedOnFinish)`);
  console.info(`avatarAdapter=started(commands=${diagnostics.avatarCommands})`);
  console.info(
    `hardLaneSkewMs=${Math.max(...skewsMs.map(Math.abs)).toFixed(2)}(browser, budget=50)`,
  );
  console.info(`underruns=${diagnostics.underruns}`);
  // 消费首场景的 settled（后续 settled 断言专属于被打断场景）。
  const settledA = (await stageEnv.expectRpc("scene-settled", 30_000)) as unknown as {
    state: string;
  };
  expect(settledA.state).toBe("completed");

  // 5. 紧急打断：MutationObserver 计量字幕撤下时延。
  stageEnv.rpc({
    type: "submit",
    cycleId: randomUUID(),
    traceId: randomUUID().replaceAll("-", "").slice(0, 32),
    urgent: true,
    text: "打断浏览器场景",
  });
  const submittedB = (await stageEnv.expectRpc("submit-result")) as unknown as {
    ok: boolean;
    sceneId?: string;
  };
  expect(submittedB.ok).toBe(true);
  const sceneB = submittedB.sceneId ?? "";
  // 等待被打断场景到 scheduled（已 durable 提交、目标时刻 +400ms）。
  // 打断测量的是取消链路预算：字幕行的撤下（stop→remove）即观测点，
  // 无需等待生效——打断完全可能早于生效时刻（late 语义）。
  await page.waitForFunction(
    (scene) =>
      (window.__bellisStage?.sceneEvents() ?? []).some(
        (event) => event.sceneId === scene && event.state === "scheduled",
      ),
    sceneB,
    { timeout: 30_000 },
  );
  await page.evaluate(() => {
    const container = document.querySelector(".stage-subtitle");
    if (container === null) {
      throw new Error("subtitle container missing");
    }
    const observer = new MutationObserver(() => {
      const visible = [...container.querySelectorAll(".stage-subtitle-line")].filter(
        (node) => !(node as HTMLElement).hidden,
      );
      if (visible.length === 0) {
        (window as { __bellisSubtitleHiddenAt?: number }).__bellisSubtitleHiddenAt =
          performance.now();
        observer.disconnect();
      }
    });
    observer.observe(container, { attributes: true, childList: true, subtree: true });
  });
  const interruptAt = await page.evaluate(() => performance.now());
  stageEnv.rpc({ type: "interrupt", reason: "e2e_interrupt" });
  const settledB = (await stageEnv.expectRpc("scene-settled", 30_000)) as unknown as {
    state: string;
  };
  expect(settledB.state).toBe("cancelled");
  const hiddenAt = await page.evaluate(
    () => (window as { __bellisSubtitleHiddenAt?: number }).__bellisSubtitleHiddenAt ?? -1,
  );
  expect(hiddenAt).toBeGreaterThan(0);
  const interruptLatencyMs = hiddenAt - interruptAt;
  // 100ms 预算 + MutationObserver 微任务观测余量。
  expect(interruptLatencyMs).toBeLessThanOrEqual(150);
  console.info(`interruptLatencyMs=${interruptLatencyMs.toFixed(2)}(browser, budget=100+slack)`);

  // 打断后：被打断 Scene 的媒体帧停止累积。
  const beforeFrames = await page.evaluate(
    (scene) => window.__bellisStage?.bufferedFrames()[scene] ?? 0,
    sceneB,
  );
  await page.waitForTimeout(200);
  const afterFrames = await page.evaluate(
    (scene) => window.__bellisStage?.bufferedFrames()[scene] ?? 0,
    sceneB,
  );
  expect(afterFrames).toBe(beforeFrames);
});
