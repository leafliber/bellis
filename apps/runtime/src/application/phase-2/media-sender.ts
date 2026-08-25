import {
  PHASE_2_PCM_CONTENT_TYPE,
  PHASE_2_PCM_FRAME_BYTES,
  PHASE_2_PCM_FRAME_DURATION_US,
  type MonotonicClock,
  type ScenePlan,
} from "@bellis/contracts";
import type { FakeTtsResult } from "./fake-tts.js";

/**
 * Runtime → Stage 媒体发送器（docs/phase-2-development-guide.md §8.1）。
 *
 * - 帧 Sequence 从 0 严格连续；targetTimeUs = commitAtRuntimeUs + 帧序 ×
 *   20ms；发送节奏跟随时钟（目标时刻到达才发，不提前洪泛）；
 * - 队列三重限制（全部落地）：帧数、字节数以「已发送未播放」账目执行
 *   （播放时刻过去即出账；追赶突发不占队列），未来音频时长 ≤ maxFutureUs；
 *   超过追赶预算的迟到帧丢弃重同步（droppedByLimit 计数，sequence 仍
 *   严格连续）；
 * - Control 取消优先于 Media 发送：cancel() 后立即停止产生新帧；
 * - 所有等待由注入时钟 sleepUntil 驱动并接受 Abort；close() 零残留。
 */

export interface MediaSenderLimits {
  readonly maxQueuedFrames: number;
  readonly maxQueuedBytes: number;
  /** 最大未来音频时长（微秒），≤ Stage maxBufferedUs。 */
  readonly maxFutureUs: bigint;
}

export const DEFAULT_MEDIA_SENDER_LIMITS: MediaSenderLimits = {
  maxQueuedFrames: 128,
  maxQueuedBytes: PHASE_2_PCM_FRAME_BYTES * 128,
  maxFutureUs: 2_000_000n,
};

export interface OutboundMediaFrame {
  /** MediaFrameHeader 字段（schemaVersion 为数字 1，其余为字符串）。 */
  readonly header: Record<string, string | number>;
  readonly payload: Uint8Array;
}

export interface RuntimeMediaSenderOptions {
  readonly clock: MonotonicClock;
  readonly limits?: Partial<MediaSenderLimits>;
  /** 帧发出回调（适配器负责编码与 socket 写入）；false = 传输层丢弃。 */
  readonly sendFrame: (frame: OutboundMediaFrame) => boolean;
}

interface SendJob {
  readonly sceneId: string;
  readonly streamId: string;
  readonly sessionId: string;
  readonly cueId: string;
  readonly traceId: string;
  readonly pcm: FakeTtsResult;
  readonly firstFrameTargetUs: bigint;
  controller: AbortController;
  stopped: boolean;
}

export class RuntimeMediaSender {
  readonly #clock: MonotonicClock;
  readonly #limits: MediaSenderLimits;
  readonly #sendFrame: (frame: OutboundMediaFrame) => boolean;
  readonly #jobs = new Map<string, SendJob>();
  /**
   * 已交发送但播放时刻未过的帧（socket 内未播音频的发送侧账目）：
   * 三重限制的帧数/字节维度的执行载体。播放时刻过去即出账（prune）；
   * 追赶突发中所有帧均已过期 → 即时出账，不占队列。
   */
  readonly #queue: { readonly targetUs: bigint; readonly bytes: number }[] = [];
  #queuedBytes = 0;
  #closed = false;
  #sentTotal = 0;
  #droppedByLimit = 0;
  #droppedByTransport = 0;

  constructor(options: RuntimeMediaSenderOptions) {
    this.#clock = options.clock;
    this.#limits = { ...DEFAULT_MEDIA_SENDER_LIMITS, ...options.limits };
    this.#sendFrame = options.sendFrame;
  }

  get sentTotal(): number {
    return this.#sentTotal;
  }

  get droppedByLimit(): number {
    return this.#droppedByLimit;
  }

  /** 传输层拒绝（连接不存在/背压超限）导致的丢弃帧数。 */
  get droppedByTransport(): number {
    return this.#droppedByTransport;
  }

  /** 当前排队（已发送未播放）帧数/字节数（限制执行的可观测账目）。 */
  get queued(): { readonly frames: number; readonly bytes: number } {
    return { frames: this.#queue.length, bytes: this.#queuedBytes };
  }

  get activeJobs(): number {
    return this.#jobs.size;
  }

  /**
   * 启动一个流发送任务：以 firstFrameTargetUs 为首帧目标时刻，按 20ms
   * 步进发送完整 PCM。返回后立即开始（fire-and-forget，可取消）。
   */
  startSpeechStream(input: {
    readonly plan: ScenePlan;
    readonly tts: FakeTtsResult;
    readonly audioCueId: string;
    readonly streamId: string;
    readonly sessionId: string;
    readonly traceId: string;
    readonly firstFrameTargetUs: bigint;
  }): void {
    if (this.#closed) {
      throw new Error("media_sender_closed");
    }
    const sceneId = input.plan.scene.sceneId;
    this.cancelStream(sceneId, "superseded");
    const controller = new AbortController();
    const job: SendJob = {
      sceneId,
      streamId: input.streamId,
      sessionId: input.sessionId,
      cueId: input.audioCueId,
      traceId: input.traceId,
      pcm: input.tts,
      firstFrameTargetUs: input.firstFrameTargetUs,
      controller,
      stopped: false,
    };
    this.#jobs.set(sceneId, job);
    void this.#run(job);
  }

  /** 取消发送：立即停止该 Scene 的新帧（取消优先于媒体）。 */
  cancelStream(sceneId: string, reason: string): void {
    const job = this.#jobs.get(sceneId);
    if (job === undefined) {
      return;
    }
    job.stopped = true;
    job.controller.abort(new Error(`media_cancelled:${reason}`));
    this.#jobs.delete(sceneId);
  }

  /** 全部发送任务立即停止（媒体连接断开：Stream 不可跨连接复活）。 */
  cancelAll(reason: string): void {
    for (const [sceneId, job] of this.#jobs) {
      job.stopped = true;
      job.controller.abort(new Error(`media_cancelled:${reason}`));
      this.#jobs.delete(sceneId);
    }
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    for (const [sceneId, job] of this.#jobs) {
      job.stopped = true;
      job.controller.abort(new Error("media_sender_closed"));
      this.#jobs.delete(sceneId);
    }
  }

  async #run(job: SendJob): Promise<void> {
    const perFrameUs = PHASE_2_PCM_FRAME_DURATION_US;
    let frameIndex = 0;
    const totalFrames = job.pcm.frameCount;
    while (!job.stopped && !this.#closed && frameIndex < totalFrames) {
      const targetUs = job.firstFrameTargetUs + BigInt(frameIndex) * perFrameUs;
      // 限制 1/3（未来时长）：超预算提前量时等待时钟追赶。
      const lead = targetUs - this.#clock.nowUs();
      if (lead > this.#limits.maxFutureUs) {
        const waitOk = await this.#sleep(
          targetUs - this.#limits.maxFutureUs,
          job.controller.signal,
        );
        if (!waitOk) {
          return;
        }
        continue;
      }
      if (lead > 0n) {
        const waitOk = await this.#sleep(targetUs, job.controller.signal);
        if (!waitOk) {
          return;
        }
      }
      if (job.stopped || this.#closed) {
        return;
      }
      // 播放时刻已过：出账（追赶突发不占队列）。
      this.#pruneQueue();
      const frameBytes = PHASE_2_PCM_FRAME_BYTES;
      const queueFull =
        this.#queue.length >= this.#limits.maxQueuedFrames ||
        this.#queuedBytes + frameBytes > this.#limits.maxQueuedBytes;
      const overdueBy = this.#clock.nowUs() - targetUs;
      if (queueFull && overdueBy <= this.#limits.maxFutureUs) {
        // 限制 2/3（帧数/字节）：队列满但帧仍在有效窗口内——等待队头
        // 播放出账后重估（不丢有效音频）。
        const head = this.#queue[0];
        if (head !== undefined) {
          const waitOk = await this.#sleep(head.targetUs + perFrameUs, job.controller.signal);
          if (!waitOk) {
            return;
          }
          continue;
        }
      }
      if (queueFull || overdueBy > this.#limits.maxFutureUs) {
        // 队列满的过期帧 / 超过追赶预算的迟到帧：丢弃重同步（迟到音频
        // 无播放价值，不洪泛 socket）；sequence 仍严格连续。
        this.#droppedByLimit += 1;
        frameIndex += 1;
        continue;
      }
      const start = frameIndex * PHASE_2_PCM_FRAME_BYTES;
      const payload = job.pcm.pcm.subarray(start, start + PHASE_2_PCM_FRAME_BYTES);
      const header: Record<string, string | number> = {
        schemaVersion: 1,
        streamId: job.streamId,
        frameId: this.#frameId(job.sceneId, frameIndex),
        sessionId: job.sessionId,
        sceneId: job.sceneId,
        cueId: job.cueId,
        sequence: String(frameIndex),
        targetTimeUs: targetUs.toString(),
        durationUs: perFrameUs.toString(),
        contentType: PHASE_2_PCM_CONTENT_TYPE,
        traceId: job.traceId,
      };
      if (!this.#sendFrame({ header, payload })) {
        this.#droppedByTransport += 1;
      }
      this.#queue.push({ targetUs, bytes: frameBytes });
      this.#queuedBytes += frameBytes;
      this.#sentTotal += 1;
      frameIndex += 1;
    }
    if (!job.stopped) {
      this.#jobs.delete(job.sceneId);
    }
  }

  /** 播放时刻已过的队头出账（未播音频账目只保留真正排队的帧）。 */
  #pruneQueue(): void {
    const nowUs = this.#clock.nowUs();
    while (this.#queue.length > 0) {
      const head = this.#queue[0]!;
      if (head.targetUs + PHASE_2_PCM_FRAME_DURATION_US > nowUs) {
        return;
      }
      this.#queue.shift();
      this.#queuedBytes -= head.bytes;
    }
  }

  #frameIdSeed = 0;

  #frameId(sceneId: string, frameIndex: number): string {
    // 帧内唯一即可：以递增种子构造 UUID 形态（发送侧不需要加密随机）。
    this.#frameIdSeed += 1;
    const tail = `${this.#frameIdSeed.toString(16).padStart(8, "0")}${frameIndex
      .toString(16)
      .padStart(4, "0")}`.slice(0, 12);
    void sceneId;
    return `aaaaaaaa-aaaa-4aaa-8aaa-${tail.padStart(12, "0")}`;
  }

  async #sleep(targetUs: bigint, signal: AbortSignal): Promise<boolean> {
    try {
      await this.#clock.sleepUntil(targetUs, signal);
      return true;
    } catch {
      return false;
    }
  }
}
