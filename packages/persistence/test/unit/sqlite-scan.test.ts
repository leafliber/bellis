import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 静态边界扫描（P2 文档 §5.2）：packages/persistence/src 中
 * worker/ 目录外不允许出现 node:sqlite 导入；client/ 与 outbox/
 * 不允许依赖 worker/ 内部模块（会把 node:sqlite 拖进主线程）。
 */

const SRC_ROOT = join(import.meta.dirname, "..", "..", "src");

function listFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(path));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(path);
    }
  }
  return files;
}

function relative(path: string): string {
  return path.slice(SRC_ROOT.length + 1);
}

describe("node:sqlite Worker 边界静态扫描", () => {
  const files = listFiles(SRC_ROOT);

  it("src 下存在待扫描文件", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it("worker/ 目录外没有 node:sqlite 导入", () => {
    const offenders = files.filter((path) => {
      if (relative(path).startsWith("worker/")) {
        return false;
      }
      return /from\s+["']node:sqlite["']|require\(["']node:sqlite["']\)/.test(
        readFileSync(path, "utf8"),
      );
    });
    expect(offenders.map(relative)).toEqual([]);
  });

  it("worker/ 内只有 database.ts 导入 node:sqlite", () => {
    const offenders = files.filter((path) => {
      if (!relative(path).startsWith("worker/")) {
        return false;
      }
      if (relative(path) === "worker/database.ts") {
        return false;
      }
      return /from\s+["']node:sqlite["']/.test(readFileSync(path, "utf8"));
    });
    expect(offenders.map(relative)).toEqual([]);
  });

  it("client/ 与 outbox/ 不依赖 worker/ 内部模块", () => {
    const offenders = files.filter((path) => {
      const rel = relative(path);
      if (!rel.startsWith("client/") && !rel.startsWith("outbox/")) {
        return false;
      }
      return /from\s+["']\.\.\/worker\//.test(readFileSync(path, "utf8"));
    });
    expect(offenders.map(relative)).toEqual([]);
  });

  it("src 内没有动态 SQL 通道（eval/拼接执行不受支持，接口闭合）", () => {
    const offenders = files.filter((path) => {
      const text = readFileSync(path, "utf8");
      return /exec\s*\(\s*`[^`]*\$\{/m.test(text) && relative(path).startsWith("repositories/");
    });
    expect(offenders.map(relative)).toEqual([]);
  });
});
