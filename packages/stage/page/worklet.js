// @ts-check
/**
 * Stage 的 AudioWorklet：按句排队播放，按已渲染的样本帧计时（许可时长与宿主心跳），回报播放游标。
 * 来源隐藏时 Chromium 会节流页面定时器，所以计时都放在这里（R-08、见 Stage“计时”）。
 *
 * 页面发来的消息：
 *   hb                         宿主心跳；静音中收到即恢复
 *   lease { ttlMs }            当前令牌有效（续约时重发），在这么多毫秒的渲染帧内收不到续约即视为过期
 *   revoke                     令牌已变化或已吊销：丢弃全部缓冲
 *   begin { id }               开始一句
 *   pcm { id, data, src }      一块已重采样的音频；src 是它对应的原始采样数
 *   end { id, src }            这一句不会再有音频；src 是原始采样总数
 *   truncate { id }            立即停止这一句
 * 回报：started、cursor、underrun、ended、truncated（played 均为原始采样数）、muted。
 *
 * 唤醒信号（见 Stage“播放”）：OBS 浏览器源只在页面“有声”时采集音频，静默约 2–3 秒后停止，再次有声时
 * 句首会丢 20–80ms。所以连续静默（按渲染帧计）超过 1.5 秒后的第一句，先放 100ms 唤醒信号再放正文：
 * 20Hz、峰值 -50dBFS 的正弦，两端 10ms 升余弦淡入淡出。它只在队首有句子、且已收到这一句的音频时才放，
 * 而句子只在持有许可、未静音时才会入队，所以空闲、安全停止与自静音时仍是数字静音。started 在正文开始时回报，
 * 游标与“已播出”的采样只算正文。
 */

const HEARTBEAT_TIMEOUT_SECONDS = 1;
const CURSOR_EVERY_SECONDS = 0.1;
const WAKE_AFTER_SECONDS = 1.5;
const WAKE_SECONDS = 0.1;
const WAKE_FADE_SECONDS = 0.01;
const WAKE_HZ = 20;
const WAKE_AMPLITUDE = 10 ** (-50 / 20);

/** 唤醒信号的第 k 帧。 @param {number} k @param {number} length */
function wakeSample(k, length) {
  const fade = Math.max(1, Math.round(WAKE_FADE_SECONDS * sampleRate));
  const edge = Math.min(k, length - k);
  const gain = edge >= fade ? 1 : 0.5 - 0.5 * Math.cos((Math.PI * edge) / fade);
  return WAKE_AMPLITUDE * gain * Math.sin((2 * Math.PI * WAKE_HZ * k) / sampleRate);
}

/**
 * @typedef {object} Sentence
 * @property {string} id
 * @property {Float32Array[]} chunks
 * @property {number[]} sources 每块对应的原始采样数
 * @property {number} offset 当前块已播放的帧数
 * @property {number} playedSource 已整块播完的原始采样数
 * @property {number | null} total 收到 end 后的原始采样总数
 * @property {boolean} started
 * @property {boolean} underrun
 * @property {number | null} wake 唤醒信号已放的帧数；null 表示还没决定，等于唤醒帧数表示放完或不需要
 */

/**
 * @typedef {{ type: 'hb' } | { type: 'lease', ttlMs: number } | { type: 'revoke' }
 *   | { type: 'begin', id: string } | { type: 'pcm', id: string, data: Float32Array, src: number }
 *   | { type: 'end', id: string, src: number } | { type: 'truncate', id: string }} Command
 */

class StageProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    /** @type {Sentence[]} */
    this.queue = [];
    /** 许可剩余的渲染帧数；0 表示没有有效许可。 */
    this.leaseFrames = 0;
    this.sinceHeartbeat = 0;
    this.sinceCursor = 0;
    this.muted = false;
    /** 连续输出数字静音（含唤醒信号）的渲染帧数；页面刚加载时视为已静默很久。 */
    this.silentFrames = Number.POSITIVE_INFINITY;
    this.wakeFrames = Math.round(WAKE_SECONDS * sampleRate);
    this.port.onmessage = (event) => this.receive(/** @type {Command} */ (event.data));
  }

  /** @param {Command} message */
  receive(message) {
    switch (message.type) {
      case 'hb':
        this.sinceHeartbeat = 0;
        this.muted = false;
        return;
      case 'lease':
        this.leaseFrames = Math.max(1, Math.round((message.ttlMs * sampleRate) / 1000));
        return;
      case 'revoke':
        this.leaseFrames = 0;
        this.dropAll('令牌已变化');
        return;
      case 'begin':
        if (this.muted || this.leaseFrames <= 0) {
          const reason = this.muted ? '页面已静音' : '没有有效许可';
          this.port.postMessage({ kind: 'truncated', sentenceId: message.id, played: 0, reason });
          return;
        }
        this.queue.push({
          id: message.id,
          chunks: [],
          sources: [],
          offset: 0,
          playedSource: 0,
          total: null,
          started: false,
          underrun: false,
          wake: null,
        });
        return;
      case 'pcm': {
        const sentence = this.find(message.id);
        if (!sentence || message.data.length === 0) return;
        sentence.chunks.push(message.data);
        sentence.sources.push(message.src);
        return;
      }
      case 'end': {
        const sentence = this.find(message.id);
        if (sentence) sentence.total = message.src;
        return;
      }
      case 'truncate': {
        const sentence = this.find(message.id);
        if (sentence) this.drop(sentence, '要求截断');
        return;
      }
    }
  }

  /** @param {string} id */
  find(id) {
    return this.queue.find((sentence) => sentence.id === id);
  }

  /** 已播出的原始采样数：整块按块计，当前块按比例折算。 @param {Sentence} sentence */
  played(sentence) {
    const chunk = sentence.chunks[0];
    const source = sentence.sources[0] ?? 0;
    const partial = chunk ? Math.floor((sentence.offset / chunk.length) * source) : 0;
    return sentence.playedSource + partial;
  }

  /** @param {Sentence} sentence @param {string} reason */
  drop(sentence, reason) {
    this.queue.splice(this.queue.indexOf(sentence), 1);
    this.port.postMessage({
      kind: 'truncated',
      sentenceId: sentence.id,
      played: this.played(sentence),
      reason,
    });
  }

  /** @param {string} reason */
  dropAll(reason) {
    for (const sentence of [...this.queue]) this.drop(sentence, reason);
  }

  /**
   * @param {Float32Array[][]} _inputs
   * @param {Float32Array[][]} outputs
   */
  process(_inputs, outputs) {
    const channels = /** @type {Float32Array[]} */ (outputs[0]);
    const frames = /** @type {Float32Array} */ (channels[0]).length;
    this.sinceHeartbeat += frames;
    if (!this.muted && this.sinceHeartbeat > sampleRate * HEARTBEAT_TIMEOUT_SECONDS) {
      this.muted = true;
      this.dropAll('宿主心跳丢失');
      this.port.postMessage({ kind: 'muted', reason: '宿主心跳丢失' });
    }
    if (this.leaseFrames > 0) {
      this.leaseFrames -= frames;
      if (this.leaseFrames <= 0) {
        this.leaseFrames = 0;
        this.dropAll('许可过期');
      }
    }

    let written = 0;
    /** 本轮最后一帧正文之后的位置；没有正文时为 0。 */
    let audioEnd = 0;
    while (!this.muted && written < frames) {
      const head = this.queue[0];
      if (!head) break;
      const chunk = head.chunks[0];
      if (!chunk) {
        if (head.total !== null) {
          // 全部播完：以原始采样总数回报，与 Stage 服务转发的数量一致。
          this.queue.shift();
          this.port.postMessage({ kind: 'ended', sentenceId: head.id, played: head.total });
          continue;
        }
        if (head.started && !head.underrun) {
          head.underrun = true;
          this.port.postMessage({
            kind: 'underrun',
            sentenceId: head.id,
            played: this.played(head),
          });
        }
        break;
      }
      if (!head.started) {
        // 静默够久：先放唤醒信号（见文件头），放完再开始正文。
        head.wake ??= this.silentFrames >= WAKE_AFTER_SECONDS * sampleRate ? 0 : this.wakeFrames;
        if (head.wake < this.wakeFrames) {
          const take = Math.min(frames - written, this.wakeFrames - head.wake);
          for (let i = 0; i < take; i++) {
            const value = wakeSample(head.wake + i, this.wakeFrames);
            for (const channel of channels) channel[written + i] = value;
          }
          head.wake += take;
          written += take;
          continue;
        }
        head.started = true;
        this.port.postMessage({ kind: 'started', sentenceId: head.id });
      }
      head.underrun = false;
      const take = Math.min(frames - written, chunk.length - head.offset);
      for (const channel of channels)
        channel.set(chunk.subarray(head.offset, head.offset + take), written);
      written += take;
      audioEnd = written;
      head.offset += take;
      if (head.offset >= chunk.length) {
        head.chunks.shift();
        head.playedSource += head.sources.shift() ?? 0;
        head.offset = 0;
      }
    }
    // 补零不推进游标。
    for (const channel of channels) channel.fill(0, written);
    // 唤醒信号不算正文：放过唤醒信号却没接上正文（例如许可在这期间过期）时，下一句仍要先唤醒。
    this.silentFrames = audioEnd > 0 ? frames - audioEnd : this.silentFrames + frames;

    this.sinceCursor += frames;
    if (this.sinceCursor >= sampleRate * CURSOR_EVERY_SECONDS) {
      this.sinceCursor = 0;
      const head = this.queue[0];
      if (head?.started) {
        this.port.postMessage({ kind: 'cursor', sentenceId: head.id, played: this.played(head) });
      }
    }
    return true;
  }
}

registerProcessor('bellis-stage', StageProcessor);
