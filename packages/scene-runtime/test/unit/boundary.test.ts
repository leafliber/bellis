import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 依赖边界扫描（docs/archive/phase-2/development-guide.md §4 / §6.4）：
 *
 * - scene-runtime 不依赖 Fastify、WebSocket、SQLite、React 或浏览器 API；
 *   src 导入只允许 @bellis/contracts、@bellis/observability 与相对路径。
 * - @bellis/testkit 只出现在 devDependencies。
 * - 包根只从 index.ts 暴露公开 API；测试不导入其他包的 src 私有路径。
 */

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

describe("scene-runtime 依赖边界", () => {
  it("src 内外部依赖只允许 contracts/observability", () => {
    const files = ["index.ts", "compiler/action-compiler.ts", "director/scene-director.ts"];
    const allowed = new Set(["@bellis/contracts", "@bellis/observability"]);
    for (const file of files) {
      const source = readFileSync(join(packageRoot, "src", file), "utf8");
      for (const match of source.matchAll(/from\s+["']([^"']+)["']/g)) {
        const specifier = match[1] ?? "";
        if (!specifier.startsWith(".")) {
          expect(allowed.has(specifier), `${file} → ${specifier}`).toBe(true);
        }
      }
    }
  });

  it("src 不引用 Node/浏览器专用模块与全局", () => {
    const files = [
      "compiler/action-compiler.ts",
      "compiler/anchors.ts",
      "compiler/policy.ts",
      "compiler/issues.ts",
      "compiler/plan-validator.ts",
      "director/barrier.ts",
      "director/ports.ts",
      "director/scene-director.ts",
      "timeline/cue-targets.ts",
      "index.ts",
    ];
    for (const file of files) {
      const source = readFileSync(join(packageRoot, "src", file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|\s)\/\/[^\n]*/g, "$1");
      expect(/\bnode:/.test(source), file).toBe(false);
      expect(/\bBuffer\b/.test(source), file).toBe(false);
      expect(/\bprocess\b/.test(source), file).toBe(false);
      expect(/\bWebSocket\b|\bfetch\(/.test(source), file).toBe(false);
    }
  });

  it("testkit 只在 devDependencies", () => {
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(manifest.dependencies?.["@bellis/testkit"]).toBeUndefined();
    expect(manifest.devDependencies?.["@bellis/testkit"]).toBe("workspace:*");
    expect(manifest.dependencies?.["@bellis/contracts"]).toBe("workspace:*");
    expect(manifest.dependencies?.["@bellis/observability"]).toBe("workspace:*");
    expect(Object.keys(manifest.dependencies ?? {}).length).toBe(2);
  });
});
