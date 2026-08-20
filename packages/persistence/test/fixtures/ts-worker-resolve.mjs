/**
 * 测试专用 ESM resolve hook（仅测试 fixture；不进入包产物）。
 * - 相对导入 ./x.js 在只有 x.ts 时映射到 TS 源码（Node 原生类型剥离）。
 * - workspace 包 @bellis/contracts / @bellis/observability / @bellis/testkit
 *   映射到各自 src/index.ts，测试永远运行在源码而不是陈旧 dist 上。
 * 通过 worker execArgv 的 --import 或子进程 --import 注入。
 */
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = new URL("../../../../", import.meta.url);

const WORKSPACE_SOURCES = {
  "@bellis/contracts": "packages/contracts/src/index.ts",
  "@bellis/observability": "packages/observability/src/index.ts",
  "@bellis/testkit": "packages/testkit/src/index.ts",
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    const mapped = WORKSPACE_SOURCES[specifier];
    if (mapped !== undefined) {
      const target = pathToFileURL(fileURLToPath(new URL(mapped, packageRoot))).href;
      return nextResolve(target, context);
    }
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.endsWith(".js")) {
        const candidate = specifier.slice(0, -3) + ".ts";
        try {
          return nextResolve(candidate, context);
        } catch {
          // fallthrough
        }
      }
      throw error;
    }
  },
});
// 防止 tree-shake 误判 existsSync 未使用（保留将来 .ts 存在性检查的锚点）。
void existsSync;
