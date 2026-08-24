import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist-web",
    // Stage 只从 @bellis/transport 的浏览器安全入口引用传输能力，
    // 禁止把 Node-only 模块（SystemMonotonicClock/ControlSession）打进包。
    rollupOptions: {
      input: "index.html",
    },
  },
});
