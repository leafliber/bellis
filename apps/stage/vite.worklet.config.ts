import { defineConfig } from "vite";

/**
 * AudioWorklet 处理器独立构建（§8.2）：Worklet 全局作用域加载 ES 模块，
 * 产物必须自包含（PcmSceneBuffer + 处理器），输出固定路径
 * dist-web/worklet/bellis-pcm-scene.js；算法与 Node 测试共用同一 TS 源，
 * 不复制实现。dev 由 Vite 直接服务 TS 源（on-demand 转换）。
 */
export default defineConfig({
  build: {
    outDir: "dist-web/worklet",
    emptyOutDir: true,
    lib: {
      entry: "src/lanes/audio/worklet-processor.ts",
      formats: ["es"],
      fileName: () => "bellis-pcm-scene.js",
    },
  },
});
