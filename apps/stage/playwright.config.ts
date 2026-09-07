import { defineConfig } from "@playwright/test";

/**
 * 浏览器 E2E（docs/archive/phase-2/development-guide.md §10；Gate 2 硬性前置）：
 * 真实 Chromium + 真实 Vite dev server + 真实 Runtime 子进程 +
 * 真实 AudioContext/AudioWorklet（用户手势 Arm）。
 * 环境由 test/browser/fixtures.ts 全局装配（端口/RPC 均动态协商）。
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
