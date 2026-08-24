import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MediaFrameError, MediaFrameParser, decodeControlMessage } from "../../src/index.js";

/**
 * 协议文档一致性测试（docs/phase-1-reference.md）：
 * docs/protocols/*.md 中带 `control-envelope` / `media-frame` 标注的代码块
 * 会按其 valid/invalid 语义自动校验，防止文档成为未经测试的协议副本。
 */

const DOCS_DIR = join(
  dirname(dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))),
  "docs",
  "protocols",
);

interface FencedBlock {
  readonly info: string;
  readonly body: string;
}

function extractFences(markdown: string): FencedBlock[] {
  const blocks: FencedBlock[] = [];
  const pattern = /^```([^\n`]*)\n([\s\S]*?)^```$/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(markdown)) !== null) {
    blocks.push({ info: match[1] ?? "", body: (match[2] ?? "").trimEnd() });
  }
  return blocks;
}

function readDoc(name: string): FencedBlock[] {
  return extractFences(readFileSync(join(DOCS_DIR, name), "utf8"));
}

describe("协议文档示例与实现一致", () => {
  it("control-websocket.md：全部 control-envelope 示例按标注语义通过/失败", () => {
    const blocks = readDoc("control-websocket.md").filter((block) =>
      block.info.includes("control-envelope"),
    );
    expect(blocks.length).toBeGreaterThanOrEqual(4);
    for (const block of blocks) {
      const expectValid = block.info.includes("valid") && !block.info.includes("invalid");
      const result = decodeControlMessage(block.body);
      expect(
        result.ok,
        `${block.info}: ${result.ok ? "" : JSON.stringify(result.ok ? null : (result as { failure: unknown }).failure)}`,
      ).toBe(expectValid);
    }
  });

  it("scene-execution.md：全部 control-envelope 示例按标注语义通过/失败（Phase 2）", () => {
    const blocks = readDoc("scene-execution.md").filter((block) =>
      block.info.includes("control-envelope"),
    );
    expect(blocks.length).toBeGreaterThanOrEqual(4);
    for (const block of blocks) {
      const expectValid = block.info.includes("valid") && !block.info.includes("invalid");
      const result = decodeControlMessage(block.body);
      expect(
        result.ok,
        `${block.info}: ${result.ok ? "" : JSON.stringify(result.ok ? null : (result as { failure: unknown }).failure)}`,
      ).toBe(expectValid);
      if (result.ok) {
        // Phase 2 文档示例覆盖命令（runtime→stage=server）与回执（stage→runtime=client）。
        expect(["server", "client"]).toContain(result.value.direction);
      }
    }
  });

  it("binary-media-websocket.md：全部 media-frame 十六进制示例按标注语义解析", () => {
    const blocks = readDoc("binary-media-websocket.md").filter((block) =>
      block.info.includes("media-frame"),
    );
    expect(blocks.length).toBeGreaterThanOrEqual(3);
    for (const block of blocks) {
      const expectValid = block.info.includes("valid") && !block.info.includes("invalid");
      // 标注后缀声明期望的 media kind（缺省 binary-test；Phase 2 音频帧标注 audio）。
      const expectedKind = block.info.includes("audio") ? "audio" : "binary-test";
      const bytes = Buffer.from(block.body.replace(/\s+/g, ""), "hex");
      const parser = new MediaFrameParser();
      try {
        parser.push(bytes);
        const frames = parser.endMessage();
        expect(frames.length, block.info).toBe(1);
        if (!expectValid) {
          throw new Error(`${block.info} 应当解析失败`);
        }
        const frame = frames[0];
        expect(frame?.header.schemaVersion).toBe(1);
        expect(frame?.mediaKind).toBe(expectedKind);
      } catch (error) {
        if (expectValid) {
          throw error;
        }
        expect(error, block.info).toBeInstanceOf(MediaFrameError);
      }
    }
  });

  it("三份文档都存在且非空", () => {
    for (const name of [
      "control-websocket.md",
      "binary-media-websocket.md",
      "scene-execution.md",
    ]) {
      expect(readDoc(name).length).toBeGreaterThan(0);
    }
  });
});
