import { speakable } from '@bellis/speech';
import type { StoredEvent } from '@bellis/store';
import { BLOCKED, SAMPLES_PER_CHAR } from './scenario.ts';
import type { TraceEntry } from './world.ts';

/** 全部世界（含重启前后）的追踪与最终的事件，供不变量检查。 */
export interface History {
  /** 按发生顺序拼接的追踪；每次启动前有一条 `world.start`。 */
  trace: TraceEntry[];
  events: StoredEvent[];
  moderationEnabled: boolean;
}

/**
 * 仿真的不变量。每条返回违反说明（空数组表示通过）。
 * 1. 审核启用时，含禁词的句子从未在 Stage 上开始；
 * 2. 安全停止期间 Stage 没有播出任何采样；
 * 3. 写回的内容恰好是 Stage 回报已播出的部分（按模拟 TTS 每码点的采样数，从页面回报的采样数独立推出）；
 * 4. 同一句话从未在 Stage 上开始两次（含跨重启），同一意图从未执行两次。
 */
export function checkHistory(history: History): string[] {
  const violations: string[] = [];
  const begun = new Map<string, string>();
  const ended = new Set<string>();
  const truncated = new Map<string, number>();
  let mode = 'safe-stop';

  for (const entry of history.trace) {
    switch (entry.kind) {
      case 'world.start':
        mode = 'safe-stop';
        break;
      case 'control.mode':
        mode = String(entry.data.mode);
        break;
      case 'page.begin': {
        const id = String(entry.data.sentenceId);
        const subtitle = String(entry.data.subtitle);
        if (begun.has(id))
          violations.push(`句子 ${id} 在 Stage 上开始了两次（第 ${entry.seq} 条追踪）`);
        begun.set(id, subtitle);
        if (history.moderationEnabled && subtitle.includes(BLOCKED)) {
          violations.push(`审核启用时含禁词的句子 ${id} 在 Stage 上开始：${subtitle}`);
        }
        break;
      }
      case 'page.played':
        if (mode === 'safe-stop') {
          violations.push(
            `安全停止期间 Stage 播出了 ${String(entry.data.sentenceId)}（第 ${entry.seq} 条追踪）`,
          );
        }
        break;
      case 'page.ended':
        ended.add(String(entry.data.sentenceId));
        break;
      case 'page.truncated':
        truncated.set(String(entry.data.sentenceId), Number(entry.data.played));
        break;
    }
  }

  for (const event of history.events.filter((e) => e.type === 'utterance.played')) {
    const { id, heard } = event.data as { id: string; heard: string };
    const sentences = [...begun.keys()]
      .filter((key) => key.startsWith(`${id}#`))
      .sort((a, b) => Number(a.split('#').at(-1)) - Number(b.split('#').at(-1)));
    let expected = '';
    for (const key of sentences) {
      const subtitle = begun.get(key) as string;
      if (ended.has(key)) {
        expected += subtitle;
        continue;
      }
      // 只计入完整播出的朗读码点，再按对齐表换回字幕位置。
      const played = truncated.get(key) ?? 0;
      const chars = Math.floor(played / SAMPLES_PER_CHAR);
      const { align } = speakable(subtitle);
      if (chars > 0) expected += [...subtitle].slice(0, (align[chars - 1] as number) + 1).join('');
      break;
    }
    if (heard !== expected) {
      violations.push(`发言 ${id} 写回“${heard}”，但 Stage 回报观众听到的是“${expected}”`);
    }
  }

  const started = new Map<number, number>();
  for (const event of history.events.filter((e) => e.type === 'intent.started')) {
    const intentId = (event.data as { id: number }).id;
    started.set(intentId, (started.get(intentId) ?? 0) + 1);
  }
  for (const [intentId, times] of started) {
    if (times > 1) violations.push(`意图 ${intentId} 执行了 ${times} 次`);
  }
  return violations;
}
