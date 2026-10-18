import {
  type Clock,
  ClockService,
  definePlugin,
  defineService,
  type TimerHandle,
} from '@bellis/kernel';
import type { MeterLevel, ObsMeters } from '@bellis/obs';
import { SafetyService } from '@bellis/safety';
import Type from 'typebox';
import { AUDIBLE_DB, type Envelope } from './envelope.ts';
import { MAX_PRESENTATION_DELAY_MS } from './page-wire.ts';
import { type FromPage, type Presentation, type Stage, StageService } from './types.ts';

/** 读 OBS 音量表的权限（插件内核文档“权限”）。 */
export const OBS_METERS = 'obs.meters';

/**
 * 宿主提供的只读 OBS 音量表连接（`ObsMeters`）：凭据留在宿主，只有被授予 `obs.meters` 的实例能连接。
 * 与 OBS 控制的连接（`ObsConnectorService`，`obs.control`）分开。
 */
export interface ObsMetersConnector {
  connect(): Promise<ObsMeters>;
}

export const ObsMetersService = defineService<ObsMetersConnector>('obs.meters-connector', 1);

export interface DelayEstimatorOptions {
  /** 样本还不够时的呈现延迟（同步偏移为 0 时）。 */
  initialMs: number;
  /** k_sub：音量表看到出声的时延比字幕该推迟的多出的部分。 */
  kSubMs: number;
  /** 取最近这么多句的中位数。 */
  window: number;
  /** 少于这么多句时用初值。 */
  minSamples: number;
  /** 新的估计与当前值相差超过它才更新。 */
  hysteresisMs: number;
}

/**
 * 呈现延迟的估计（Stage 文档“对齐”）：最近若干句的音量表时延取中位数，加上 Stage 源的音频同步偏移，
 * 减去 k_sub，取整后限制在 0–300ms；与当前值相差超过迟滞量才更新。样本不够时用初值加同步偏移。
 */
export class DelayEstimator {
  readonly #options: DelayEstimatorOptions;
  readonly #samples: number[] = [];
  #syncOffsetMs = 0;
  #delayMs: number;

  constructor(options: DelayEstimatorOptions) {
    this.#options = options;
    this.#delayMs = this.#target();
  }

  get delayMs(): number {
    return this.#delayMs;
  }

  /** 窗口里的句子数。 */
  get samples(): number {
    return this.#samples.length;
  }

  /** 样本够了：呈现延迟来自音量表。 */
  get estimated(): boolean {
    return this.#samples.length >= this.#options.minSamples;
  }

  get medianMs(): number | undefined {
    const sorted = [...this.#samples].sort((a, b) => a - b);
    const middle = sorted.length >> 1;
    if (sorted.length === 0) return undefined;
    return sorted.length % 2 === 1
      ? (sorted[middle] as number)
      : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
  }

  get syncOffsetMs(): number {
    return this.#syncOffsetMs;
  }

  /** 记一句的音量表时延（毫秒）；返回呈现延迟是否变化。 */
  add(sampleMs: number): boolean {
    this.#samples.push(sampleMs);
    if (this.#samples.length > this.#options.window) this.#samples.shift();
    return this.#update();
  }

  /**
   * Stage 源的音频同步偏移（毫秒）；返回呈现延迟是否变化。负值按 0 计：OBS 32.2.2 实测负的同步偏移
   * 不改变输出（Stage 文档“对齐”）。
   */
  setSyncOffset(ms: number): boolean {
    this.#syncOffsetMs = ms;
    return this.#update();
  }

  #target(): number {
    const median = this.estimated ? this.medianMs : undefined;
    const base = median === undefined ? this.#options.initialMs : median - this.#options.kSubMs;
    const raw = Math.round(base + Math.max(0, this.#syncOffsetMs));
    return Math.min(MAX_PRESENTATION_DELAY_MS, Math.max(0, raw));
  }

  #update(): boolean {
    const target = this.#target();
    if (Math.abs(target - this.#delayMs) <= this.#options.hysteresisMs) return false;
    this.#delayMs = target;
    return true;
  }
}

export interface StageSyncOptions extends DelayEstimatorOptions {
  /** 读 Stage 源同步偏移的间隔。 */
  syncOffsetPollMs: number;
  /** 音量表连接失败或断开后的重连间隔。 */
  reconnectMs: number;
}

export interface StageSyncDeps {
  stage: Stage;
  clock: Clock;
  connector: ObsMetersConnector;
  /** OBS 里 Stage 浏览器源的名字。 */
  stageSource: string;
  options: StageSyncOptions;
  log(event: string, fields?: Record<string, unknown>): void;
}

/**
 * 一句的起音之前，页面上至少要静这么久（再加上当前的呈现延迟），音量表的起音才能确定属于这一句：
 * 上一句的余音此时已经离开 OBS 的管线，音量表也至少有一次读数落在门限以下。
 */
const QUIET_GUARD_MS = 100;
/** 样本的上限：超出即认为音量表没有看到这一句的起音。 */
const MAX_SAMPLE_MS = MAX_PRESENTATION_DELAY_MS + 200;

interface Pending {
  sentenceId: string;
  startedAt: number;
  /** 这一句第一个出声的采样相对句首的时刻。 */
  onsetMs: number;
}

interface Current {
  sentenceId: string;
  /** 开始播放时取到的包络；句子结束后 Stage 不再提供。 */
  envelope: Envelope;
}

/**
 * 按 OBS 音量表测量并维护呈现延迟（Stage 文档“对齐”）。每句的样本：宿主收到 started 之后，Stage 源的音量表
 * 第一次从门限以下升到门限以上的时刻，减去 started 的时刻，再减去这一句的包络第一次达到同一门限的时刻。
 * 起音前静音不够长（上一句的余音可能还在 OBS 里）、音量表未连接或超时没看到的句子不取样本。
 * 音量表不可用时沿用上一次的值或初值，只记日志，不阻断播出。
 */
export class StageSync {
  readonly #deps: StageSyncDeps;
  readonly #estimator: DelayEstimator;
  #meters: ObsMeters | undefined;
  #unsubscribe: Array<() => void> = [];
  #retry: TimerHandle | undefined;
  #poll: TimerHandle | undefined;
  #stopped = false;
  /** 上一次连接失败的原因：同样的原因只记一次。 */
  #problem: string | undefined;
  #syncOffsetUnavailable = false;
  #pending: Pending | undefined;
  #current: Current | undefined;
  /** 页面上最近一次出声结束的时刻（宿主时钟）。 */
  #lastAudibleAt = Number.NEGATIVE_INFINITY;
  /** 上一次音量表读数是否在门限以上；刚连上时按“是”算，先要看到一次门限以下。 */
  #above = true;
  #published: Presentation | undefined;

  constructor(deps: StageSyncDeps) {
    this.#deps = deps;
    this.#estimator = new DelayEstimator(deps.options);
  }

  get presentation(): Presentation {
    const estimator = this.#estimator;
    return {
      delayMs: estimator.delayMs,
      samples: estimator.samples,
      source: !estimator.estimated ? 'initial' : this.#meters ? 'meters' : 'held',
    };
  }

  start(): void {
    this.#unsubscribe.push(this.#deps.stage.onEvent((event) => this.#onEvent(event)));
    this.#publish();
    void this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#retry) this.#deps.clock.clearTimeout(this.#retry);
    if (this.#poll) this.#deps.clock.clearTimeout(this.#poll);
    for (const unsubscribe of this.#unsubscribe.splice(0)) unsubscribe();
    const meters = this.#meters;
    this.#meters = undefined;
    meters?.close();
  }

  #publish(): void {
    const next = this.presentation;
    const previous = this.#published;
    if (previous?.delayMs !== next.delayMs || previous.source !== next.source) {
      this.#deps.log('stage-sync.delay', {
        delayMs: next.delayMs,
        previousMs: previous?.delayMs ?? null,
        source: next.source,
        samples: next.samples,
        medianMs: this.#estimator.medianMs ?? null,
        syncOffsetMs: this.#estimator.syncOffsetMs,
      });
    }
    this.#published = next;
    this.#deps.stage.setPresentation(next);
  }

  #skip(sentenceId: string, reason: string): void {
    this.#deps.log('stage-sync.sample', { sentenceId, sampleMs: null, reason });
  }

  #onEvent(event: FromPage): void {
    const now = this.#deps.clock.now();
    switch (event.kind) {
      case 'started': {
        this.#pending = undefined;
        const envelope = this.#deps.stage.envelope(event.sentenceId);
        this.#current = envelope ? { sentenceId: event.sentenceId, envelope } : undefined;
        if (!envelope || envelope.onset === undefined) {
          this.#skip(event.sentenceId, '开始播放时还没有出声的音频');
          return;
        }
        const onsetMs = (envelope.onset / envelope.sampleRate) * 1000;
        if (now + onsetMs - this.#lastAudibleAt < this.#estimator.delayMs + QUIET_GUARD_MS) {
          this.#skip(event.sentenceId, '起音前的静音太短');
          return;
        }
        if (!this.#meters) {
          this.#skip(event.sentenceId, '音量表未连接');
          return;
        }
        this.#pending = { sentenceId: event.sentenceId, startedAt: now, onsetMs };
        return;
      }
      case 'ended':
      case 'truncated': {
        const current = this.#current;
        if (current?.sentenceId === event.sentenceId) {
          this.#current = undefined;
          const { onset, audibleEnd, sampleRate } = current.envelope;
          // 页面上最后出声的时刻：结束时刻减去尾部（已播部分里）静音的时长。
          if (onset !== undefined && audibleEnd !== undefined && event.played > onset) {
            const tailMs =
              ((event.played - Math.min(audibleEnd, event.played)) / sampleRate) * 1000;
            this.#lastAudibleAt = Math.max(this.#lastAudibleAt, now - tailMs);
          }
        }
        const pending = this.#pending;
        if (event.kind === 'truncated' && pending?.sentenceId === event.sentenceId) {
          const onset = current?.envelope.onset ?? 0;
          if (event.played <= onset) {
            this.#pending = undefined;
            this.#skip(event.sentenceId, '出声前被截断');
          }
        }
        return;
      }
      case 'muted':
        this.#pending = undefined;
        this.#current = undefined;
        this.#lastAudibleAt = now;
        return;
      default:
        return;
    }
  }

  #onLevels(levels: readonly MeterLevel[]): void {
    const now = this.#deps.clock.now();
    const pending = this.#pending;
    if (pending && now - pending.startedAt - pending.onsetMs > MAX_SAMPLE_MS) {
      this.#pending = undefined;
      this.#skip(pending.sentenceId, `音量表 ${MAX_SAMPLE_MS}ms 内没有看到出声`);
    }
    const level = levels.find((l) => l.inputName === this.#deps.stageSource);
    if (!level) return;
    const above = level.peakDb >= AUDIBLE_DB;
    const rising = above && !this.#above;
    this.#above = above;
    const waiting = this.#pending;
    if (!waiting || !rising) return;
    const sampleMs = now - waiting.startedAt - waiting.onsetMs;
    // 起音之前的上升沿是上一句的余音。
    if (sampleMs < 0) return;
    this.#pending = undefined;
    this.#estimator.add(sampleMs);
    this.#deps.log('stage-sync.sample', {
      sentenceId: waiting.sentenceId,
      sampleMs: Math.round(sampleMs * 10) / 10,
      onsetMs: Math.round(waiting.onsetMs * 10) / 10,
    });
    this.#publish();
  }

  async #connect(): Promise<void> {
    this.#retry = undefined;
    let meters: ObsMeters;
    try {
      meters = await this.#deps.connector.connect();
    } catch (error) {
      if (this.#stopped) return;
      const reason = error instanceof Error ? error.message : String(error);
      if (reason !== this.#problem) {
        this.#problem = reason;
        this.#deps.log('stage-sync.meters-unavailable', { reason, ...this.presentation });
      }
      this.#retry = this.#deps.clock.setTimeout(
        () => void this.#connect(),
        this.#deps.options.reconnectMs,
      );
      return;
    }
    if (this.#stopped) {
      meters.close();
      return;
    }
    this.#meters = meters;
    this.#above = true;
    this.#problem = undefined;
    this.#deps.log('stage-sync.meters-connected', {});
    // 连接关闭后不会再有读数，监听随连接一起丢弃。
    meters.onLevels((levels) => {
      if (this.#meters === meters) this.#onLevels(levels);
    });
    meters.onClose((reason) => this.#lost(meters, reason));
    this.#publish();
    await this.#pollSyncOffset(meters);
  }

  #lost(meters: ObsMeters, reason: string): void {
    if (this.#meters !== meters) return;
    this.#meters = undefined;
    this.#pending = undefined;
    if (this.#poll) this.#deps.clock.clearTimeout(this.#poll);
    this.#poll = undefined;
    if (this.#stopped) return;
    this.#problem = reason;
    this.#deps.log('stage-sync.meters-lost', { reason });
    this.#publish();
    this.#retry = this.#deps.clock.setTimeout(
      () => void this.#connect(),
      this.#deps.options.reconnectMs,
    );
  }

  async #pollSyncOffset(meters: ObsMeters): Promise<void> {
    this.#poll = undefined;
    let offset: number | null = null;
    try {
      offset = await meters.audioSyncOffset(this.#deps.stageSource);
    } catch {
      // 连接断开由 onClose 处理；单次超时下一轮再读。
    }
    if (this.#meters !== meters || this.#stopped) return;
    if (offset === null) {
      if (!this.#syncOffsetUnavailable) {
        this.#syncOffsetUnavailable = true;
        this.#deps.log('stage-sync.sync-offset-unavailable', {
          syncOffsetMs: this.#estimator.syncOffsetMs,
        });
      }
    } else {
      this.#syncOffsetUnavailable = false;
      if (offset !== this.#estimator.syncOffsetMs) {
        this.#deps.log('stage-sync.sync-offset', { syncOffsetMs: offset });
        this.#estimator.setSyncOffset(offset);
        this.#publish();
      }
    }
    this.#poll = this.#deps.clock.setTimeout(
      () => void this.#pollSyncOffset(meters),
      this.#deps.options.syncOffsetPollMs,
    );
  }
}

/**
 * 呈现延迟的估计（普通插件，Stage 文档“对齐”）：经宿主提供的只读音量表连接测量 Stage 源出声的时延，
 * 把呈现延迟写给 Stage 服务；页面据此推迟字幕，形象据此推迟口型。只需 `obs.meters`，不发任何控制请求。
 * 停用时呈现延迟回到 0。
 */
export const stageSync = definePlugin({
  manifest: {
    id: 'stage-sync',
    version: '0.1.0',
    tier: 'ordinary',
    provides: [],
    inject: [StageService.ref, SafetyService.ref, ClockService.ref, ObsMetersService.ref],
    permissions: [OBS_METERS],
    process: 'in-process',
    config: Type.Object({
      /** 样本还不够时的呈现延迟（同步偏移为 0 时）；缺省为 interactive 的标定值，页面改用 playback 时改成 142。 */
      initialDelayMs: Type.Integer({ minimum: 0, maximum: MAX_PRESENTATION_DELAY_MS, default: 82 }),
      /** k_sub：音量表看到出声的时延比字幕该推迟的多出的部分；缺省值与重标方法见 Stage 文档“对齐”。 */
      kSubMs: Type.Integer({ minimum: -100, maximum: 100, default: 4 }),
      /** 取最近这么多句的中位数。 */
      windowSentences: Type.Integer({ minimum: 1, maximum: 99, default: 21 }),
      /** 少于这么多句时用初值。 */
      minSentences: Type.Integer({ minimum: 1, maximum: 99, default: 5 }),
      /** 新的估计与当前值相差超过它才更新。 */
      hysteresisMs: Type.Integer({ minimum: 0, maximum: 50, default: 5 }),
      /** 读 Stage 源同步偏移的间隔。 */
      syncOffsetPollMs: Type.Integer({ minimum: 1000, maximum: 600_000, default: 10_000 }),
      /** 音量表连接失败或断开后的重连间隔。 */
      reconnectMs: Type.Integer({ minimum: 100, maximum: 600_000, default: 5000 }),
    }),
  },
  activate(ctx) {
    const config = ctx.config;
    if (config.minSentences > config.windowSentences) {
      throw new Error('minSentences 不能大于 windowSentences');
    }
    const stage = ctx.service(StageService);
    const sync = new StageSync({
      stage,
      clock: ctx.service(ClockService),
      connector: ctx.service(ObsMetersService),
      stageSource: ctx.service(SafetyService).stageSource,
      options: {
        initialMs: config.initialDelayMs,
        kSubMs: config.kSubMs,
        window: config.windowSentences,
        minSamples: config.minSentences,
        hysteresisMs: config.hysteresisMs,
        syncOffsetPollMs: config.syncOffsetPollMs,
        reconnectMs: config.reconnectMs,
      },
      log: (event, fields) => ctx.log(event, fields),
    });
    sync.start();
    ctx.register(() => {
      sync.stop();
      stage.setPresentation({ delayMs: 0, samples: 0, source: 'none' });
    });
  },
});
