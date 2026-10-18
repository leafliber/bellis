import { ClockService, definePlugin, type TimerHandle, TraceService } from '@bellis/kernel';
import Type from 'typebox';
import { Subtitles } from '../page/subtitle.js';
import { type FromPage, type PageLink, StagePageService, type ToPage } from './types.ts';

interface Buffered {
  id: string;
  token: number;
  sampleRate: number;
  chunks: Int16Array[];
  offset: number;
  played: number;
  ended: boolean;
  started: boolean;
  underrun: boolean;
}

/**
 * 模拟 Stage 页面（OBS 浏览器源）：按自己的时钟逐拍消耗音频。
 * - 欠载时补零，补零不推进播放游标；
 * - 只接受当前令牌的音频，令牌变化时丢弃旧令牌的全部缓冲；
 * - 收不到宿主心跳时自行静音并清空缓冲，再次收到心跳后恢复；
 * - 字幕与真实页面用同一套推进规则（page/subtitle.js，含呈现延迟，按宿主时钟推迟），
 *   每次显示变化记追踪 `page.subtitle`（`text` 为已显示的前缀，`hidden` 为占位的其余部分）。
 */
export const simStagePage = definePlugin({
  manifest: {
    id: 'stage-page-sim',
    version: '0.1.0',
    tier: 'ordinary',
    provides: [StagePageService.ref],
    inject: [ClockService.ref, `${TraceService.ref}?`],
    permissions: [],
    process: 'in-process',
    config: Type.Object({
      tickMs: Type.Integer({ minimum: 1, default: 20 }),
      heartbeatTimeoutMs: Type.Integer({ minimum: 1, default: 1000 }),
    }),
  },
  activate(ctx) {
    const clock = ctx.service(ClockService);
    const trace = ctx.optional(TraceService);
    const { tickMs, heartbeatTimeoutMs } = ctx.config;
    const listeners = new Set<(message: FromPage) => void>();
    const queue: Buffered[] = [];
    let token: number | null = null;
    let validUntil = Number.NEGATIVE_INFINITY;
    let lastHeartbeat = clock.now();
    let muted = false;
    let timer: TimerHandle | undefined;

    const emit = (message: FromPage) => {
      trace?.record(`page.${message.kind}`, { ...message });
      for (const listener of [...listeners]) listener(message);
    };
    const subtitles = new Subtitles(
      (text, hidden, sentenceId) => {
        trace?.record('page.subtitle', { sentenceId, text, hidden });
      },
      {
        now: () => clock.now(),
        set: (callback, ms) => clock.setTimeout(callback, ms),
        clear: (handle) => clock.clearTimeout(handle as TimerHandle),
      },
    );
    const drop = (predicate: (b: Buffered) => boolean, reason: string) => {
      for (const item of queue.filter(predicate)) {
        queue.splice(queue.indexOf(item), 1);
        subtitles.forget(item.id);
        emit({ kind: 'truncated', sentenceId: item.id, played: item.played, reason });
      }
    };
    const find = (id: string) => queue.find((item) => item.id === id);

    const tick = () => {
      timer = clock.setTimeout(tick, tickMs);
      if (!muted && clock.now() - lastHeartbeat > heartbeatTimeoutMs) {
        muted = true;
        drop(() => true, '宿主心跳丢失');
        // 与真实页面相同：自静音时连只差推迟清除的字幕也立即清除。
        subtitles.clear();
        emit({ kind: 'muted', reason: '宿主心跳丢失' });
      }
      if (token !== null && clock.now() >= validUntil) {
        token = null;
        drop(() => true, '许可过期');
      }
      const head = queue[0];
      if (muted || !head) return;
      // 每拍按采样率消耗的采样数。
      const budget = Math.round((head.sampleRate * tickMs) / 1000);
      let consumed = 0;
      while (consumed < budget && head.chunks.length > 0) {
        const chunk = head.chunks[0] as Int16Array;
        const take = Math.min(budget - consumed, chunk.length - head.offset);
        consumed += take;
        head.offset += take;
        if (head.offset >= chunk.length) {
          head.chunks.shift();
          head.offset = 0;
        }
      }
      if (consumed > 0) {
        trace?.record('page.played', { sentenceId: head.id, token: head.token, samples: consumed });
        if (!head.started) {
          head.started = true;
          emit({ kind: 'started', sentenceId: head.id });
          subtitles.report({ kind: 'started', sentenceId: head.id });
        }
        head.played += consumed;
        head.underrun = false;
        emit({ kind: 'cursor', sentenceId: head.id, played: head.played });
        subtitles.report({ kind: 'progress', sentenceId: head.id, played: head.played });
      }
      if (head.chunks.length === 0) {
        if (head.ended) {
          queue.shift();
          subtitles.report({ kind: 'ended', sentenceId: head.id, played: head.played });
          emit({ kind: 'ended', sentenceId: head.id, played: head.played });
        } else if (consumed < budget && !head.underrun) {
          head.underrun = true;
          emit({ kind: 'underrun', sentenceId: head.id, played: head.played });
        }
      }
    };

    const receive = (message: ToPage) => {
      switch (message.kind) {
        case 'heartbeat':
          lastHeartbeat = clock.now();
          muted = false;
          emit({ kind: 'heartbeat-ack' });
          return;
        case 'token':
          validUntil = clock.now() + message.ttlMs;
          if (message.token !== token) {
            token = message.token;
            drop((item) => item.token !== token, '令牌已变化');
          }
          return;
        case 'begin':
          if (message.token !== token || muted) {
            // 不接受的句子也要回报，Stage 服务据此结束等待。
            emit({
              kind: 'truncated',
              sentenceId: message.sentenceId,
              played: 0,
              reason: muted ? '页面已静音' : '令牌无效',
            });
            return;
          }
          trace?.record('page.begin', {
            sentenceId: message.sentenceId,
            token: message.token,
            subtitle: message.subtitle,
          });
          queue.push({
            id: message.sentenceId,
            token: message.token,
            sampleRate: message.sampleRate,
            chunks: [],
            offset: 0,
            played: 0,
            ended: false,
            started: false,
            underrun: false,
          });
          subtitles.begin(message.sentenceId, message.subtitle);
          return;
        case 'timing': {
          // 旧令牌与已截断的句子的映射丢弃。
          const item = find(message.sentenceId);
          if (item && message.token === token && item.token === token) {
            subtitles.timing(message.sentenceId, message.starts);
          }
          return;
        }
        case 'audio': {
          const item = find(message.sentenceId);
          if (!item || message.token !== token || item.token !== token) return;
          item.chunks.push(message.pcm);
          return;
        }
        case 'end': {
          const item = find(message.sentenceId);
          if (item && message.token === token) item.ended = true;
          return;
        }
        case 'truncate':
          drop((item) => item.id === message.sentenceId, '要求截断');
          return;
        case 'presentation':
          trace?.record('page.presentation', { delayMs: message.delayMs });
          subtitles.setDelay(message.delayMs);
          return;
      }
    };

    tick();
    ctx.register(() => {
      if (timer) clock.clearTimeout(timer);
      subtitles.cancel();
    });
    const link: PageLink = {
      send: receive,
      onMessage(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    ctx.provide(StagePageService, link);
  },
});
