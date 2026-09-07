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
 * 5. 真实完成信号（不是「开始即完成」）：
 *    - 运行时长（running→finished）接近语音时长（8 CJK ≈ 2.16s）；
 *    - 字幕实际可见一段时间（显示 → 发言结束撤下）；
 *    - Commit 后音频能量：AnalyserNode RMS 采样证明 PCM 真实持续出声；
 * 6. 紧急打断：MutationObserver 计量字幕撤下时延（100ms 预算 + 观测
 *    余量），打断后被打断 Scene 的媒体帧不再累积。
 */

const SPEECH_TEXT = "浏览器端到端验证";
/**
 * Fake Model 固定发言文本「我看看现在的任务进度」（10 CJK × 240ms +
 * 240ms 尾静音 = 2640ms = 132 帧；Fake TTS 冻结合成规则）。submit 携带
 * 的 text 只是 Signal 载荷，不改变 Fixture 发言内容。
 */
const SPEECH_EXPECTED_MS = 2_640;

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
  const mediaStats = diagnostics.mediaStats as {
    acceptedFrames: number;
    rejectedFrames: number;
  } | null;
  expect(mediaStats?.acceptedFrames ?? 0).toBeGreaterThanOrEqual(6);
  expect(mediaStats?.rejectedFrames ?? 0).toBe(0);
  // underruns ≤ 8：缓冲占用按未播执行的修复后，完整语音（含 >2s 长音频）
  // 预缓冲垫层全程保持，实测 0——历史缺陷（累计写入判容量 → 第 100 帧
  // 起截断）曾以 82 次欠载的形式暴露（截断饿死播放），该界即回归防线。
  expect(diagnostics.underruns).toBeLessThanOrEqual(8);

  // 4. 硬同步偏差：各 Lane startedAtStageUs − targetLocalUs ≤ 50ms。
  const skewsMs = laneStarts.map(
    (start) => Number(BigInt(start.startedAtStageUs) - BigInt(start.targetLocalUs)) / 1000,
  );
  console.info(`laneStartEvidence=${JSON.stringify(laneStarts)}`);
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

  // 5. 真实完成信号：运行时长、字幕可见区间、Commit 后音频能量。
  const presentation = await page.evaluate((scene) => {
    const events = (window.__bellisStage?.sceneEvents() ?? []).filter(
      (event) => event.sceneId === scene,
    );
    const interval = (window.__bellisStage?.subtitleIntervals() ?? []).find(
      (entry) => entry.sceneId === scene,
    );
    return {
      runningAt: events.find((event) => event.state === "running")?.at ?? 0,
      finishedAt: events.find((event) => event.state === "finished")?.at ?? 0,
      interval,
      energy: window.__bellisStage?.audioEnergy() ?? [],
    };
  }, sceneId);
  // 运行时长 ≈ 语音时长（± 宽松界：低于下界 = 完成信号是假的）。
  const runMs = presentation.finishedAt - presentation.runningAt;
  expect(runMs).toBeGreaterThanOrEqual(SPEECH_EXPECTED_MS - 800);
  expect(runMs).toBeLessThanOrEqual(SPEECH_EXPECTED_MS + 2_000);
  // 字幕真实可见区间（显示 → 发言结束撤下，非瞬时）。
  expect(presentation.interval).toBeDefined();
  const interval = presentation.interval as {
    shownAtUs: string;
    hiddenAtUs: string | null;
  };
  expect(interval.hiddenAtUs).not.toBeNull();
  const visibleMs =
    Number(BigInt(interval.hiddenAtUs as string) - BigInt(interval.shownAtUs)) / 1000;
  expect(visibleMs).toBeGreaterThanOrEqual(SPEECH_EXPECTED_MS - 800);
  expect(visibleMs).toBeLessThanOrEqual(SPEECH_EXPECTED_MS + 2_000);
  // Commit 后音频能量：真实出声（RMS > 1e-3）覆盖语音主体。
  const audioStart = laneStarts.find((start) => start.lane === "audio");
  expect(audioStart).toBeDefined();
  const audioStartMs = Number(BigInt((audioStart as LaneStart).startedAtStageUs)) / 1000;
  const loudSamples = presentation.energy.filter(
    (sample: { at: number; rms: number }) =>
      sample.at >= audioStartMs &&
      sample.at <= audioStartMs + SPEECH_EXPECTED_MS + 500 &&
      sample.rms > 1e-3,
  );
  expect(loudSamples.length).toBeGreaterThanOrEqual(20); // ≥ 1s 真实输出（50ms 采样）
  console.info(
    `presentation=real(runMs=${runMs}, visibleMs=${visibleMs.toFixed(0)}, loudSamples=${loudSamples.length})`,
  );

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
  // Gate 预算 100ms：MutationObserver 为微任务级观测，不另给松弛。
  expect(interruptLatencyMs).toBeLessThanOrEqual(100);
  console.info(`interruptLatencyMs=${interruptLatencyMs.toFixed(2)}(browser, budget=100)`);

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

  // 6. Stream 槽位马拉松：连续 9 场演出（超过 Stage Registry 并发上限
  // 8）——每场 media.stream.closed 释放槽位后第 9 场仍可 announce/ready，
  // 全部完成且零拒绝帧（sequence 严格连续的直接证据）。
  const marathonStart = Date.now();
  for (let i = 0; i < 9; i += 1) {
    stageEnv.rpc({
      type: "submit",
      cycleId: randomUUID(),
      traceId: randomUUID().replaceAll("-", "").slice(0, 32),
      text: "连续演出",
    });
    const submittedN = (await stageEnv.expectRpc("submit-result", 30_000)) as unknown as {
      ok: boolean;
      sceneId?: string;
    };
    expect(submittedN.ok).toBe(true);
    const sceneN = submittedN.sceneId ?? "";
    await page.waitForFunction(
      (scene) =>
        (window.__bellisStage?.sceneEvents() ?? []).some(
          (event) => event.sceneId === scene && event.state === "finished",
        ),
      sceneN,
      { timeout: 30_000 },
    );
    const settledN = (await stageEnv.expectRpc("scene-settled", 30_000)) as unknown as {
      state: string;
    };
    expect(settledN.state).toBe("completed");
  }
  const marathonStats = await page.evaluate(() => ({
    openedStreams: window.__bellisStage?.mediaStats()?.openedStreams ?? 0,
    rejectedFrames: window.__bellisStage?.mediaStats()?.rejectedFrames ?? -1,
    underruns: window.__bellisStage?.underruns() ?? -1,
  }));
  expect(marathonStats.rejectedFrames).toBe(0);
  expect(marathonStats.openedStreams).toBeGreaterThanOrEqual(11);
  console.info(
    `streamMarathon=ok(scenes=9+, opened=${marathonStats.openedStreams}, rejected=0, ${Date.now() - marathonStart}ms)`,
  );
});
