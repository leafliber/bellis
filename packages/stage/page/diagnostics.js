// @ts-check
/**
 * Stage 页面从 URL 片段读的两项设置（宿主经 stage-page-obs 的 latencyHint 与 statsEveryMs 写入，只在与缺省
 * 不同时写）：
 *
 * - `l=playback`：AudioContext 改用 playback 的 latencyHint（缺省 interactive，见 Stage 文档“对齐”）。
 * - `s=<毫秒>`：诊断，缺省关闭。认证后每隔这么久回报一次浏览器自报的音频输出时延（`stats` 消息，宿主只记日志）。
 */

/** @typedef {'playback' | 'interactive'} LatencyHint */

/**
 * AudioContext 里用到的部分（不引用 DOM 的类型：宿主的测试在 Node 里直接导入本模块）。
 * @typedef {{ sampleRate: number, baseLatency?: number, outputLatency?: number, currentTime: number,
 *   getOutputTimestamp(): { contextTime?: number, performanceTime?: number } }} LatencySource
 */

/** @param {URLSearchParams} fragment @returns {LatencyHint} */
export function latencyHintOf(fragment) {
  return fragment.get('l') === 'playback' ? 'playback' : 'interactive';
}

/** 回报间隔（毫秒）；没有或不合法时为 0（关闭）。 @param {URLSearchParams} fragment */
export function statsEveryOf(fragment) {
  const value = Number(fragment.get('s'));
  return Number.isInteger(value) && value >= 100 && value <= 60_000 ? value : 0;
}

/** @param {unknown} value */
const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/**
 * 浏览器自报的音频输出时延：baseLatency、outputLatency，以及 getOutputTimestamp() 给出的
 * “正由输出设备呈现的那一帧”与它的呈现时刻，配上此刻的 currentTime 与 performance.now()。
 * 由此可得：已渲染的位置要再过多久才被呈现 = (currentTime − outputContextTime) + (outputPerformanceTime − performanceNow)/1000。
 * @param {LatencySource} context
 * @param {LatencyHint} latencyHint
 */
export function latencyStats(context, latencyHint) {
  const stamp = context.getOutputTimestamp();
  return {
    kind: 'stats',
    latencyHint,
    sampleRate: context.sampleRate,
    baseLatency: finite(context.baseLatency),
    outputLatency: finite(context.outputLatency),
    currentTime: context.currentTime,
    outputContextTime: finite(stamp.contextTime),
    outputPerformanceTime: finite(stamp.performanceTime),
    performanceNow: performance.now(),
  };
}
