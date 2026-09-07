import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Stage 构建（docs/archive/phase-2/development-guide.md §10）：
 * - base=/stage/：Runtime 静态托管（phase2.stageDistDir）以 /stage 挂载，
 *   资源与 Worklet 均落在同一前缀下；
 * - dev 代理：BELLIS_RUNTIME_PROXY=http://127.0.0.1:PORT 时把 /api 与
 *   /ws 转发到 Runtime（E2E 走 Vite 源码路径；Cookie/Origin 同源）。
 */
const runtimeProxyEnv = process.env.BELLIS_RUNTIME_PROXY;
// 接受完整 URL 或 host:port。
const runtimeProxy = runtimeProxyEnv?.includes("://")
  ? runtimeProxyEnv
  : runtimeProxyEnv === undefined
    ? undefined
    : `http://${runtimeProxyEnv}`;

export default defineConfig({
  plugins: [react()],
  base: "/stage/",
  server:
    runtimeProxy === undefined
      ? {}
      : {
          proxy: {
            "/api": { target: runtimeProxy, changeOrigin: true },
            "/ws": {
              target: runtimeProxy.replace(/^http/, "ws"),
              ws: true,
            },
          },
        },
  build: {
    outDir: "dist-web",
    // Stage 只从 @bellis/transport 的浏览器安全入口引用传输能力，
    // 禁止把 Node-only 模块（SystemMonotonicClock/ControlSession）打进包。
    rollupOptions: {
      input: "index.html",
    },
  },
});
