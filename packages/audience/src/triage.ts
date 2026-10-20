import { ClockService, definePlugin, defineService } from '@bellis/kernel';
import Type from 'typebox';
import { contentKey, looksLikeInjection, sanitizeName, sanitizeText } from './sanitize.ts';

/** 平台送来的一条弹幕。昵称与留言都是不可信输入。 */
export interface Danmaku {
  id: string;
  /** 平台给的稳定身份（B 站开放平台为 open_id）。 */
  viewer: string;
  nickname: string;
  text: string;
}

/** 接收缺口（见观众接入“缺口”）：从失去接收到重新接收之间，这段时间的弹幕收不到。 */
export interface DanmakuGap {
  reason: string;
}

export interface DanmakuSource {
  subscribe(listener: (danmaku: Danmaku) => void): () => void;
  /** 此刻在缺口中时返回缺口，正常接收时为 undefined。没有缺口概念的来源可以不提供。 */
  gap?(): DanmakuGap | undefined;
  /** 缺口开始（收到缺口）与结束（收到 undefined）时同步通知。 */
  onGap?(listener: (gap: DanmakuGap | undefined) => void): () => void;
}

export const DanmakuService = defineService<DanmakuSource>('danmaku', 1);

/** 分诊后的候选：只含净化后的称呼与文本。 */
export interface Candidate {
  id: string;
  /** 合并进来的弹幕编号。 */
  sources: string[];
  viewers: string[];
  /** 净化后的称呼（多名观众合并时取第一位）。 */
  name: string;
  text: string;
  /** 合并的弹幕数。 */
  count: number;
  /** 命中提示注入检测时为 true，排在最后。 */
  injection: boolean;
  receivedAt: number;
  updatedAt: number;
}

export interface Candidates {
  /** 取出候选交给决策模型：先剔除过期的，按非注入、合并数、新近排序。 */
  take(max: number): Candidate[];
  onAvailable(listener: () => void): () => void;
  readonly size: number;
}

export const CandidatesService = defineService<Candidates>('candidates', 1);

/**
 * 弹幕分诊：净化称呼与文本、提示注入检测（降权或丢弃）、合并同一观众的连续消息与多名观众的同质内容、
 * 容量与年龄上限。普通弹幕从不抢占正在进行的发言。
 */
export const triage = definePlugin({
  manifest: {
    id: 'audience-triage',
    version: '0.1.0',
    tier: 'ordinary',
    provides: [CandidatesService.ref],
    inject: [DanmakuService.ref, ClockService.ref],
    permissions: [],
    process: 'in-process',
    config: Type.Object({
      maxCandidates: Type.Integer({ minimum: 1, default: 20 }),
      maxAgeMs: Type.Integer({ minimum: 1, default: 30_000 }),
      /** 同一观众在这段时间内的连续消息合并为一条。 */
      mergeWindowMs: Type.Integer({ minimum: 0, default: 5_000 }),
      maxNameLength: Type.Integer({ minimum: 1, default: 12 }),
      maxTextLength: Type.Integer({ minimum: 1, default: 60 }),
      blockedNameWords: Type.Array(Type.String({ minLength: 1 }), { default: [] }),
      /** 为 true 时丢弃命中注入检测的弹幕，否则降权保留。 */
      dropInjection: Type.Boolean({ default: false }),
    }),
  },
  activate(ctx) {
    const clock = ctx.service(ClockService);
    const source = ctx.service(DanmakuService);
    const config = ctx.config;
    const pending: Candidate[] = [];
    const listeners = new Set<() => void>();

    const prune = () => {
      const now = clock.now();
      for (let i = pending.length - 1; i >= 0; i -= 1) {
        if (now - (pending[i] as Candidate).updatedAt > config.maxAgeMs) pending.splice(i, 1);
      }
    };

    const accept = (danmaku: Danmaku) => {
      const now = clock.now();
      const text = sanitizeText(danmaku.text, config.maxTextLength);
      if (!text) return;
      const injection = looksLikeInjection(danmaku.text);
      if (injection) {
        ctx.log('triage.injection', { id: danmaku.id, dropped: config.dropInjection });
        if (config.dropInjection) return;
      }
      prune();
      const name = sanitizeName(danmaku.nickname, config);
      const sameViewer = pending.findLast(
        (c) =>
          c.viewers.length === 1 &&
          c.viewers[0] === danmaku.viewer &&
          now - c.updatedAt <= config.mergeWindowMs,
      );
      const sameContent = pending.find((c) => contentKey(c.text) === contentKey(text));
      if (sameContent) {
        sameContent.count += 1;
        sameContent.sources.push(danmaku.id);
        if (!sameContent.viewers.includes(danmaku.viewer)) sameContent.viewers.push(danmaku.viewer);
        sameContent.injection ||= injection;
        sameContent.updatedAt = now;
      } else if (sameViewer) {
        sameViewer.text = sanitizeText(`${sameViewer.text} ${text}`, config.maxTextLength);
        sameViewer.count += 1;
        sameViewer.sources.push(danmaku.id);
        sameViewer.injection ||= injection;
        sameViewer.updatedAt = now;
      } else {
        pending.push({
          id: `c-${danmaku.id}`,
          sources: [danmaku.id],
          viewers: [danmaku.viewer],
          name,
          text,
          count: 1,
          injection,
          receivedAt: now,
          updatedAt: now,
        });
        if (pending.length > config.maxCandidates) pending.shift();
      }
      for (const listener of [...listeners]) listener();
    };

    ctx.register(source.subscribe(accept));
    ctx.provide(CandidatesService, {
      take(max) {
        prune();
        const ranked = [...pending].sort(
          (a, b) =>
            Number(a.injection) - Number(b.injection) ||
            b.count - a.count ||
            b.updatedAt - a.updatedAt,
        );
        const taken = ranked.slice(0, max);
        for (const candidate of taken) pending.splice(pending.indexOf(candidate), 1);
        return taken;
      },
      onAvailable(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      get size() {
        prune();
        return pending.length;
      },
    });
  },
});
