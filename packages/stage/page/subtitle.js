// @ts-check
/**
 * Stage 页面的字幕推进，与浏览器无关：页面与模拟 Stage 页面共用，宿主的测试在 Node 里直接导入本模块。
 * 规则见 Stage 文档的“字幕”：
 * - 映射 `starts[k]` 是字幕文本第 k 个码点开始显示的原始采样偏移，按 k 不减，可以比字幕的码点少；
 * - 播放进度是 AudioWorklet 回报的已播采样数，只算正文（唤醒信号与欠载补零不计入），
 *   来自 started（即 0）、progress、cursor 与 underrun；
 * - 显示开始时刻不晚于显示位置（目前就是已播采样数）的码点组成的前缀；没有映射时一开始播放就整句显示；
 *   已显示的字不收回；
 * - 版面固定：一句开始播放就把整句排好，输出分成“已显示”与“未显示”两段，页面把后一段放在不可见的
 *   占位元素里，字只是逐个变得可见；
 * - 播完或截断即清除，两段都清空；
 * - 只在任一段变化时调用 `write`，页面在其中只写 `textContent`。
 */

/**
 * @typedef {object} Line
 * @property {string[]} chars 字幕文本的码点
 * @property {readonly number[] | null} starts 字幕映射；null 表示没有
 * @property {number} played 已播出的原始采样数
 */

/**
 * @typedef {{ kind: string, sentenceId?: string, played?: number }} Report
 */

/**
 * 映射是否可用：非负整数、按码点不减。宿主发送前已按 Schema 校验，这里只防页面因坏数据出错。
 * @param {unknown} starts
 * @returns {starts is number[]}
 */
export function validStarts(starts) {
  if (!Array.isArray(starts)) return false;
  let previous = 0;
  for (const start of starts) {
    if (!Number.isInteger(start) || start < previous) return false;
    previous = start;
  }
  return true;
}

/**
 * 显示位置为 `position`（原始采样）时应显示的码点数：开始不晚于它的码点个数。
 * @param {readonly number[]} starts
 * @param {number} position
 */
export function visibleCount(starts, position) {
  let count = 0;
  while (count < starts.length && /** @type {number} */ (starts[count]) <= position) count += 1;
  return count;
}

export class Subtitles {
  /** @param {(shown: string, hidden: string, sentenceId: string | null) => void} write 已显示与未显示的两段 */
  constructor(write) {
    this.write = write;
    /** 已开始一句、还没播完或截断的句子。 @type {Map<string, Line>} */
    this.lines = new Map();
    /** 正在显示的句子。 @type {string | null} */
    this.current = null;
    /** 正在显示的码点数。 */
    this.shown = 0;
    /** 最近一次写出的两段。 */
    this.output = { shown: '', hidden: '' };
  }

  /** 宿主开始一句（令牌已核对）。 @param {string} id @param {string} text */
  begin(id, text) {
    this.lines.set(id, { chars: [...text], starts: null, played: 0 });
  }

  /** 这一句的字幕映射（整份替换）；不认识的句子与不可用的映射忽略。 @param {string} id @param {unknown} starts */
  timing(id, starts) {
    const line = this.lines.get(id);
    if (!line || !validStarts(starts) || starts.length > line.chars.length) return;
    line.starts = starts;
    if (this.current === id) this.render();
  }

  /** AudioWorklet 的回报。 @param {Report} report */
  report(report) {
    const id = report.sentenceId;
    if (id === undefined) return;
    switch (report.kind) {
      case 'started':
        if (!this.lines.has(id)) return;
        if (this.current !== id) {
          this.put('', '');
          this.current = id;
          this.shown = 0;
        }
        this.render();
        return;
      case 'progress':
      case 'cursor':
      case 'underrun': {
        const line = this.lines.get(id);
        if (!line || typeof report.played !== 'number') return;
        line.played = Math.max(line.played, report.played);
        if (this.current === id) this.render();
        return;
      }
      case 'ended':
      case 'truncated':
        this.forget(id);
        return;
    }
  }

  /** 这一句已播完、被截断或不再有效：立即清除，之后它的回报与映射都忽略。 @param {string} id */
  forget(id) {
    this.lines.delete(id);
    if (this.current !== id) return;
    this.put('', '');
    this.current = null;
    this.shown = 0;
  }

  /** 令牌变化：全部清除。 */
  clear() {
    for (const id of [...this.lines.keys()]) this.forget(id);
    this.put('', '');
    this.current = null;
    this.shown = 0;
  }

  /**
   * 这一句的显示位置（原始采样）：字幕按它推进。目前就是已播采样数；要按输出时延推迟字幕时在这里减去。
   * @param {Line} line
   */
  position(line) {
    return line.played;
  }

  /** 按当前显示位置显示，只增不减；整句一开始就排好。 */
  render() {
    const line = this.current === null ? undefined : this.lines.get(this.current);
    if (!line) return;
    const count =
      line.starts === null
        ? line.chars.length
        : Math.max(this.shown, visibleCount(line.starts, this.position(line)));
    this.shown = count;
    this.put(line.chars.slice(0, count).join(''), line.chars.slice(count).join(''));
  }

  /** 任一段变化时才写出。 @param {string} shown @param {string} hidden */
  put(shown, hidden) {
    if (shown === this.output.shown && hidden === this.output.hidden) return;
    this.output = { shown, hidden };
    this.write(shown, hidden, this.current);
  }
}
