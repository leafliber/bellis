import type { Cue, CueLane, MonotonicClock } from "@bellis/contracts";
import type { LanePrepareResult, StageLaneAdapter } from "../lane-registry.js";

/**
 * 音频 Lane 主线程适配器（docs/phase-2-development-guide.md §8.2）。
 *
 * - 浏览器自动播放限制：AudioContext 未成功 resume（未 Arm）时 prepare
 *   返回 audio_not_armed——绝不虚报 Ready；
 * - prepare 等待预缓冲达标（默认 6 帧 = 120ms）才返回 ready：PCM 帧经
 *   Media WS 到达并 appendFrame 送入 Worklet 有界缓冲（缓冲不是生效：
 *   出声只由 start 时的 switch 消息决定）；signal 中止即放弃；
 * - start() 的 Promise 在**播放真实完成**时兑现（不是「已收到」）：
 *   endOfSpeech（media.stream.closed 到达）后经尾帧宽限窗转发 EOS 给
 *   Worklet，Worklet 放完全部样本回报 ended；零帧流在 EOS 即完成；
 *   有界兜底：预期放完时刻 + EOS 宽限（AudioContext 被打断时保证
 *   scene.finished 不悬挂）；
 * - Cancel 在 Worklet 预算内淡出并只清空目标 Scene；
 * - 音频环境经 Port 注入：Node 测试用 Fake 验证消息协议，真实
 *   AudioWorklet 由 P5 Chromium Smoke 验证。
 */

export interface WorkletMessage {
  readonly v: 1;
  readonly op: "frame" | "switch" | "cancel" | "clear" | "error" | "stats" | "end" | "ended";
  readonly sceneId?: string;
  readonly samples?: Int16Array;
  readonly underruns?: number;
  readonly code?: string;
}

/** 浏览器音频环境 Port：生产实现包装 AudioContext + AudioWorkletNode。 */
export interface AudioEnvironment {
  /** Arm：创建并 resume AudioContext；失败（自动播放限制）返回 false。 */
  arm(): Promise<boolean>;
  /** 加载 Worklet 并连接节点（幂等）；未 Arm 时抛错。 */
  ensureNode(): Promise<void>;
  postToWorklet(message: WorkletMessage): void;
  onWorkletMessage(handler: ((message: WorkletMessage) => void) | null): void;
  close(): Promise<void>;
}

export interface AudioLaneOptions {
  readonly environment: AudioEnvironment;
  /** 单调时钟（完成判定的有界等待与兜底截止）。 */
  readonly clock: MonotonicClock;
  /** Ready 前置：已缓冲帧数阈值（默认 6 帧 = 120ms 预缓冲）。 */
  readonly minPreparedFrames?: number;
}

interface AudioScene {
  frames: number;
  /** 已追加样本的预期播放时长（微秒；随帧累加）。 */
  playedUs: bigint;
  waiters: Array<(satisfied: boolean) => void>;
  /** start() 完成回调（播放真实完成 / EOS / 停止时兑现）。 */
  completions: Array<() => void>;
  startedAtUs: bigint | null;
  /** closed 已到达（尾帧宽限窗计时中；期间继续接收尾帧）。 */
  closing: boolean;
  /** EOS 已转发给 Worklet（宽限期过后才置位；此后拒绝追加）。 */
  eos: boolean;
  ended: boolean;
  /** EOS 尾帧宽限窗与完成兜底的等待句柄。 */
  timers: AbortController[];
}

/** EOS 尾帧宽限：closed 先于跨连接尾帧到达时，先等尾帧再标记 Worklet EOS。 */
const EOS_TAIL_GRACE_US = 100_000n;
/** 完成兜底：预期放完时刻之后仍无 ended 回报（音频设备中断等）的宽限。 */
const EOS_COMPLETION_GRACE_US = 1_000_000n;

export class AudioLaneAdapter implements StageLaneAdapter {
  readonly lane: CueLane = "audio";
  readonly #environment: AudioEnvironment;
  readonly #clock: MonotonicClock;
  readonly #minPreparedFrames: number;
  readonly #scenes = new Map<string, AudioScene>();
  /** 已停止 Scene 墓碑：拒绝 Cancel/Media 跨通道乱序到达的尾帧。 */
  readonly #stoppedScenes = new Set<string>();
  #armed = false;
  #underruns = 0;
  #closed = false;

  constructor(options: AudioLaneOptions) {
    this.#environment = options.environment;
    this.#clock = options.clock;
    this.#minPreparedFrames = options.minPreparedFrames ?? 6;
    this.#environment.onWorkletMessage((message) => {
      if (message.op === "stats" && message.underruns !== undefined) {
        this.#underruns = message.underruns;
        return;
      }
      if (message.op === "ended" && typeof message.sceneId === "string") {
        // Worklet 放完全部样本：播放真实完成信号。
        const record = this.#scenes.get(message.sceneId);
        if (record !== undefined) {
          record.ended = true;
          this.#settle(message.sceneId, record);
        }
      }
    });
  }

  get armed(): boolean {
    return this.#armed;
  }

  get underruns(): number {
    return this.#underruns;
  }

  /** 用户手势 Arm 入口（StageApp.armAudio 之后调用）。 */
  async arm(): Promise<boolean> {
    if (this.#closed) {
      return false;
    }
    this.#armed = await this.#environment.arm();
    return this.#armed;
  }

  #sceneOf(sceneId: string): AudioScene {
    const existing = this.#scenes.get(sceneId);
    if (existing !== undefined) {
      return existing;
    }
    const record: AudioScene = {
      frames: 0,
      playedUs: 0n,
      waiters: [],
      completions: [],
      startedAtUs: null,
      closing: false,
      eos: false,
      ended: false,
      timers: [],
    };
    this.#scenes.set(sceneId, record);
    return record;
  }

  async prepare(
    sceneId: string,
    _cues: readonly Cue[],
    signal: AbortSignal,
  ): Promise<LanePrepareResult> {
    if (this.#stoppedScenes.has(sceneId)) {
      return { ready: false, reason: "cancelled" };
    }
    if (!this.#armed) {
      return { ready: false, reason: "audio_not_armed" };
    }
    try {
      await this.#environment.ensureNode();
    } catch {
      return { ready: false, reason: "prepare_failed" };
    }
    const record = this.#sceneOf(sceneId);
    if (record.frames >= this.#minPreparedFrames) {
      return { ready: true };
    }
    const satisfied = await new Promise<boolean>((resolve) => {
      record.waiters.push(resolve);
      signal.addEventListener(
        "abort",
        () => {
          resolve(false);
        },
        { once: true },
      );
    });
    return satisfied
      ? { ready: true }
      : { ready: false, reason: signal.aborted ? "cancelled" : "prebuffer_timeout" };
  }

  /** Media WS 帧到达：送入 Worklet 缓冲（不生效），达标时放行 prepare。 */
  appendFrame(sceneId: string, samples: Int16Array): void {
    if (this.#closed || this.#stoppedScenes.has(sceneId)) {
      return;
    }
    const record = this.#sceneOf(sceneId);
    if (record.eos) {
      // EOS 尾帧宽限窗外的迟到帧：Worklet 已拒绝追加，如实丢弃。
      return;
    }
    record.frames += 1;
    record.playedUs += BigInt(Math.round((samples.length / 48_000) * 1_000_000));
    this.#environment.postToWorklet({ v: 1, op: "frame", sceneId, samples });
    if (record.frames >= this.#minPreparedFrames) {
      const waiters = record.waiters;
      record.waiters = [];
      for (const resolve of waiters) {
        resolve(true);
      }
    }
  }

  get bufferedFrames(): ReadonlyMap<string, number> {
    const snapshot = new Map<string, number>();
    for (const [sceneId, record] of this.#scenes) {
      snapshot.set(sceneId, record.frames);
    }
    return snapshot;
  }

  /**
   * 流终止（media.stream.closed 到达）：先进入 closing（尾帧宽限窗，
   * 期间跨连接尾帧继续入账），宽限期过后才向 Worklet 转发 EOS 并拒绝
   * 后续追加。零帧流在宽限期后立即完成；否则完成信号 = Worklet ended
   * 回报，兜底截止 = start 时刻 + 已缓冲时长 + 宽限。
   */
  endOfSpeech(sceneId: string): void {
    if (this.#closed || this.#stoppedScenes.has(sceneId)) {
      return;
    }
    const record = this.#sceneOf(sceneId);
    if (record.closing || record.eos) {
      return;
    }
    record.closing = true;
    const postEndAt = this.#clock.nowUs() + EOS_TAIL_GRACE_US;
    this.#sleep(postEndAt, record, () => {
      record.eos = true;
      if (record.frames === 0 || record.ended) {
        this.#settle(sceneId, record);
        return;
      }
      this.#environment.postToWorklet({ v: 1, op: "end", sceneId });
      if (record.startedAtUs !== null) {
        const deadline = record.startedAtUs + record.playedUs + EOS_COMPLETION_GRACE_US;
        this.#sleep(deadline, record, () => this.#settle(sceneId, record));
      }
    });
  }

  async start(sceneId: string, _atStageUs: bigint, _cues: readonly Cue[]): Promise<void> {
    if (this.#stoppedScenes.has(sceneId)) {
      return;
    }
    // Commit 生效时刻：原子切换播放 generation；Promise 在播放真实
    // 完成（ended / EOS 零帧 / 兜底截止 / 停止）时兑现。
    const record = this.#sceneOf(sceneId);
    record.startedAtUs = this.#clock.nowUs();
    this.#environment.postToWorklet({ v: 1, op: "switch", sceneId });
    if (record.eos && (record.frames === 0 || record.ended)) {
      return;
    }
    if (record.closing || record.eos) {
      // closed 已到（宽限窗计未过/已过未完成）：兜底截止，窗内的
      // postEnd/ended 仍会正常触发完成。
      const deadline =
        record.startedAtUs + record.playedUs + EOS_TAIL_GRACE_US + EOS_COMPLETION_GRACE_US;
      this.#sleep(deadline, record, () => this.#settle(sceneId, record));
    }
    await new Promise<void>((resolve) => {
      record.completions.push(resolve);
    });
  }

  async stop(sceneId: string, _reason: string): Promise<void> {
    this.#stoppedScenes.add(sceneId);
    this.#environment.postToWorklet({ v: 1, op: "cancel", sceneId });
    const record = this.#scenes.get(sceneId);
    if (record !== undefined) {
      this.#settle(sceneId, record);
      this.#scenes.delete(sceneId);
    }
  }

  async finish(sceneId: string): Promise<void> {
    this.#stoppedScenes.add(sceneId);
    this.#environment.postToWorklet({ v: 1, op: "cancel", sceneId });
    const record = this.#scenes.get(sceneId);
    if (record !== undefined) {
      this.#settle(sceneId, record);
      this.#scenes.delete(sceneId);
    }
  }

  /** 连接代际变化/关闭：全部缓冲清空（静音）。 */
  clearAll(): void {
    this.#environment.postToWorklet({ v: 1, op: "clear" });
    for (const [sceneId, record] of this.#scenes) {
      this.#settle(sceneId, record);
    }
    this.#scenes.clear();
    this.#stoppedScenes.clear();
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.clearAll();
    this.#environment.onWorkletMessage(null);
    await this.#environment.close();
  }

  #settle(sceneId: string, record: AudioScene): void {
    for (const timer of record.timers.splice(0)) {
      timer.abort(new Error(`audio_settled:${sceneId}`));
    }
    // 残留的 prepare 等待者一并释放（Scene 终止后不得悬挂）。
    for (const resolve of record.waiters.splice(0)) {
      resolve(false);
    }
    const completions = record.completions;
    record.completions = [];
    for (const resolve of completions) {
      resolve();
    }
  }

  #sleep(targetUs: bigint, record: AudioScene, onElapsed: () => void): void {
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
