import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BrowserMonotonicClock,
  ClockOffsetEstimator,
  decodeControlMessage,
  encodeMediaFrame,
  MediaFrameParser,
} from "../../src/browser/index.js";

/**
 * 浏览器边界静态扫描（Phase 2 Browser Bundle Spike，ADR 0003）：
 *
 * 1. 从 src/browser/index.ts 出发收集全部相对导入可达文件；
 * 2. 可达文件的外部依赖只允许 @bellis/contracts（纯 Zod）；
 *    @bellis/observability 包根经 barrel 传递 node:crypto/pino，禁止进入；
 * 3. 可达文件源码不得出现 node: 说明符、Buffer/process/require 等
 *    Node-only 全局引用（注释先剥离，避免文档用词误报）；
 * 4. Node-only 模块（SystemMonotonicClock、ControlSession）不在可达集合。
 *
 * 该测试与真实打包工具（P2 Vite）互补：包级 exports 的 "./browser" 子路径
 * 保证 Bundler 解析面即本入口；本扫描把约束固化进 CI，不依赖打包配置。
 */

const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../src");

const IMPORT_PATTERN =
  /(?:^|\n)\s*(?:(?:import|export)\s+[^;('"]*?from|import)\s+["']([^"']+)["']/g;

function stripComments(source: string): string {
  // 足够用于本包的粗剥离：块注释与行注释；字符串内的 "//"（URL）只会
  // 让该行检查变弱，不会产生误报。
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");
}

function collectReachableFiles(entryRelative: string): Map<string, string> {
  const files = new Map<string, string>();
  const queue = [entryRelative];
  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined || files.has(current)) {
      continue;
    }
    const fullPath = join(srcRoot, current);
    const source = readFileSync(fullPath, "utf8");
    files.set(current, source);
    const stripped = stripComments(source);
    for (const match of stripped.matchAll(IMPORT_PATTERN)) {
      const specifier = match[1];
      if (specifier === undefined) {
        continue;
      }
      if (specifier.startsWith(".")) {
        // 相对导入指向 .ts 源文件（源内以 .js 结尾，nodenext 风格）。
        const target = specifier.replace(/\.js$/, ".ts");
        queue.push(join(dirname(current), target));
      }
    }
  }
  return files;
}

const browserGraph = collectReachableFiles("browser/index.ts");
const nodeOnlyModules = [
  "clock/system-monotonic-clock.ts",
  "control/control-session.ts",
  "index.ts",
];

describe("browser entry dependency graph", () => {
  it("reaches the expected browser-safe modules", () => {
    const reachable = [...browserGraph.keys()].toSorted();
    expect(reachable).toContain("browser/index.ts");
    expect(reachable).toContain("control/codec.ts");
    expect(reachable).toContain("media/frame-codec.ts");
    expect(reachable).toContain("media/incremental-parser.ts");
    expect(reachable).toContain("clock/browser-monotonic-clock.ts");
    expect(reachable).toContain("clock/offset-estimator.ts");
  });

  it("excludes Node-only modules (SystemMonotonicClock / ControlSession / package root)", () => {
    for (const forbidden of nodeOnlyModules) {
      expect(browserGraph.has(forbidden), forbidden).toBe(false);
    }
  });

  it("only depends on @bellis/contracts externally", () => {
    for (const [file, source] of browserGraph) {
      for (const match of source.matchAll(IMPORT_PATTERN)) {
        const specifier = match[1] ?? "";
        if (specifier.startsWith(".")) {
          continue;
        }
        expect(specifier, `${file} imports ${specifier}`).toBe("@bellis/contracts");
      }
    }
  });

  it("contains no node: specifiers or Node-only globals in reachable sources", () => {
    const banned = [/\bnode:/, /\bBuffer\b/, /\bprocess\b/, /\brequire\s*\(/];
    for (const [file, source] of browserGraph) {
      const stripped = stripComments(source);
      for (const pattern of banned) {
        expect(pattern.test(stripped), `${file} matches ${String(pattern)}`).toBe(false);
      }
    }
  });
});

describe("browser entry runtime smoke", () => {
  it("clock is monotonic within a process and closable", async () => {
    const clock = new BrowserMonotonicClock();
    const first = clock.nowUs();
    const second = clock.nowUs();
    expect(second).toBeGreaterThanOrEqual(first);
    await clock.sleepUntil(first); // 已过目标立即完成
    clock.close();
    await expect(clock.sleepUntil(first + 1000n)).rejects.toThrow(/browser_monotonic_clock_closed/);
  });

  it("offset estimator and codecs work from the browser entry", () => {
    const estimator = new ClockOffsetEstimator();
    // RTT = (c3-c0) - (r2-r1) = 250 - 50 = 200µs。
    const estimate = estimator.add({ c0: 0n, r1: 100n, r2: 150n, c3: 250n });
    expect(estimate?.roundTripUs).toBe(200n);

    const decoded = decodeControlMessage(
      JSON.stringify({
        version: 1,
        direction: "client",
        type: "media.stream.ready",
        messageId: "88888888-8888-4888-8888-888888888888",
        sessionId: "11111111-1111-4111-8111-111111111111",
        trace: { traceId: "0123456789abcdef0123456789abcdef" },
        sentAtUs: "1",
        payload: { streamId: "99999999-9999-4999-8999-999999999999" },
      }),
    );
    expect(decoded.ok).toBe(true);

    const frame = encodeMediaFrame({
      header: {
        schemaVersion: 1,
        streamId: "99999999-9999-4999-8999-999999999999",
        frameId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        sessionId: "11111111-1111-4111-8111-111111111111",
        sequence: "0",
        contentType: "audio/pcm-s16le-48000-mono",
        traceId: "0123456789abcdef0123456789abcdef",
      },
      payload: new Uint8Array([0, 0]),
      mediaKind: "audio",
    });
    const parser = new MediaFrameParser();
    parser.push(frame);
    const frames = parser.endMessage();
    expect(frames[0]?.mediaKind).toBe("audio");
  });
});
