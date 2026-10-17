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
 */

const HEARTBEAT_TIMEOUT_SECONDS = 1;
const CURSOR_EVERY_SECONDS = 0.1;

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
        head.started = true;
        this.port.postMessage({ kind: 'started', sentenceId: head.id });
      }
      head.underrun = false;
      const take = Math.min(frames - written, chunk.length - head.offset);
      for (const channel of channels)
        channel.set(chunk.subarray(head.offset, head.offset + take), written);
      written += take;
      head.offset += take;
      if (head.offset >= chunk.length) {
        head.chunks.shift();
        head.playedSource += head.sources.shift() ?? 0;
        head.offset = 0;
      }
    }
    // 补零不推进游标。
    for (const channel of channels) channel.fill(0, written);

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
