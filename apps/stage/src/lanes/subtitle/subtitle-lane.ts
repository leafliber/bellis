import type { Cue, CueLane, MonotonicClock } from "@bellis/contracts";
import type { LanePrepareResult, StageLaneAdapter } from "../lane-registry.js";

/**
 * 字幕 Lane（docs/archive/phase-2/development-guide.md §8.3）。
 *
 * - 文本直接来自同一 SpeechIntent（Cue intent.speechRef → plan.speech，
 *   调用方传入文本；Lane 不做任何文本生成）；
 * - DOM 内容使用文本节点（textContent），模型文本绝不进入 innerHTML；
 * - Commit 前（prepare 阶段）只暂存不可见；start 显示；
 * - start() 的 Promise 在字幕**真实撤下**时兑现：endOfSpeech 携带发言
 *   结束的本地时刻（media.stream.closed 边界推导），到点隐藏；永不
 *  到达时以可见性上限兜底（有界等待）；stop/finish 立即撤下；
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

/** 已结束 Scene 的可见区间（诊断/E2E 断言：字幕实际可见的时长）。 */
export interface SubtitleVisibleInterval {
  readonly sceneId: string;
  readonly shownAtUs: bigint;
  readonly hiddenAtUs: bigint | null;
}

export interface SubtitleLaneOptions {
  readonly onApplied?: (event: {
    sceneId: string;
    start: number;
    end: number;
    appliedAtStageUs: bigint;
  }) => void;
  readonly document: SubtitleDocument;
  /** 单调时钟（定时撤下与可见性上限兜底）。 */
  readonly clock: MonotonicClock;
  /** 可见性上限（微秒，默认 30s）：endOfSpeech 永不到达时的有界兜底。 */
  readonly maxVisibleUs?: bigint;
}

interface SubtitleRecord {
  readonly line: SubtitleLine;
  text: string | null;
  visible: boolean;
  /** 生效（Commit 映射）目标时刻——发言时长的锚点。 */
  startTargetUs: bigint | null;
  shownAtUs: bigint | null;
  hiddenAtUs: bigint | null;
  /** 先于 start 到达的发言时长（closed 先于 commit 的乱序场景）。 */
  pendingDurationUs: bigint | null;
  completions: Array<() => void>;
  timers: AbortController[];
}

/** 兜底默认：endOfSpeech 丢失时的最大可见时长（连接代际变化会先行 stop）。 */
const DEFAULT_MAX_VISIBLE_US = 30_000_000n;
/** 已结束 Scene 的可见区间诊断环形上限。 */
const INTERVAL_HISTORY = 32;

export class SubtitleLaneAdapter implements StageLaneAdapter {
  readonly lane: CueLane = "subtitle";
  readonly #document: SubtitleDocument;
  readonly #onApplied: SubtitleLaneOptions["onApplied"];
  readonly #clock: MonotonicClock;
  readonly #maxVisibleUs: bigint;
  readonly #lines = new Map<string, SubtitleRecord>();
  readonly #intervals: SubtitleVisibleInterval[] = [];
  #closed = false;

  constructor(options: SubtitleLaneOptions) {
    this.#document = options.document;
    this.#onApplied = options.onApplied;
    this.#clock = options.clock;
    this.#maxVisibleUs = options.maxVisibleUs ?? DEFAULT_MAX_VISIBLE_US;
  }

  /** Scene 的字幕文本（由 SceneClient 装配层从 plan.speech 传入；可先于
   * prepare 到达——行不存在时先创建不可见行，Commit 前绝不显示）。 */
  setSpeechText(sceneId: string, text: string): void {
    let record = this.#lines.get(sceneId);
    if (record === undefined) {
      const line = this.#document.createLine(sceneId);
      line.setVisible(false);
      record = this.#newRecord(line);
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
      this.#lines.set(sceneId, this.#newRecord(line));
    }
    return { ready: true };
  }

  async start(
    sceneId: string,
    atStageUs: bigint,
    _cues: readonly Cue[],
    onStarted?: (atStageUs?: bigint) => void,
  ): Promise<void> {
    const record = this.#lines.get(sceneId);
    if (record === undefined) {
      return;
    }
    record.visible = true;
    record.startTargetUs = atStageUs;
    record.shownAtUs = this.#clock.nowUs();
    record.line.setVisible(true);
    if (record.text !== null)
      this.#onApplied?.({
        sceneId,
        start: 0,
        end: record.text.length,
        appliedAtStageUs: this.#clock.nowUs(),
      });
    onStarted?.(this.#clock.nowUs());
    // 可见性上限兜底：endOfSpeech 永不到达时也必须有界撤下。
    this.#sleep(record, this.#clock.nowUs() + this.#maxVisibleUs, () => {
      this.#hide(sceneId, record);
    });
    if (record.pendingDurationUs !== null) {
      // 发言结束先于 start 到达（closed 乱序）：按暂存时长撤下。
      const durationUs = record.pendingDurationUs;
      record.pendingDurationUs = null;
      this.#scheduleHide(sceneId, record, durationUs);
    }
    await new Promise<void>((resolve) => {
      record.completions.push(resolve);
    });
  }

  /**
   * 发言结束（media.stream.closed 边界推导的发言总时长）：撤下时刻 =
   * 生效目标时刻 + 时长——**以 Commit 为锚**，不从可见时长中扣除发送
   * 侧预缓冲提前量（Prepare 期间不得产生用户副作用，预缓冲不占用
   * Commit 后的可见时间）。时长不可知 → 立即隐藏（保守撤下优于悬挂）。
   * 先于 start 到达时暂存，由 start 应用。
   */
  endOfSpeech(sceneId: string, speechDurationUs: bigint | null): void {
    const record = this.#lines.get(sceneId);
    if (record === undefined) {
      return;
    }
    if (!record.visible) {
      record.pendingDurationUs = speechDurationUs;
      return;
    }
    this.#scheduleHide(sceneId, record, speechDurationUs);
  }

  #scheduleHide(sceneId: string, record: SubtitleRecord, durationUs: bigint | null): void {
    const anchor = record.startTargetUs ?? record.shownAtUs ?? this.#clock.nowUs();
    const hideAt = durationUs === null ? this.#clock.nowUs() : anchor + durationUs;
    this.#sleep(record, hideAt, () => {
      this.#hide(sceneId, record);
    });
  }

  async stop(sceneId: string, _reason: string): Promise<void> {
    this.#remove(sceneId);
  }

  async finish(sceneId: string): Promise<void> {
    this.#remove(sceneId);
  }

  /** 各 Scene 的可见区间（隐藏后仍保留最近 N 条，供 E2E 断言）。 */
  visibleIntervals(): readonly SubtitleVisibleInterval[] {
    return [...this.#intervals];
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

  #newRecord(line: SubtitleLine): SubtitleRecord {
    return {
      line,
      text: null,
      visible: false,
      startTargetUs: null,
      shownAtUs: null,
      hiddenAtUs: null,
      pendingDurationUs: null,
      completions: [],
      timers: [],
    };
  }

  #hide(sceneId: string, record: SubtitleRecord): void {
    if (!record.visible) {
      return;
    }
    record.visible = false;
    record.hiddenAtUs = this.#clock.nowUs();
    record.line.setVisible(false);
    this.#settle(sceneId, record);
  }

  #remove(sceneId: string): void {
    const record = this.#lines.get(sceneId);
    if (record === undefined) {
      return;
    }
    this.#lines.delete(sceneId);
    if (record.visible) {
      record.visible = false;
      record.hiddenAtUs = this.#clock.nowUs();
      this.#rememberInterval(sceneId, record);
    }
    record.line.setVisible(false);
    record.line.remove();
    this.#settle(sceneId, record);
  }

  #settle(sceneId: string, record: SubtitleRecord): void {
    for (const timer of record.timers.splice(0)) {
      timer.abort(new Error(`subtitle_settled:${sceneId}`));
    }
    this.#rememberInterval(sceneId, record);
    const completions = record.completions;
    record.completions = [];
    for (const resolve of completions) {
      resolve();
    }
  }

  #rememberInterval(sceneId: string, record: SubtitleRecord): void {
    if (record.shownAtUs === null || record.hiddenAtUs === null) {
      return;
    }
    const interval = { sceneId, shownAtUs: record.shownAtUs, hiddenAtUs: record.hiddenAtUs };
    const existing = this.#intervals.findIndex(
      (entry) => entry.sceneId === sceneId && entry.hiddenAtUs === record.hiddenAtUs,
    );
    if (existing !== -1) {
      this.#intervals[existing] = interval;
      return;
    }
    this.#intervals.push(interval);
    while (this.#intervals.length > INTERVAL_HISTORY) {
      this.#intervals.shift();
    }
  }

  #sleep(record: SubtitleRecord, targetUs: bigint, onElapsed: () => void): void {
    const timer = new AbortController();
    record.timers.push(timer);
    void this.#clock.sleepUntil(targetUs, timer.signal).then(
      () => {
        const index = record.timers.indexOf(timer);
        if (index !== -1) {
          record.timers.splice(index, 1);
          onElapsed();
        }
      },
      () => {},
    );
  }
}
