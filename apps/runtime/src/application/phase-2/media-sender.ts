import {
  PHASE_2_PCM_CONTENT_TYPE,
  PHASE_2_PCM_FRAME_BYTES,
  PHASE_2_PCM_FRAME_DURATION_US,
  type MonotonicClock,
  type ScenePlan,
} from "@bellis/contracts";
import type { BufferedPcmSpeech, PcmSpeechSource } from "../performance/speech-provider.js";

/**
 * Runtime → Stage 媒体发送器（docs/phase-2-development-guide.md §8.1）。
 *
 * - 帧 Sequence 从 0 严格连续（只计数到达传输层的帧：丢弃帧不消耗
 *   序号）；targetTimeUs = 首帧目标 + PCM 帧序 × 20ms；发送节奏跟随时钟
 *   （目标时刻到达才发，不提前洪泛）；
 * - 队列三重限制（全部落地）：帧数、字节数以「已发送未播放」账目执行
 *   （播放时刻过去即出账；追赶突发不占队列），未来音频时长 ≤ maxFutureUs
 *   （契约允许零预算 = 只按目标时刻发送）；超过迟到阈值的帧丢弃重同步
 *   （droppedByLimit 计数，与 Stage Deadline 宽限同族）；
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

/**
 * 迟到重同步阈值（与 Stage 侧 Deadline 宽限同族）：超过该迟到的帧
 * 会被 Stage 的 deadline 检查拒绝，发送侧直接丢弃重同步。独立于
 * maxFutureUs（提前量预算允许合法的零预算——不意味着零迟到容忍）。
 */
const LATE_DROP_US = 100_000n;

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
  /**
   * 流任务结束回调（自然完成或取消/被取代）：应用层据此发送
   * media.stream.closed，释放 Stage Registry 的并发 Stream 槽位。
   */
  readonly onJobEnd?: (info: {
    readonly sceneId: string;
    readonly streamId: string;
    readonly traceId: string;
    readonly reason: "completed" | "cancelled";
    /** 已交送传输层的最大 Sequence（无送达帧为 -1）：closed 边界。 */
    readonly finalSequence: bigint;
  }) => void;
}

interface SendJob {
  readonly sceneId: string;
  readonly streamId: string;
  readonly sessionId: string;
  readonly cueId: string;
  readonly traceId: string;
  readonly pcm: BufferedPcmSpeech | PcmSpeechSource;
  readonly firstFrameTargetUs: bigint;
  controller: AbortController;
  stopped: boolean;
  /**
   * 已成功交送传输层的帧数（= 下一帧的 Sequence）：丢弃帧（限制/传输）
   * 不消耗 Sequence——接收端只看到严格连续 0,1,2,…，缺号即
   * sequence_violation（binary-media-websocket.md）。
   */
  sentSequence: bigint;
}

export class RuntimeMediaSender {
  readonly #clock: MonotonicClock;
  /** 内部可变副本（maxFutureUs 随 Stage 能力上报动态更新）。 */
  readonly #limits: { -readonly [K in keyof MediaSenderLimits]: MediaSenderLimits[K] };
  readonly #sendFrame: (frame: OutboundMediaFrame) => boolean;
  readonly #onJobEnd: RuntimeMediaSenderOptions["onJobEnd"];
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
    this.#onJobEnd = options.onJobEnd;
  }

  /**
   * 能力驱动预算更新（stage.capabilities.audio.maxBufferedUs）：未来音频
   * 提前量不得超过 Stage 声明的缓冲预算（发送中动态生效）。契约允许
   * 零预算（只按目标时刻发送，无提前量）；负数拒绝。
   */
  updateMaxFutureUs(maxFutureUs: bigint): void {
    if (maxFutureUs >= 0n) {
      this.#limits.maxFutureUs = maxFutureUs;
    }
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
    readonly tts: BufferedPcmSpeech | PcmSpeechSource;
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
      sentSequence: 0n,
    };
    this.#jobs.set(sceneId, job);
    void this.#run(job).catch(() => {
      if (!job.stopped) this.cancelStream(sceneId, "speech_provider_failed");
    });
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
    this.#notifyJobEnd(job, "cancelled");
  }

  /** 全部发送任务立即停止（媒体连接断开：Stream 不可跨连接复活）。 */
  cancelAll(reason: string): void {
    for (const [sceneId, job] of this.#jobs) {
      job.stopped = true;
      job.controller.abort(new Error(`media_cancelled:${reason}`));
      this.#jobs.delete(sceneId);
      this.#notifyJobEnd(job, "cancelled");
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
    const source = job.pcm;
    const iterator =
      "frames" in source ? source.frames(job.controller.signal)[Symbol.asyncIterator]() : null;
    try {
      while (!job.stopped && !this.#closed) {
        let payload: Uint8Array;
        if ("pcm" in source) {
          if (frameIndex >= source.frameCount) break;
          payload = source.pcm.subarray(
            frameIndex * PHASE_2_PCM_FRAME_BYTES,
            (frameIndex + 1) * PHASE_2_PCM_FRAME_BYTES,
          );
        } else {
          const next = await iterator!.next();
          if (next.done) break;
          payload = next.value;
        }
        if (job.stopped || this.#closed) return;
        if (payload.byteLength !== PHASE_2_PCM_FRAME_BYTES)
          throw new Error("invalid_pcm_frame_size");
        while (!job.stopped && !this.#closed) {
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
          if (queueFull && overdueBy <= LATE_DROP_US) {
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
          // 等号对齐 Stage Deadline（now−target ≥ 宽限即拒）：恰好到达阈值
          // 的帧 Stage 必拒，发送侧直接丢弃（只产生会被接受的帧）。
          if (queueFull || overdueBy >= LATE_DROP_US) {
            // 队列满的过期帧 / 超过追赶预算的迟到帧：丢弃重同步（迟到音频
            // 无播放价值，不洪泛 socket）；sequence 仍严格连续。
            this.#droppedByLimit += 1;
            frameIndex += 1;
            break;
          }
          const header: Record<string, string | number> = {
            schemaVersion: 1,
            streamId: job.streamId,
            frameId: this.#frameId(job.sceneId, frameIndex),
            sessionId: job.sessionId,
            sceneId: job.sceneId,
            cueId: job.cueId,
            // Sequence 只统计到达传输层的帧：丢弃帧不消耗序号（缺号会被
            // Registry 判 sequence_violation 并关闭整个 Stream）。
            sequence: job.sentSequence.toString(),
            targetTimeUs: targetUs.toString(),
            durationUs: perFrameUs.toString(),
            contentType: PHASE_2_PCM_CONTENT_TYPE,
            traceId: job.traceId,
          };
          const delivered = this.#sendFrame({ header, payload });
          if (!delivered) {
            this.#droppedByTransport += 1;
          } else {
            job.sentSequence += 1n;
            this.#queue.push({ targetUs, bytes: frameBytes });
            this.#queuedBytes += frameBytes;
            // sentTotal 只计到达传输层的帧（与 droppedByTransport 不重叠；
            // mediaStats.sent = 真实送达数）。
            this.#sentTotal += 1;
          }
          frameIndex += 1;
          break;
        }
      }
    } finally {
      await iterator?.return?.();
    }
    if (!job.stopped) {
      this.#jobs.delete(job.sceneId);
      this.#notifyJobEnd(job, "completed");
    }
  }

  #notifyJobEnd(job: SendJob, reason: "completed" | "cancelled"): void {
    this.#onJobEnd?.({
      sceneId: job.sceneId,
      streamId: job.streamId,
      traceId: job.traceId,
      reason,
      finalSequence: job.sentSequence - 1n,
    });
  }

  /** 活跃任务的当前送达边界（无任务为 null；closed 边界查询）。 */
  finalSequenceOf(sceneId: string): bigint | null {
    const job = this.#jobs.get(sceneId);
    return job === undefined ? null : job.sentSequence - 1n;
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
