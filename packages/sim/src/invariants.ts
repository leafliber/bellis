import { speakable } from '@bellis/speech';
import type { StoredEvent } from '@bellis/store';
import { BLOCKED, SAMPLE_RATE, SAMPLES_PER_CHAR } from './scenario.ts';
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
 *    急停且 OBS 应急动作成功时，急停那一刻正在播的句子先扣掉页面当时的呈现延迟（按模拟 TTS 的采样率折算）；
 * 4. 同一句话从未在 Stage 上开始两次（含跨重启），同一意图从未执行两次；
 * 5. 字幕不早于游标：页面显示的是这一句字幕的前缀，其中有朗读的码点都已开始播出（按模拟 TTS 每码点的
 *    采样数，与页面当时已播出的采样数比较）；版面固定：已显示与占位的两段拼起来总是整句；
 * 6. 页面回报一句截断时，这一句的字幕（两段）已经清除；回报播完时，至迟在呈现延迟之后清除。
 */
export function checkHistory(history: History): string[] {
  const violations: string[] = [];
  /** 全部世界里开始过的句子：同一句不能开始两次（含跨重启）。 */
  const everBegun = new Set<string>();
  /** 当前世界里开始过、播完、被截断的句子：一段发言只会在一个世界里播出。 */
  let begun = new Map<string, string>();
  let ended = new Set<string>();
  let truncated = new Map<string, number>();
  let truncatedAt = new Map<string, number>();
  /** 当前世界里每句已播出的采样数（由页面每拍播出的采样数累计）与页面正在显示的字幕。 */
  let played = new Map<string, number>();
  let shown: { sentenceId: string; cleared: boolean } | undefined;
  let mode = 'safe-stop';
  /** 页面当前的呈现延迟（毫秒）。 */
  let delayMs = 0;
  /** 播完、字幕还在等推迟清除的句子与清除的截止时刻。 */
  let clearDue: { sentenceId: string; due: number } | undefined;
  /** 急停时正在播、等 OBS 应急动作结果的句子与当时的呈现延迟。 */
  let emergencyPending = new Map<string, number>();
  /** 急停时正在播的句子写回要扣掉的采样数（应急动作失败时为 0）。 */
  let emergencyCut = new Map<string, number>();

  for (const entry of history.trace) {
    if (clearDue && entry.at > clearDue.due) {
      if (shown?.sentenceId === clearDue.sentenceId && !shown.cleared) {
        violations.push(
          `句子 ${clearDue.sentenceId} 播完 ${delayMs}ms 后字幕仍未清除（第 ${entry.seq} 条追踪）`,
        );
      }
      clearDue = undefined;
    }
    switch (entry.kind) {
      case 'world.start':
        mode = 'safe-stop';
        begun = new Map();
        ended = new Set();
        truncated = new Map();
        truncatedAt = new Map();
        played = new Map();
        shown = undefined;
        delayMs = 0;
        clearDue = undefined;
        emergencyPending = new Map();
        emergencyCut = new Map();
        break;
      case 'control.mode':
        mode = String(entry.data.mode);
        break;
      case 'control.stop':
        // 急停那一刻还在 Stage 上的句子：没播完也没截断，或正是被这次急停吊销许可截断的
        // （急停先吊销许可、再广播停止，页面的截断回报在同一时刻排在停止之前）。
        for (const id of begun.keys()) {
          const cutNow = truncatedAt.get(id) === entry.at;
          if (ended.has(id) || (truncated.has(id) && !cutNow) || emergencyCut.has(id)) continue;
          if (!emergencyPending.has(id)) emergencyPending.set(id, delayMs);
        }
        break;
      case 'control.emergency-completed':
        for (const [id, delay] of emergencyPending) {
          const cut = Math.round((delay * SAMPLE_RATE) / 1000);
          emergencyCut.set(id, entry.data.obsOk === true ? cut : 0);
        }
        emergencyPending = new Map();
        break;
      case 'page.presentation':
        delayMs = Number(entry.data.delayMs);
        break;
      case 'page.begin': {
        const id = String(entry.data.sentenceId);
        const subtitle = String(entry.data.subtitle);
        if (everBegun.has(id))
          violations.push(`句子 ${id} 在 Stage 上开始了两次（第 ${entry.seq} 条追踪）`);
        everBegun.add(id);
        begun.set(id, subtitle);
        if (history.moderationEnabled && subtitle.includes(BLOCKED)) {
          violations.push(`审核启用时含禁词的句子 ${id} 在 Stage 上开始：${subtitle}`);
        }
        break;
      }
      case 'page.played': {
        if (mode === 'safe-stop') {
          violations.push(
            `安全停止期间 Stage 播出了 ${String(entry.data.sentenceId)}（第 ${entry.seq} 条追踪）`,
          );
        }
        const id = String(entry.data.sentenceId);
        played.set(id, (played.get(id) ?? 0) + Number(entry.data.samples));
        break;
      }
      case 'page.subtitle': {
        const id = String(entry.data.sentenceId);
        const text = String(entry.data.text);
        const hidden = String(entry.data.hidden ?? '');
        shown = { sentenceId: id, cleared: text === '' && hidden === '' };
        if (shown.cleared) break;
        const subtitle = begun.get(id);
        const problem =
          subtitle !== undefined && text + hidden !== subtitle
            ? `已显示“${text}”与占位“${hidden}”拼起来不是整句“${subtitle}”`
            : subtitleAhead(subtitle, text, played.get(id) ?? 0);
        if (problem) violations.push(`句子 ${id} 的字幕${problem}（第 ${entry.seq} 条追踪）`);
        break;
      }
      case 'page.ended':
      case 'page.truncated': {
        const id = String(entry.data.sentenceId);
        if (entry.kind === 'page.ended') ended.add(id);
        else {
          truncated.set(id, Number(entry.data.played));
          truncatedAt.set(id, entry.at);
        }
        if (shown?.sentenceId !== id || shown.cleared) break;
        // 播完的句子推迟呈现延迟再清除；截断立即清除。
        if (entry.kind === 'page.ended' && delayMs > 0) {
          clearDue = { sentenceId: id, due: entry.at + delayMs };
        } else {
          violations.push(`句子 ${id} 播完或截断时字幕没有清除（第 ${entry.seq} 条追踪）`);
        }
        break;
      }
      case 'fact.utterance': {
        const expected = expectedHeard(
          String(entry.data.id),
          begun,
          ended,
          truncated,
          emergencyCut,
        );
        const heard = String(entry.data.heard);
        if (heard !== expected) {
          violations.push(
            `发言 ${String(entry.data.id)} 写回“${heard}”，但 Stage 回报观众听到的是“${expected}”`,
          );
        }
        break;
      }
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

/**
 * 显示的字幕是否超前于游标：须是字幕文本的前缀，且其中最后一个有朗读的码点，它的第一个朗读码点
 * （模拟 TTS 第 i 个朗读码点从 i × SAMPLES_PER_CHAR 开始）不晚于已播出的采样数。不朗读的符号何时显示不在此列。
 */
function subtitleAhead(subtitle: string | undefined, text: string, played: number) {
  if (subtitle === undefined) return `“${text}”所属的句子没有在 Stage 上开始`;
  const chars = [...subtitle];
  const count = [...text].length;
  if (chars.slice(0, count).join('') !== text) return `“${text}”不是字幕“${subtitle}”的前缀`;
  const { align } = speakable(subtitle);
  let last = -1;
  for (let i = 0; i < align.length && (align[i] as number) < count; i += 1) last = i;
  if (last < 0) return undefined;
  const first = align.indexOf(align[last] as number);
  const start = first * SAMPLES_PER_CHAR;
  return start > played
    ? `“${text}”在已播出 ${played} 个采样时显示，但最后一个字从第 ${start} 个采样才开始`
    : undefined;
}

/**
 * 按 Stage 的回报独立推出一段发言观众听到了什么：播完的句子全算，截断的句子只算完整播出的码点；
 * 急停且应急动作成功时，截断的那一句先扣掉呈现延迟对应的采样数。
 */
function expectedHeard(
  utteranceId: string,
  begun: ReadonlyMap<string, string>,
  ended: ReadonlySet<string>,
  truncated: ReadonlyMap<string, number>,
  emergencyCut: ReadonlyMap<string, number>,
): string {
  const sentences = [...begun.keys()]
    .filter((key) => key.startsWith(`${utteranceId}#`))
    .sort((a, b) => Number(a.split('#').at(-1)) - Number(b.split('#').at(-1)));
  let expected = '';
  for (const key of sentences) {
    const subtitle = begun.get(key) as string;
    if (ended.has(key)) {
      expected += subtitle;
      continue;
    }
    const played = Math.max(0, (truncated.get(key) ?? 0) - (emergencyCut.get(key) ?? 0));
    const chars = Math.floor(played / SAMPLES_PER_CHAR);
    const { align } = speakable(subtitle);
    if (chars > 0) expected += [...subtitle].slice(0, (align[chars - 1] as number) + 1).join('');
    break;
  }
  return expected;
}
