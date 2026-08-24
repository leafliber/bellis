import type { Cue, CueLane } from "@bellis/contracts";
import type { LanePrepareResult, StageLaneAdapter } from "../lane-registry.js";

/**
 * 字幕 Lane（docs/phase-2-development-guide.md §8.3）。
 *
 * - 文本直接来自同一 SpeechIntent（Cue intent.speechRef → plan.speech，
 *   调用方传入文本；Lane 不做任何文本生成）；
 * - DOM 内容使用文本节点（textContent），模型文本绝不进入 innerHTML；
 * - Commit 前（prepare 阶段）只暂存不可见；start 显示、stop 在预算内
 *   撤下且只撤目标 Scene；
 * - DOM 环境 Port 注入：Node 测试用 Fake 验证可见性/文本/顺序。
 */

export interface SubtitleDocument {
  createLine(sceneId: string): SubtitleLine;
}

export interface SubtitleLine {
  setText(text: string): void;
  setVisible(visible: boolean): void;
  remove(): void;
}

export class SubtitleLaneAdapter implements StageLaneAdapter {
  readonly lane: CueLane = "subtitle";
  readonly #document: SubtitleDocument;
  readonly #lines = new Map<
    string,
    { line: SubtitleLine; text: string | null; visible: boolean }
  >();
  #closed = false;

  constructor(document: SubtitleDocument) {
    this.#document = document;
  }

  /** Scene 的字幕文本（由 SceneClient 装配层从 plan.speech 传入；可先于
   * prepare 到达——行不存在时先创建不可见行，Commit 前绝不显示）。 */
  setSpeechText(sceneId: string, text: string): void {
    let record = this.#lines.get(sceneId);
    if (record === undefined) {
      const line = this.#document.createLine(sceneId);
      line.setVisible(false);
      record = { line, text: null, visible: false };
      this.#lines.set(sceneId, record);
    }
    if (!record.visible) {
      record.text = text;
      record.line.setText(text);
    }
  }

  async prepare(
    sceneId: string,
    _cues: readonly Cue[],
    _signal: AbortSignal,
  ): Promise<LanePrepareResult> {
    if (this.#closed) {
      return { ready: false, reason: "prepare_failed" };
    }
    // 只创建不可见文本行（Prepare 不生效）。
    if (!this.#lines.has(sceneId)) {
      const line = this.#document.createLine(sceneId);
      line.setVisible(false);
      this.#lines.set(sceneId, { line, text: null, visible: false });
    }
    return { ready: true };
  }

  async start(sceneId: string, _atStageUs: bigint, _cues: readonly Cue[]): Promise<void> {
    const record = this.#lines.get(sceneId);
    if (record === undefined) {
      return;
    }
    record.visible = true;
    record.line.setVisible(true);
  }

  async stop(sceneId: string, _reason: string): Promise<void> {
    this.#remove(sceneId);
  }

  async finish(sceneId: string): Promise<void> {
    this.#remove(sceneId);
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    for (const sceneId of Array.from(this.#lines.keys())) {
      this.#remove(sceneId);
    }
  }

  #remove(sceneId: string): void {
    const record = this.#lines.get(sceneId);
    if (record === undefined) {
      return;
    }
    this.#lines.delete(sceneId);
    record.line.setVisible(false);
    record.line.remove();
  }
}
