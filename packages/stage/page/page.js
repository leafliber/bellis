// @ts-check
/**
 * Stage 页面（OBS 浏览器源，R-08、R-09）：用 AudioWorklet 播放宿主转发的音频，字幕随播放游标显示。
 *
 * - 一次性令牌在 URL 片段里，读出后立即从地址中去掉，以首条消息出示，换成只存于内存的会话密钥；
 *   连接断开后用会话密钥重连。页面不在任何存储里保存密钥。
 * - 只播放带当前许可令牌的音频，令牌变化即丢弃旧缓冲；许可时长与心跳由 AudioWorklet 按渲染帧计时。
 * - 字幕按 AudioWorklet 回报的已播采样数与宿主送来的映射推进（subtitle.js），只用 textContent 渲染；
 *   未显示的字放在不可见的占位元素里，版面从一开始就固定；按宿主送来的呈现延迟推迟显示与播完后的清除，
 *   截断、页面静音以及令牌变化时还在播放的句子立即清除。
 */
import { decodeAudio, Resampler } from './audio.js';
import { latencyHintOf, latencyStats, statsEveryOf } from './diagnostics.js';
import { Subtitles } from './subtitle.js';

/**
 * @typedef {{ kind: 'welcome', sessionKey: string }
 *   | { kind: 'token', token: number | null, ttlMs: number }
 *   | { kind: 'begin', sentenceId: string, token: number, subtitle: string, sampleRate: number }
 *   | { kind: 'timing', sentenceId: string, token: number, starts: number[] }
 *   | { kind: 'end', sentenceId: string, token: number }
 *   | { kind: 'truncate', sentenceId: string }
 *   | { kind: 'presentation', delayMs: number }
 *   | { kind: 'heartbeat' }} FromHost
 */

/**
 * @typedef {object} Playing
 * @property {Resampler} resampler
 * @property {number} token
 * @property {number} source 已转给 AudioWorklet 的原始采样数
 */

const RECONNECT_MS = 500;
/** 宿主拒绝认证的关闭码：不再重连，等宿主重新下发 URL。 */
const REJECTED = new Set([4401, 4408]);

/** 字幕的已显示前缀与不可见的其余部分（占位，固定版面）。 */
const shownText = /** @type {HTMLElement} */ (document.getElementById('subtitle-shown'));
const hiddenText = /** @type {HTMLElement} */ (document.getElementById('subtitle-hidden'));
const fragment = new URLSearchParams(location.hash.slice(1));
let token = fragment.get('t');
// 诊断项（缺省关闭，见 diagnostics.js）。
const latencyHint = latencyHintOf(fragment);
const statsEveryMs = statsEveryOf(fragment);
history.replaceState(null, '', location.pathname);

/** @type {string | null} */
let sessionKey = null;
/** @type {number | null} */
let leaseToken = null;
/** @type {Map<string, Playing>} */
const playing = new Map();
const subtitles = new Subtitles((shown, hidden) => {
  if (shownText.textContent !== shown) shownText.textContent = shown;
  if (hiddenText.textContent !== hidden) hiddenText.textContent = hidden;
});

const context = new AudioContext({ latencyHint });
await context.resume().catch(() => {});
await context.audioWorklet.addModule('/worklet.js');
const node = new AudioWorkletNode(context, 'bellis-stage', { outputChannelCount: [2] });
node.connect(context.destination);

/** @type {WebSocket | null} */
let socket = null;
/** 诊断回报的定时器（重连后不重复开）。 @type {ReturnType<typeof setInterval> | undefined} */
let statsTimer;

/** @param {object} message */
function send(message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

/** @param {object} command @param {Transferable[]} [transfer] */
function toWorklet(command, transfer = []) {
  node.port.postMessage(command, transfer);
}

/** @param {string} sentenceId */
function forget(sentenceId) {
  playing.delete(sentenceId);
  subtitles.forget(sentenceId);
}

node.port.onmessage = (event) => {
  const report = /** @type {{ kind: string, sentenceId?: string, played?: number }} */ (event.data);
  if (report.kind === 'truncated' && report.sentenceId) {
    forget(report.sentenceId);
  } else if (report.kind === 'muted') {
    subtitles.clear();
  } else {
    // 播完的句子不会再有音频；字幕推迟呈现延迟后再清除。
    if (report.kind === 'ended' && report.sentenceId) playing.delete(report.sentenceId);
    subtitles.report(report);
  }
  // progress 只用来推进字幕，宿主不收。
  if (report.kind !== 'progress') send(report);
};

/** @param {FromHost} message */
function receive(message) {
  switch (message.kind) {
    case 'welcome':
      sessionKey = message.sessionKey;
      if (statsEveryMs > 0 && statsTimer === undefined) {
        statsTimer = setInterval(() => send(latencyStats(context, latencyHint)), statsEveryMs);
      }
      return;
    case 'heartbeat':
      toWorklet({ type: 'hb' });
      send({ kind: 'heartbeat-ack' });
      return;
    case 'token':
      if (message.token !== leaseToken) {
        leaseToken = message.token;
        // 旧令牌的句子作废：还在播放或排队的字幕立即清除，AudioWorklet 随后回报它们被截断。
        // 已经播完的句子声音都已交给 OBS，只差推迟的呈现延迟，照常到点清除：每段发言播完、
        // 许可交还时令牌也会变。
        for (const id of playing.keys()) subtitles.forget(id);
        playing.clear();
        toWorklet({ type: 'revoke' });
      }
      if (message.token !== null) toWorklet({ type: 'lease', ttlMs: message.ttlMs });
      return;
    case 'begin':
      if (message.token !== leaseToken) {
        send({ kind: 'truncated', sentenceId: message.sentenceId, played: 0, reason: '令牌无效' });
        return;
      }
      playing.set(message.sentenceId, {
        resampler: new Resampler(message.sampleRate, context.sampleRate),
        token: message.token,
        source: 0,
      });
      subtitles.begin(message.sentenceId, message.subtitle);
      toWorklet({ type: 'begin', id: message.sentenceId });
      return;
    case 'timing':
      // 只收当前令牌、还在播放的句子的映射；旧令牌与已截断的句子丢弃。
      if (message.token === leaseToken && playing.get(message.sentenceId)?.token === leaseToken) {
        subtitles.timing(message.sentenceId, message.starts);
      }
      return;
    case 'end': {
      const sentence = playing.get(message.sentenceId);
      if (sentence && message.token === leaseToken) {
        toWorklet({ type: 'end', id: message.sentenceId, src: sentence.source });
      }
      return;
    }
    case 'truncate':
      // 字幕立即清除，不等 AudioWorklet 回报。
      forget(message.sentenceId);
      toWorklet({ type: 'truncate', id: message.sentenceId });
      return;
    case 'presentation':
      subtitles.setDelay(message.delayMs);
      return;
  }
}

/** @param {ArrayBuffer} buffer */
function receiveAudio(buffer) {
  const frame = decodeAudio(buffer);
  if (!frame || frame.header.token !== leaseToken) return;
  const sentence = playing.get(frame.header.sentenceId);
  if (!sentence || sentence.token !== leaseToken) return;
  const data = sentence.resampler.push(frame.pcm);
  sentence.source += frame.pcm.length;
  toWorklet({ type: 'pcm', id: frame.header.sentenceId, data, src: frame.pcm.length }, [
    data.buffer,
  ]);
}

function connect() {
  const ws = new WebSocket(`ws://${location.host}/stage`);
  ws.binaryType = 'arraybuffer';
  socket = ws;
  ws.onopen = () => {
    if (sessionKey) {
      send({ kind: 'resume', sessionKey });
    } else {
      // 没有令牌（刷新后片段已被去掉）也照样报到，宿主据此重新下发 URL。
      const obs = /** @type {{ obsstudio?: { pluginVersion?: string } }} */ (globalThis).obsstudio;
      send({
        kind: 'hello',
        token: token ?? null,
        obs: obs?.pluginVersion ?? null,
        userAgent: navigator.userAgent,
        sampleRate: context.sampleRate,
      });
      // 一次性令牌只出示一次。
      token = null;
    }
  };
  ws.onmessage = (event) => {
    if (event.data instanceof ArrayBuffer) receiveAudio(event.data);
    else receive(/** @type {FromHost} */ (JSON.parse(String(event.data))));
  };
  ws.onclose = (event) => {
    if (socket === ws) socket = null;
    if (REJECTED.has(event.code)) sessionKey = null;
    if (sessionKey) setTimeout(connect, RECONNECT_MS);
  };
}

connect();
