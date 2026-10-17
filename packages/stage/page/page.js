// @ts-check
/**
 * Stage 页面（OBS 浏览器源，R-08、R-09）：用 AudioWorklet 播放宿主转发的音频，字幕随播放游标显示。
 *
 * - 一次性令牌在 URL 片段里，读出后立即从地址中去掉，以首条消息出示，换成只存于内存的会话密钥；
 *   连接断开后用会话密钥重连。页面不在任何存储里保存密钥。
 * - 只播放带当前许可令牌的音频，令牌变化即丢弃旧缓冲；许可时长与心跳由 AudioWorklet 按渲染帧计时。
 * - 字幕只用 textContent 渲染。
 */
import { decodeAudio, Resampler } from './audio.js';

/**
 * @typedef {{ kind: 'welcome', sessionKey: string }
 *   | { kind: 'token', token: number | null, ttlMs: number }
 *   | { kind: 'begin', sentenceId: string, token: number, subtitle: string, sampleRate: number }
 *   | { kind: 'end', sentenceId: string, token: number }
 *   | { kind: 'truncate', sentenceId: string }
 *   | { kind: 'heartbeat' }} FromHost
 */

/**
 * @typedef {object} Playing
 * @property {Resampler} resampler
 * @property {number} token
 * @property {string} subtitle
 * @property {number} source 已转给 AudioWorklet 的原始采样数
 */

const RECONNECT_MS = 500;
/** 宿主拒绝认证的关闭码：不再重连，等宿主重新下发 URL。 */
const REJECTED = new Set([4401, 4408]);

const subtitle = /** @type {HTMLElement} */ (document.getElementById('subtitle'));
let token = new URLSearchParams(location.hash.slice(1)).get('t');
history.replaceState(null, '', location.pathname);

/** @type {string | null} */
let sessionKey = null;
/** @type {number | null} */
let leaseToken = null;
/** @type {Map<string, Playing>} */
const playing = new Map();
/** 正在显示字幕的句子。 @type {string | null} */
let shown = null;

const context = new AudioContext({ latencyHint: 'playback' });
await context.resume().catch(() => {});
await context.audioWorklet.addModule('/worklet.js');
const node = new AudioWorkletNode(context, 'bellis-stage', { outputChannelCount: [2] });
node.connect(context.destination);

/** @type {WebSocket | null} */
let socket = null;

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
  if (shown === sentenceId) {
    shown = null;
    subtitle.textContent = '';
  }
}

node.port.onmessage = (event) => {
  const report = /** @type {{ kind: string, sentenceId?: string }} */ (event.data);
  if (report.kind === 'started' && report.sentenceId) {
    shown = report.sentenceId;
    subtitle.textContent = playing.get(report.sentenceId)?.subtitle ?? '';
  } else if ((report.kind === 'ended' || report.kind === 'truncated') && report.sentenceId) {
    forget(report.sentenceId);
  }
  send(report);
};

/** @param {FromHost} message */
function receive(message) {
  switch (message.kind) {
    case 'welcome':
      sessionKey = message.sessionKey;
      return;
    case 'heartbeat':
      toWorklet({ type: 'hb' });
      send({ kind: 'heartbeat-ack' });
      return;
    case 'token':
      if (message.token !== leaseToken) {
        leaseToken = message.token;
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
        subtitle: message.subtitle,
        source: 0,
      });
      toWorklet({ type: 'begin', id: message.sentenceId });
      return;
    case 'end': {
      const sentence = playing.get(message.sentenceId);
      if (sentence && message.token === leaseToken) {
        toWorklet({ type: 'end', id: message.sentenceId, src: sentence.source });
      }
      return;
    }
    case 'truncate':
      toWorklet({ type: 'truncate', id: message.sentenceId });
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
