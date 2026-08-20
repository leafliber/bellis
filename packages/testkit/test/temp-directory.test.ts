import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTempDataDirectory, isSafeCleanupTarget } from "../src/index.js";

describe("createTempDataDirectory", () => {
  it("creates a unique directory inside the system temp dir and cleans up", () => {
    const dir = createTempDataDirectory();
    // macOS 上 tmpdir 是 /var/...，realpath 为 /private/var/...；目录以 realpath 创建。
    const realTempRoot = realpathSync(tmpdir());
    expect(dir.path.startsWith(join(realTempRoot, "bellis-testkit-"))).toBe(true);
    expect(existsSync(dir.path)).toBe(true);
    writeFileSync(join(dir.path, "state.db"), "x");
    dir.cleanup();
    expect(existsSync(dir.path)).toBe(false);
  });

  it("creates unique paths per call and accepts a custom prefix", () => {
    const first = createTempDataDirectory("bellis-custom-");
    const second = createTempDataDirectory("bellis-custom-");
    expect(first.path).not.toBe(second.path);
    expect(first.path).toContain("bellis-custom-");
    first.cleanup();
    second.cleanup();
  });

  it("cleanup is idempotent, even when the directory vanished earlier", () => {
    const dir = createTempDataDirectory();
    rmSync(dir.path, { recursive: true, force: true });
    expect(() => dir.cleanup()).not.toThrow();
    expect(() => dir.cleanup()).not.toThrow();
    dir.cleanup();
  });

  it("cleanup removes nested content", () => {
    const dir = createTempDataDirectory();
    mkdirSync(join(dir.path, "deep", "deeper"), { recursive: true });
    writeFileSync(join(dir.path, "deep", "deeper", "telemetry.db"), "y");
    dir.cleanup();
    expect(existsSync(dir.path)).toBe(false);
  });

  it("rejects prefixes that could escape the temp root", () => {
    expect(() => createTempDataDirectory("../evil-")).toThrow(RangeError);
    expect(() => createTempDataDirectory("a/b")).toThrow(RangeError);
    expect(() => createTempDataDirectory("a\\b")).toThrow(RangeError);
    expect(() => createTempDataDirectory("")).toThrow(RangeError);
  });

  it("refuses unsafe cleanup targets", () => {
    const root = tmpdir();
    expect(isSafeCleanupTarget(root, root)).toBe(false);
    expect(isSafeCleanupTarget("/", root)).toBe(false);
    expect(isSafeCleanupTarget(homedir(), root)).toBe(false);
    expect(isSafeCleanupTarget(process.cwd(), root)).toBe(false);
    expect(isSafeCleanupTarget("", root)).toBe(false);
    expect(isSafeCleanupTarget(join("/private", "elsewhere"), root)).toBe(false);
    const safe = createTempDataDirectory();
    expect(isSafeCleanupTarget(safe.path, root)).toBe(true);
    safe.cleanup();
  });
});
