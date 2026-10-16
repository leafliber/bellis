// 探针 S-01 的 AudioWorklet：环形缓冲播放；心跳超时与回报周期都按已渲染的样本帧计，不用页面定时器。
// `sampleRate`、`AudioWorkletProcessor`、`registerProcessor` 是 AudioWorkletGlobalScope 的全局量。

const HEARTBEAT_TIMEOUT_SECONDS = 1;
const REPORT_EVERY_SECONDS = 0.1;
const BUFFER_SECONDS = 4;

class Probe extends AudioWorkletProcessor {
  constructor() {
    super();
    this.capacity = Math.round(sampleRate * BUFFER_SECONDS);
    this.ring = new Float32Array(this.capacity);
    this.readAt = 0;
    this.size = 0;
    this.started = false;
    this.rendered = 0;
    this.played = 0;
    this.underrun = 0;
    this.dropped = 0;
    this.sinceHeartbeat = 0;
    this.sinceReport = 0;
    this.muted = false;
    this.port.onmessage = (event) => {
      if (event.data.type === 'pcm') this.push(new Float32Array(event.data.data));
      else if (event.data.type === 'hb') this.heartbeat();
    };
  }

  heartbeat() {
    this.sinceHeartbeat = 0;
    if (this.muted) {
      this.muted = false;
      this.port.postMessage({ type: 'unmuted', frame: this.rendered });
    }
  }

  push(samples) {
    if (this.muted) {
      this.dropped += samples.length;
      return;
    }
    this.started = true;
    for (let i = 0; i < samples.length; i++) {
      if (this.size === this.capacity) {
        this.dropped += samples.length - i;
        return;
      }
      this.ring[(this.readAt + this.size) % this.capacity] = samples[i];
      this.size++;
    }
  }

  process(_inputs, outputs) {
    const channels = outputs[0];
    const frames = channels[0].length;
    this.sinceHeartbeat += frames;
    if (!this.muted && this.sinceHeartbeat > sampleRate * HEARTBEAT_TIMEOUT_SECONDS) {
      this.muted = true;
      // 清空的缓冲也计入丢弃，宿主据此算出页面实际消耗了多少，取消静音后能补足缓冲。
      this.dropped += this.size;
      this.size = 0;
      this.port.postMessage({ type: 'muted', frame: this.rendered });
    }
    for (let i = 0; i < frames; i++) {
      let value = 0;
      if (!this.muted && this.size > 0) {
        value = this.ring[this.readAt];
        this.readAt = (this.readAt + 1) % this.capacity;
        this.size--;
        this.played++;
      } else if (!this.muted && this.started) {
        this.underrun++;
      }
      for (const channel of channels) channel[i] = value;
    }
    this.rendered += frames;
    this.sinceReport += frames;
    if (this.sinceReport >= sampleRate * REPORT_EVERY_SECONDS) {
      this.sinceReport = 0;
      this.port.postMessage({
        type: 'cursor',
        rendered: this.rendered,
        played: this.played,
        underrun: this.underrun,
        dropped: this.dropped,
        buffered: this.size,
        muted: this.muted,
      });
    }
    return true;
  }
}

registerProcessor('bellis-s01', Probe);
