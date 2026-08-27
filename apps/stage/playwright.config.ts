import { defineConfig } from "@playwright/test";

/**
 * 浏览器 E2E（docs/phase-2-development-guide.md §10；Gate 2 硬性前置）：
 * 真实 Chromium + 真实 Vite dev server + 真实 Runtime 子进程 +
 * 真实 AudioContext/AudioWorklet（用户手势 Arm）。
 * 环境由 test/browser/fixtures.ts 全局装配（端口/RPC 均动态协商）。
 *
 * headless 下输出 sink 以自身节奏拉动渲染线程（启动追平会瞬时耗尽
 * 预缓冲垫层，随后按到达前沿播放；实测耗尽速率 ≈1.19× 墙钟）。播放
 * 完成信号（Worklet 耗尽）、能量采样与时长断言在 headless 下均有效；
 * 逐量子的 underruns 硬预算属真实输出设备节奏，保留给 P5 真机手工
 * Smoke（E2E 只做饥饿崩溃检测界，见 stage-e2e.test.ts）。
 */
export default defineConfig({
  testDir: "test/browser",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    headless: true,
    trace: "off",
  },
});
