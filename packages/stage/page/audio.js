// @ts-check
/**
 * Stage 页面里与浏览器无关的部分：解析音频帧，把 16 位 PCM 线性插值重采样到 AudioContext 的采样率。
 * 宿主的测试在 Node 里直接导入本模块。
 */

/**
 * @typedef {object} AudioHeader
 * @property {string} sentenceId
 * @property {number} token
 */

const decoder = new TextDecoder();

/**
 * 解析一帧音频：2 字节大端头长度 + UTF-8 JSON 头 + 16 位小端 PCM。格式不对时返回 null。
 * @param {ArrayBuffer} buffer
 * @returns {{ header: AudioHeader, pcm: Int16Array } | null}
 */
export function decodeAudio(buffer) {
  if (buffer.byteLength < 2) return null;
  const view = new DataView(buffer);
  const headLength = view.getUint16(0);
  const start = 2 + headLength;
  if (start > buffer.byteLength || (buffer.byteLength - start) % 2 !== 0) return null;
  /** @type {unknown} */
  let header;
  try {
    header = JSON.parse(decoder.decode(new Uint8Array(buffer, 2, headLength)));
  } catch {
    return null;
  }
  if (typeof header !== 'object' || header === null) return null;
  const { sentenceId, token } = /** @type {Record<string, unknown>} */ (header);
  if (typeof sentenceId !== 'string' || typeof token !== 'number') return null;
  const count = (buffer.byteLength - start) / 2;
  const pcm = new Int16Array(count);
  for (let i = 0; i < count; i++) pcm[i] = view.getInt16(start + i * 2, true);
  return { header: { sentenceId, token }, pcm };
}

/** 线性插值重采样，跨块保持相位；每句一个。 */
export class Resampler {
  /**
   * @param {number} from 输入采样率
   * @param {number} to 输出采样率
   */
  constructor(from, to) {
    /** 每个输出样本前进的输入样本数。 */
    this.step = from / to;
    /** 下一个输出样本的位置；-1 是上一块的最后一个样本，0 起是本块。 */
    this.position = 0;
    /** 上一块的最后一个样本（已归一化到 [-1, 1)）。 */
    this.last = 0;
  }

  /**
   * @param {Int16Array} input
   * @returns {Float32Array}
   */
  push(input) {
    const n = input.length;
    if (n === 0) return new Float32Array(0);
    /** @param {number} i */
    const at = (i) => (i < 0 ? this.last : /** @type {number} */ (input[i]) / 32768);
    /** @type {number[]} */
    const out = [];
    let pos = this.position;
    while (pos <= n - 1) {
      const i = Math.floor(pos);
      const frac = pos - i;
      if (frac === 0) out.push(at(i));
      else if (i + 1 <= n - 1) out.push(at(i) + (at(i + 1) - at(i)) * frac);
      else break;
      pos += this.step;
    }
    this.position = pos - n;
    this.last = /** @type {number} */ (input[n - 1]) / 32768;
    return Float32Array.from(out);
  }
}
