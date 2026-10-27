/**
 * P2 第 10 步的真机演练：操作台与 M1 的逐句放行（P2 出口“操作台可用，M1 下逐句放行与否决生效；审核插件显式关闭，
 * 操作台常显‘审核已关闭’，状态记入事件”）。
 *
 *   node spikes/drill-p2-console.ts [--config config/live.json] [--model replay|real]
 *        [--approve-timeout-ms 30000] [--phase-ms 180000] [--out 结果文件前缀]
 *
 * 用维护者的真实配置（profile 与它的 patch、OBS、凭据，SecretStore 服务名 bellis）拉起宿主与看门狗，另加一个本演练
 * 生成的临时 patch（写在系统临时目录，不入库，结束时删除）：
 * - 弹幕接入条目换成回放（danmaku-replay，`startOn: output`）：四条合成弹幕，第一条在进入 M1 之后 5 秒送出，之后
 *   每隔 --phase-ms 一条，一条对应下面的一个阶段；分诊、投票、模型客户端与决策插件启用，决策插件的冷场闲聊关掉；
 * - --model replay（缺省）把模型客户端换成回放（llm-replay），每条弹幕的回应是写好的 3–4 个短句（没有逗号，按句号
 *   分句），时机确定、不外发；--model real 用维护者配置的决策模型（会外发、按调用计费；回应的句数不定，阶段 B 不足
 *   3 句时记为没做成）；
 * - 放行环节（speech-review）改为逐句人工放行（`mode: approve`），等待上限 --approve-timeout-ms（缺省与插件相同，
 *   30 秒）；维护者配置里的放行方式不在本演练里用；
 * - Iris 客户端与记忆插件关闭（不往 Iris 写演练的内容）；审核插件保持 profile 里的显式设置，不是关闭时拒绝运行。
 * 其余照用维护者的配置：TTS、Stage、形象、OBS。状态存储放在系统临时目录（演练的事实与内容不进直播用的事件日志），
 * 结束时删除。
 *
 * 流程：等宿主就绪、Stage 认证、看门狗连上 OBS；提示操作员在另一个终端运行 `pnpm operator console`（它从 SecretStore
 * 读本次会话，连的就是演练拉起的宿主；一次性登录令牌只在浏览器地址的片段里，本演练不取、不打印），等宿主日志出现
 * 操作台登录（`console.login`），请操作员目视确认顶部的审核状态。操作员按回车后切回直播场景、取消静音，M1 的开播
 * 预检通过后进入 M1，回放随之开始计时。四个阶段依次进行，每个阶段一条弹幕，脚本打印提示，操作员在操作台的
 * “等待放行”里操作：
 * - A 逐句放行：每一句都点“放行”；
 * - B 放行一句后否决下一句：第 1 句放行，第 2 句点它的“否决”，之后的句子逐句放行；
 * - C 全部否决：每出现一句等待放行，就点“全部否决”；
 * - D 等待放行超时：不操作。
 * 阶段之间不用按键：回应结束（`utterance.played`）即核对，然后等下一条弹幕（回放从进入 M1 起按固定时刻送出，不能
 * 按需送出）。每个阶段从它的弹幕到点起至多 --phase-ms，下一条弹幕也在这时送出；到时回应还没结束记为失败样本，
 * 不剔除。阶段开始时不在 M1（例如被急停）就记下来并重新进入 M1。最后请操作员目视确认近期告警与审核状态，停止会话
 * （宿主计划内停止：切安全场景并静音）。宿主就绪之后在本终端按 Ctrl+C 中止：当前步骤结束后停止会话、恢复 OBS。
 *
 * 发声“M1 的逐句放行”：被否决或撤回的句子跳过、不播出，不给句键的否决针对全部等待中的句子。仲裁逐句处理，一句播完
 * 或跳过之后才把下一句交给放行环节，所以等待中的句子至多一句：“全部否决”只否决此刻等待的那一句，发言随后的句子
 * 照常逐句等待放行。阶段 C 因此要每句点一次，阶段 B 否决之后的句子也要逐句放行。
 *
 * 核对（依据是状态存储里的事实序号与类型；每秒经操作员连接读一次 status，它与操作台的 `/api/status` 相同，只是没有
 * 近期告警）：
 * - 每个阶段：这条弹幕的回应（决策插件的一段 `danmaku-reply` 发言）在时限内结束；进入放行环节的句数与写好的相同
 *   （--model replay）；每一句都先进入等待（`speech.held`），且在上一句结束（播完或跳过）之后才进入；阶段中一直在 M1。
 * - A：每句都由操作员放行（`speech.released`，by 为 operator），之后才授权（`intent.authorized`）、开始执行
 *   （`intent.started`）并完整播出（`intent.succeeded` 的 complete）；写回（`utterance.played`）为 complete、没有跳过。
 * - B：第 1 句同 A；第 2 句被否决（`speech.vetoed`），没有授权、没有执行，记为跳过（`sentence.skipped`）；之后的
 *   句子在否决之后照常进入等待、放行后播出；写回只跳过第 2 句。
 * - C：每一句都被否决，没有任何一句授权或执行；写回为空、全部跳过。
 * - D：每一句等满 --approve-timeout-ms 后撤回（`speech.withdrawn`，timedOut），没有授权与执行；等待中 status 的 held
 *   列出这一句（等待方式 approve），结束后不再列出。近期告警（“等待放行超时，已撤回”）由这条事实生成，只在操作台的
 *   `/api/status` 里；本演练不登录操作台，由操作员目视确认。
 * - 审核：status 的 moderationEnabled 为 false（开始与结束各读一次）；状态存储里有宿主启动时记下的
 *   `moderation.switched`（enabled 为 false）；操作台顶部常显“审核已关闭”由操作员目视确认（y/n），结果里写明。
 * - 操作台：宿主日志里操作台登录（`console.login`）与拒绝请求（`console.refused`）的次数。
 *
 * 局限：只演练 approve；delay（固定延迟，期间可否决或提前放行）走同一条否决与放行的路径，计时不同，不在其中。脚本
 * 分不出操作员点的是“全部否决”还是单句的“否决”（记的事实相同），也分不出操作来自操作台还是命令行；按钮点了没有、
 * 页面显示什么，只能靠事实与目视确认。status 每秒读一次，放行很快的句子可能没被读到在等待中（只有 D 要求读到）。
 *
 * 推流进行中、或有别的 Bellis 进程在运行时拒绝运行。会切换节目场景、静音 Stage 源并改写 Stage 浏览器源的 URL；
 * 结束后把节目场景、静音与 Stage 源的设置（含 URL）恢复原样并读回比对。结果写 <前缀>.json（缺省
 * reports/drill-p2-console-<时刻>）：只含编号、类型、计数、时刻与核对结论，不含句子、弹幕与模型的内容，也不含
 * 凭据。宿主日志里有发言的内容，不落盘。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface, type Interface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { OperatorMethod, type PatchOp } from '@bellis/protocol';
import { Segmenter } from '@bellis/speech';
import { waitForNoOtherBellis } from './bellis-processes.ts';
import {
  checkIntArg,
  connectObs,
  DrillDir,
  entryOf,
  inspectObs,
  type LiveConfig,
  LiveHost,
  type ObsScene,
  profileEntry,
  readLiveConfig,
  restoreObs,
  root,
  type StoreEvent,
  StoreReader,
  say,
  sleep,
} from './live-drill.ts';

export type PhaseName = 'release' | 'veto-next' | 'veto-all' | 'timeout';

interface PhaseSpec {
  name: PhaseName;
  label: string;
  /** 合成弹幕（不含个人信息）：请角色分几句回应，--model real 时也尽量得到多句。 */
  danmaku: string;
  /** 回放模型的回应：短句、没有逗号，按句号分句。 */
  reply: string;
  /** 给操作员的提示；n 为回应的句数，未知时为 undefined。 */
  guide(n: number | undefined, timeoutSec: number): string;
}

const count = (n: number | undefined) => (n === undefined ? '的句数不定，' : `有 ${n} 句，`);

export const PHASES: readonly PhaseSpec[] = [
  {
    name: 'release',
    label: 'A 逐句放行',
    danmaku: '主播能分几句话讲讲今天的安排吗？',
    reply: '这是逐句放行的演练。每一句都等你放行。放行之后才会播出。',
    guide: (n, sec) =>
      `回应${count(n)}会一句一句出现在操作台的“等待放行”里：每一句都点“放行”（每句至多等 ${sec} 秒）。`,
  },
  {
    name: 'veto-next',
    label: 'B 放行一句后否决下一句',
    danmaku: '主播再分几句讲讲游戏规则吧',
    reply: '现在练习否决。第一句请放行。第二句请否决。后面的句子请逐句放行。',
    guide: (n, sec) =>
      `回应${count(n)}第 1 句点“放行”；第 2 句点这一句的“否决”；之后出现的句子逐句点“放行”（每句至多等 ${sec} 秒）。`,
  },
  {
    name: 'veto-all',
    label: 'C 全部否决',
    danmaku: '主播分几句聊聊最近看的动画？',
    reply: '这一段要全部否决。每一句都不该播出。听到声音就说明有问题。',
    guide: (n) =>
      `回应${count(n)}每出现一句等待放行，就点“等待放行”上方的“全部否决”（一次只等一句，要每句点一次），直到不再出现新的句子。`,
  },
  {
    name: 'timeout',
    label: 'D 等待放行超时',
    danmaku: '主播分几句说说今天的天气吧',
    reply: '这一段请不要操作。每一句都会等到超时。超时的句子不会播出。',
    guide: (n, sec) =>
      `回应${count(n)}不要操作：每一句等满 ${sec} 秒后自动撤回。结束后看操作台的“近期告警”。`,
  },
];

/** 第一条弹幕在进入 M1 之后多久送出。 */
const LEAD_MS = 5000;
/** 等操作员登录操作台的上限。 */
const LOGIN_WAIT_MS = 10 * 60_000;

/** 写好的回应按发声的分句规则切成几句。 */
export function sentenceCount(text: string): number {
  const segmenter = new Segmenter();
  return [...segmenter.push(text), ...segmenter.flush()].length;
}

const speak = (text: string, replyTo: string) => JSON.stringify({ action: 'speak', replyTo, text });

/** 生成演练的 patch：弹幕换成回放（进入 M1 后开始）、互动包启用、放行环节改为逐句人工放行、记忆关闭。 */
export function patchOps(
  live: LiveConfig,
  messages: ReadonlyArray<{
    atMs: number;
    id: string;
    viewer: string;
    nickname: string;
    text: string;
  }>,
  model: 'real' | 'replay',
  outputs: readonly string[],
  approveTimeoutMs: number,
): PatchOp[] {
  const danmaku = entryOf(live, 'danmaku-bilibili') ?? entryOf(live, 'danmaku-replay');
  if (!danmaku)
    throw new Error(
      'profile 里没有弹幕接入条目（danmaku-bilibili）：从样例整段复制 interaction 包',
    );
  const ops: PatchOp[] = [
    {
      op: 'replace',
      entry: {
        id: danmaku.id,
        plugin: 'danmaku-replay',
        config: { messages: [...messages], startOn: 'output' },
      },
    },
  ];
  for (const plugin of ['audience-triage', 'audience-vote', 'llm-openai', 'director']) {
    const entry = entryOf(live, plugin);
    if (!entry)
      throw new Error(`profile 里没有 ${plugin} 的条目：从样例整段复制 interaction 包，并填好配置`);
    if (model === 'replay' && plugin === 'llm-openai') {
      ops.push({
        op: 'replace',
        entry: {
          id: entry.id,
          plugin: 'llm-replay',
          config: { outputs: [...outputs], latencyMs: 500 },
        },
      });
    } else if (plugin === 'director') {
      // 冷场闲聊关掉：闲聊也要逐句放行，会混进阶段里；回放模型时还会先取走写好的输出。
      ops.push({
        op: 'replace',
        entry: profileEntry(entry, {
          disabled: false,
          config: { ...(entry.config as Record<string, unknown>), idleMs: 0 },
        }),
      });
    } else if (entry.disabled) {
      ops.push({ op: 'enable', id: entry.id });
    }
  }
  const review = entryOf(live, 'speech-review');
  if (!review)
    throw new Error('profile 里没有放行环节（speech-review）的条目：从样例复制 speech 包');
  ops.push({
    op: 'replace',
    entry: profileEntry(review, {
      disabled: false,
      config: {
        ...(review.config as Record<string, unknown>),
        mode: 'approve',
        approveTimeoutMs,
      },
    }),
  });
  // 不往 Iris 写演练的内容。
  for (const plugin of ['iris-client', 'memory']) {
    const entry = entryOf(live, plugin);
    if (entry && !entry.disabled) ops.push({ op: 'disable', id: entry.id });
  }
  return ops;
}

/** 一句在放行环节与执行闸门里的经过：只有序号、类型与时刻，不含句子文本。 */
interface SentenceTrace {
  index: number;
  key: string;
  held?: { seq: number; at: number; mode: unknown };
  ending?: {
    type: 'released' | 'vetoed' | 'withdrawn';
    seq: number;
    at: number;
    by?: unknown;
    timedOut?: boolean;
  };
  skipped?: number;
  authorized?: { seq: number; id: number };
  started?: number;
  outcome?: { type: 'succeeded' | 'failed'; seq: number; complete: boolean };
  denied?: number;
}

/** 这段发言每一句的经过，按句序排列（事实里的句键是 `<发言编号>#<句序号>`）。 */
export function sentenceTraces(events: readonly StoreEvent[], utterance: string): SentenceTrace[] {
  const sentences = new Map<string, SentenceTrace>();
  const intents = new Map<number, string>();
  const prefix = `${utterance}#`;
  const of = (key: string): SentenceTrace => {
    let found = sentences.get(key);
    if (!found) {
      found = { index: Number(key.slice(prefix.length)), key };
      sentences.set(key, found);
    }
    return found;
  };
  for (const e of events) {
    const d = e.data;
    const own = typeof d.key === 'string' && d.key.startsWith(prefix) ? d.key : undefined;
    const intent = intents.get(Number(d.id));
    if (e.type === 'speech.held' && own) {
      of(own).held = { seq: e.seq, at: e.recordedAt, mode: d.mode };
    } else if (
      (e.type === 'speech.released' ||
        e.type === 'speech.vetoed' ||
        e.type === 'speech.withdrawn') &&
      own
    ) {
      of(own).ending = {
        type: e.type.slice('speech.'.length) as 'released' | 'vetoed' | 'withdrawn',
        seq: e.seq,
        at: e.recordedAt,
        ...(e.type === 'speech.released' ? { by: d.by } : {}),
        ...(e.type === 'speech.withdrawn' ? { timedOut: d.timedOut === true } : {}),
      };
    } else if (e.type === 'sentence.skipped' && d.utteranceId === utterance) {
      of(`${prefix}${String(d.index)}`).skipped = e.seq;
    } else if (e.type === 'intent.authorized' && own) {
      of(own).authorized = { seq: e.seq, id: Number(d.id) };
      intents.set(Number(d.id), own);
    } else if (e.type === 'intent.started' && intent) {
      of(intent).started = e.seq;
    } else if ((e.type === 'intent.succeeded' || e.type === 'intent.failed') && intent) {
      const result = d.result as { complete?: unknown } | null | undefined;
      of(intent).outcome = {
        type: e.type === 'intent.succeeded' ? 'succeeded' : 'failed',
        seq: e.seq,
        complete: e.type === 'intent.succeeded' && result?.complete === true,
      };
    } else if (e.type === 'intent.denied' && own) {
      of(own).denied = e.seq;
    }
  }
  return [...sentences.values()].sort((a, b) => a.index - b.index);
}

/** 这一句最后一条事实的序号：播完、跳过或等待结束。 */
const lastSeqOf = (s: SentenceTrace) =>
  Math.max(s.ending?.seq ?? 0, s.skipped ?? 0, s.outcome?.seq ?? 0, s.denied ?? 0);

export interface PhaseObservation {
  /** 写好的句数（--model replay）；未知时为 undefined。 */
  expected: number | undefined;
  approveTimeoutMs: number;
  /** 回应在时限内结束了。 */
  ended: boolean;
  /** 阶段中读到的模式。 */
  modes: readonly string[];
  /** 阶段中 status 的 held 里出现过的句键。 */
  heldSeen: readonly string[];
  /** 阶段结束时 status 的 held 里的句键。 */
  heldAfter: readonly string[];
}

/** 核对一个阶段：这条弹幕的回应（发言编号 utterance）每一句的经过与写回。 */
export function verifyPhase(
  name: PhaseName,
  events: readonly StoreEvent[],
  utterance: string | undefined,
  seen: PhaseObservation,
) {
  if (!utterance)
    return {
      ok: false,
      problems: [
        '没有等到这条弹幕的回应（决策插件没有回应，或回应在发声队列里过期，例如上一阶段还没结束）',
      ],
    };
  const sentences = sentenceTraces(events, utterance);
  const played = events.find((e) => e.type === 'utterance.played' && e.data.id === utterance);
  const skipped = ((played?.data.skipped as Array<{ index: number }> | undefined) ?? []).map(
    (s) => s.index,
  );
  const heardChars = [...String(played?.data.heard ?? '')].length;
  const problems: string[] = [];
  const nth = (s: SentenceTrace) => `第 ${s.index + 1} 句`;
  const describe = (s: SentenceTrace) =>
    s.ending
      ? `${s.ending.type}${s.ending.by === undefined ? '' : `/${String(s.ending.by)}`}${s.ending.timedOut ? '/timedOut' : ''}`
      : '没有结束等待';

  if (!seen.ended) problems.push('阶段超时：到时这段回应还没结束');
  const off = [...new Set(seen.modes.filter((m) => m !== 'M1'))];
  if (off.length > 0) problems.push(`阶段中模式不是 M1：${off.join('、')}`);
  if (seen.expected !== undefined && sentences.length !== seen.expected)
    problems.push(`这段回应有 ${sentences.length} 句进入放行环节，写好的是 ${seen.expected} 句`);
  sentences.forEach((s, i) => {
    if (!s.held) problems.push(`${nth(s)}没有进入放行环节（没有 speech.held）`);
    const previous = i > 0 ? sentences[i - 1] : undefined;
    // 放行环节一次只等一句：上一句结束之后下一句才进入等待。
    if (previous && s.held && s.held.seq < lastSeqOf(previous))
      problems.push(`${nth(s)}在上一句结束之前就进入了等待`);
  });

  /** 由操作员放行，之后才授权、开始执行并完整播出。 */
  const releasedThenPlayed = (s: SentenceTrace) => {
    if (s.ending?.type !== 'released' || s.ending.by !== 'operator')
      problems.push(`${nth(s)}没有由操作员放行（${describe(s)}）`);
    if (!s.authorized) problems.push(`${nth(s)}没有授权`);
    else if (s.ending && s.authorized.seq < s.ending.seq)
      problems.push(`${nth(s)}在放行之前就授权了`);
    if (s.authorized && (s.started === undefined || s.started < s.authorized.seq))
      problems.push(`${nth(s)}授权后没有开始执行`);
    if (s.outcome?.type !== 'succeeded' || !s.outcome.complete)
      problems.push(`${nth(s)}没有完整播出`);
  };
  /** 以否决或撤回结束，没有授权、没有执行，记为跳过。 */
  const notPlayed = (s: SentenceTrace, how: 'vetoed' | 'withdrawn') => {
    if (s.ending?.type !== how) problems.push(`${nth(s)}不是以 ${how} 结束（${describe(s)}）`);
    if (s.authorized || s.started !== undefined || s.outcome)
      problems.push(`${nth(s)}授权或执行了（应当不播出）`);
    if (s.skipped === undefined) problems.push(`${nth(s)}没有记为跳过（sentence.skipped）`);
  };
  const writeback = (end: string, skippedIndexes: number[], heard: boolean) => {
    if (!played) {
      problems.push('没有写回（utterance.played）');
      return;
    }
    if (played.data.end !== end) problems.push(`写回的结束方式是 ${String(played.data.end)}`);
    if (skipped.join(',') !== skippedIndexes.join(','))
      problems.push(`写回跳过的句子是 [${skipped.join(',')}]，应为 [${skippedIndexes.join(',')}]`);
    if (heard !== heardChars > 0) problems.push(heard ? '写回为空' : '写回不为空');
  };

  if (name === 'release') {
    for (const s of sentences) releasedThenPlayed(s);
    writeback('complete', [], true);
  } else if (name === 'veto-next') {
    const [first, second, ...rest] = sentences;
    if (!first || !second || rest.length === 0) problems.push('回应不足 3 句，没能做成这个阶段');
    if (first) releasedThenPlayed(first);
    if (second) notPlayed(second, 'vetoed');
    for (const s of rest) {
      // 被否决的只是那一句：之后的句子照常进入等待，由操作员逐句放行。
      if (second?.ending && s.held && s.held.seq < second.ending.seq)
        problems.push(`${nth(s)}在第 2 句被否决之前就进入了等待`);
      releasedThenPlayed(s);
    }
    writeback('complete', second ? [second.index] : [], true);
  } else if (name === 'veto-all') {
    for (const s of sentences) notPlayed(s, 'vetoed');
    writeback(
      'complete',
      sentences.map((s) => s.index),
      false,
    );
  } else {
    for (const s of sentences) {
      notPlayed(s, 'withdrawn');
      if (s.ending?.type === 'withdrawn' && !s.ending.timedOut)
        problems.push(`${nth(s)}的撤回不是因为等待超时`);
      if (s.held && s.held.mode !== 'approve')
        problems.push(`${nth(s)}的等待方式不是 approve（${String(s.held.mode)}）`);
      if (s.held && s.ending && s.ending.at - s.held.at < seen.approveTimeoutMs - 20)
        problems.push(`${nth(s)}没等满 ${seen.approveTimeoutMs}ms 就撤回了`);
      if (!seen.heldSeen.includes(s.key)) problems.push(`等待中 status 的 held 没有列出${nth(s)}`);
    }
    if (seen.heldAfter.some((key) => key.startsWith(`${utterance}#`)))
      problems.push('撤回之后 status 的 held 还列着这段回应的句子');
    writeback(
      'complete',
      sentences.map((s) => s.index),
      false,
    );
  }
  return {
    ok: problems.length === 0,
    problems,
    utterance,
    sentences: sentences.map((s) => ({
      index: s.index,
      key: s.key,
      heldSeq: s.held?.seq ?? null,
      heldMode: s.held?.mode ?? null,
      ending: s.ending ? { type: s.ending.type, seq: s.ending.seq } : null,
      ...(s.ending?.by === undefined ? {} : { by: s.ending.by }),
      ...(s.ending?.timedOut ? { timedOut: true } : {}),
      waitedMs: s.held && s.ending ? s.ending.at - s.held.at : null,
      seenInStatus: seen.heldSeen.includes(s.key),
      skippedSeq: s.skipped ?? null,
      authorizedSeq: s.authorized?.seq ?? null,
      intentId: s.authorized?.id ?? null,
      startedSeq: s.started ?? null,
      outcome: s.outcome ?? null,
      deniedSeq: s.denied ?? null,
    })),
    writeback: played ? { seq: played.seq, end: played.data.end, skipped, heardChars } : null,
  };
}

/**
 * 状态存储里新出现的一段弹幕回应：第一句进入等待，或没进入等待就结束了（例如轮到它时已过期）。在发声队列里
 * 就被丢弃的不记事实，看不到。
 */
function nextUtterance(
  events: readonly StoreEvent[],
  taken: ReadonlySet<string>,
): string | undefined {
  for (const e of events) {
    if (e.data.source !== 'danmaku-reply') continue;
    const id =
      e.type === 'speech.held'
        ? e.data.utteranceId
        : e.type === 'utterance.played'
          ? e.data.id
          : undefined;
    if (typeof id === 'string' && !taken.has(id)) return id;
  }
  return undefined;
}

const heldKeys = (status: Record<string, unknown>) =>
  ((status.held as Array<{ key?: unknown }> | undefined) ?? [])
    .map((h) => h.key)
    .filter((key): key is string => typeof key === 'string');

/** 问一句；输入关闭或 Ctrl+C 时为 undefined。 */
async function ask(
  rl: Interface,
  question: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  if (signal.aborted) return undefined;
  try {
    return (await rl.question(question, { signal })).trim();
  } catch {
    return undefined;
  }
}

/** 目视确认：y 或 n；没有回答时为 null。 */
async function confirm(
  rl: Interface,
  question: string,
  signal: AbortSignal,
): Promise<boolean | null> {
  for (;;) {
    const answer = await ask(rl, `${question}(y/n) `, signal);
    if (answer === undefined) return null;
    if (/^(y|yes|是)$/iu.test(answer)) return true;
    if (/^(n|no|否)$/iu.test(answer)) return false;
  }
}

interface Run {
  host: LiveHost;
  store: StoreReader;
  scene: ObsScene;
  signal: AbortSignal;
  /** 进入 M1 之前最后一条事实的序号。 */
  fromSeq: number;
  /** 进入 M1 的时刻：回放从这时开始计时。 */
  t0: number;
  phaseMs: number;
  approveTimeoutMs: number;
  /** 已经归到前面阶段的发言。 */
  taken: Set<string>;
}

/** 一个阶段：提示操作员，等这条弹幕的回应结束或到时限，核对。 */
async function phase(
  run: Run,
  spec: PhaseSpec,
  index: number,
  danmakuId: string,
  expected: number | undefined,
): Promise<Record<string, unknown>> {
  const dueAt = run.t0 + LEAD_MS + index * run.phaseMs;
  const deadline = dueAt + run.phaseMs;
  const record: Record<string, unknown> = {
    phase: spec.name,
    label: spec.label,
    danmakuId,
    dueAt: new Date(dueAt).toISOString(),
    expectedSentences: expected ?? null,
  };
  const before = await run.host.call(OperatorMethod.Status);
  if (before.mode !== 'M1') {
    say(`阶段 ${spec.label} 开始前不在 M1（${String(before.mode)}），重新进入 M1`);
    try {
      await run.host.enter(run.scene, 'M1', 30_000);
      record.reentered = { ok: true, from: before.mode };
    } catch (error) {
      record.reentered = { ok: false, from: before.mode, error: (error as Error).message };
    }
  }
  const wait = Math.max(0, Math.round((dueAt - Date.now()) / 1000));
  say(
    `阶段 ${spec.label}：弹幕约 ${wait} 秒后送出。${spec.guide(expected, run.approveTimeoutMs / 1000)}`,
  );
  const modes: string[] = [];
  const heldSeen = new Set<string>();
  let utterance: string | undefined;
  let ended = false;
  for (;;) {
    if (run.signal.aborted) throw new Error('操作员中止（Ctrl+C）');
    const status = await run.host.call(OperatorMethod.Status);
    modes.push(String(status.mode));
    for (const key of heldKeys(status)) heldSeen.add(key);
    const events = run.store.events(run.fromSeq);
    if (!utterance) {
      utterance = nextUtterance(events, run.taken);
      if (utterance) {
        run.taken.add(utterance);
        record.firstSeenAt = new Date().toISOString();
        say(`阶段 ${spec.label}：回应已到，请在操作台操作`);
      }
    }
    ended =
      utterance !== undefined &&
      events.some((e) => e.type === 'utterance.played' && e.data.id === utterance);
    if (ended || Date.now() >= deadline) break;
    await sleep(1000);
  }
  record.endedAt = new Date().toISOString();
  const after = await run.host.call(OperatorMethod.Status);
  record.result = verifyPhase(spec.name, run.store.events(run.fromSeq), utterance, {
    expected,
    approveTimeoutMs: run.approveTimeoutMs,
    ended,
    modes: [...modes, String(after.mode)],
    heldSeen: [...heldSeen],
    heldAfter: heldKeys(after),
  });
  return record;
}

type ModerationState = Awaited<ReturnType<typeof moderationState>>;

/** 审核开关：status 的 moderationEnabled，与状态存储里记下的 `moderation.switched`。 */
async function moderationState(host: LiveHost, store: StoreReader) {
  const status = await host.call(OperatorMethod.Status);
  return {
    statusModerationEnabled: status.moderationEnabled ?? null,
    switched: store
      .events()
      .filter((e) => e.type === 'moderation.switched')
      .map((e) => ({
        seq: e.seq,
        at: new Date(e.recordedAt).toISOString(),
        enabled: e.data.enabled,
      })),
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      config: { type: 'string', default: 'config/live.json' },
      model: { type: 'string', default: 'replay' },
      'approve-timeout-ms': { type: 'string', default: '30000' },
      'phase-ms': { type: 'string', default: '180000' },
      out: { type: 'string' },
    },
  });
  if (values.model !== 'real' && values.model !== 'replay')
    throw new Error('--model 只能是 real 或 replay');
  const model = values.model;
  const approveTimeoutMs = checkIntArg('--approve-timeout-ms', values['approve-timeout-ms'], 1000);
  const phaseMs = checkIntArg('--phase-ms', values['phase-ms'], 10_000);
  const counts = PHASES.map((p) => sentenceCount(p.reply));
  // 每句至多等满放行的上限（阶段 D 句句如此），阶段的时限要放得下最长的回应。
  const minPhaseMs = Math.max(...counts) * approveTimeoutMs + 30_000;
  if (phaseMs < minPhaseMs)
    throw new Error(
      `--phase-ms 至少要 ${minPhaseMs}：回应至多 ${Math.max(...counts)} 句，每句至多等 --approve-timeout-ms`,
    );
  const live = readLiveConfig(values.config);
  if (!live.entries.find((entry) => entry.id === 'moderation')?.disabled)
    throw new Error(
      '这个演练核对审核关闭时的常显：profile 中审核插件（moderation）应显式关闭（P2 不启用审核插件）',
    );
  const started = new Date().toISOString();
  const run = started.replace(/\D/g, '').slice(2, 14);
  const out = resolve(
    values.out ?? join(root, 'reports', `drill-p2-console-${started.replace(/[:.]/g, '-')}`),
  );
  mkdirSync(dirname(out), { recursive: true });

  const messages = PHASES.map((p, i) => ({
    atMs: LEAD_MS + i * phaseMs,
    id: `drill-${run}-${'ABCD'[i]}`,
    viewer: `drill-viewer-${i + 1}`,
    nickname: `观众${i + 1}`,
    text: p.danmaku,
  }));
  const outputs = PHASES.map((p, i) => speak(p.reply, `c-${messages[i]?.id}`));
  const dir = new DrillDir('p2-console');
  const storePath = join(dir.dir, 'state.db');
  const result: Record<string, unknown> = {
    drill: 'p2-console',
    started,
    node: process.version,
    config: values.config,
    params: { model, approveTimeoutMs, phaseMs, leadMs: LEAD_MS },
    danmakuIds: messages.map((m) => m.id),
  };
  const visual: Record<string, unknown> = { how: '操作员目视确认' };
  const moderation: { atStart?: ModerationState; atEnd?: ModerationState } = {};
  const phases: Array<Record<string, unknown>> = [];
  const stop = new AbortController();
  let rl: Interface | undefined;
  let scene: ObsScene | undefined;
  let host: LiveHost | undefined;
  let store: StoreReader | undefined;
  try {
    const configPath = await dir.writeConfig(
      live,
      'p2-console',
      patchOps(live, messages, model, outputs, approveTimeoutMs),
      storePath,
    );
    await waitForNoOtherBellis({ log: say });
    scene = await inspectObs(live, await connectObs());
    result.obsVersion = scene.version;

    say('拉起宿主与看门狗……');
    host = await LiveHost.start(configPath);
    await host.ready();
    store = new StoreReader(storePath);
    if (!host.host.find((l) => l.event === 'console.listening'))
      throw new Error('宿主没有启动操作台（看宿主日志里的 console.start-failed）');
    moderation.atStart = await moderationState(host, store);
    const review = (await host.call(OperatorMethod.Status)).review as
      | { mode?: unknown; approveTimeoutMs?: unknown }
      | null
      | undefined;
    result.review = review ?? null;
    if (review?.mode !== 'approve' || review.approveTimeoutMs !== approveTimeoutMs)
      throw new Error('放行环节没有按演练的 patch 改为逐句人工放行（看插件状态里的 review 条目）');

    // 从这里起要问操作员：终端里的 Ctrl+C 由 readline 收到，中止演练，当前步骤结束后照常停止会话、恢复 OBS
    // （在这之前的等待与其它演练一样，Ctrl+C 直接结束本进程）。输入关闭时同样中止，不让提问一直等。
    const input = createInterface({ input: process.stdin, output: process.stdout });
    rl = input;
    input.on('SIGINT', () => {
      if (!stop.signal.aborted) say('收到 Ctrl+C：当前步骤结束后停止会话、恢复 OBS');
      stop.abort();
    });
    input.on('close', () => stop.abort());

    say(
      '请在另一个终端（仓库根目录）运行：pnpm operator console\n' +
        '  它从 SecretStore 读本次会话，连的就是演练拉起的宿主，并用浏览器打开操作台（一次性登录令牌，60 秒内有效）。',
    );
    const loginDeadline = Date.now() + LOGIN_WAIT_MS;
    while (!host.host.find((l) => l.event === 'console.login')) {
      if (stop.signal.aborted) throw new Error('操作员中止（Ctrl+C）');
      if (Date.now() > loginDeadline)
        throw new Error(`等操作员登录操作台超时（${LOGIN_WAIT_MS / 60_000} 分钟）`);
      await sleep(500);
    }
    say('操作台已登录');
    visual.bannerAtStart = await confirm(input, '操作台顶部是否显示“审核已关闭”？', stop.signal);

    say(
      `接下来进入 M1，分四个阶段，每个阶段一条弹幕（间隔 ${Math.round(phaseMs / 1000)} 秒），在操作台的“等待放行”里操作：\n` +
        PHASES.map(
          (p, i) =>
            `  ${p.label}：${p.guide(model === 'replay' ? counts[i] : undefined, approveTimeoutMs / 1000)}`,
        ).join('\n') +
        '\n  阶段之间不用按键；要中止演练在本终端按 Ctrl+C。',
    );
    if ((await ask(input, '准备好后按回车进入 M1：', stop.signal)) === undefined)
      throw new Error('操作员中止（Ctrl+C）');
    const fromSeq = store.lastSeq();
    await host.enter(scene, 'M1', 240_000);
    const t0 = Date.now();
    result.m1At = new Date(t0).toISOString();
    say('已进入 M1，回放开始计时');

    const context: Run = {
      host,
      store,
      scene,
      signal: stop.signal,
      fromSeq,
      t0,
      phaseMs,
      approveTimeoutMs,
      taken: new Set(),
    };
    for (const [i, spec] of PHASES.entries()) {
      const record = await phase(
        context,
        spec,
        i,
        messages[i]?.id ?? '',
        model === 'replay' ? counts[i] : undefined,
      );
      phases.push(record);
      const verdict = record.result as { ok: boolean; problems: string[] };
      say(
        verdict.ok
          ? `阶段 ${spec.label}：通过`
          : `阶段 ${spec.label} 未通过：${verdict.problems.join('；')}`,
      );
    }
    visual.timeoutAlert = await confirm(
      input,
      '操作台“近期告警”里是否有阶段 D 的“等待放行超时，已撤回”？',
      stop.signal,
    );
    visual.bannerThroughout = await confirm(
      input,
      '演练过程中操作台顶部是否一直显示“审核已关闭”？',
      stop.signal,
    );
    moderation.atEnd = await moderationState(host, store);
    const status = await host.call(OperatorMethod.Status);
    result.final = { mode: status.mode, held: heldKeys(status).length };
  } catch (error) {
    result.error = (error as Error).message;
    say(`演练中止：${(error as Error).message}`);
  } finally {
    rl?.close();
    store?.close();
    if (host) {
      // 操作台的使用痕迹：只数宿主日志里的事件，不含令牌与会话。
      const lines = host.host.items;
      const logged = (event: string) => lines.filter((l) => l.event === event).length;
      result.console = {
        loginIssued: logged('console.login-issued'),
        logins: logged('console.login'),
        refused: logged('console.refused'),
      };
    }
    // 计划内停止：宿主切安全场景并静音，再通知看门狗。
    await host?.stop();
    if (scene) {
      result.obsRestored = await restoreObs(scene);
      scene.obs.close();
    }
    // 状态存储（有内容）与遥测都在临时目录里。
    dir.remove();
  }

  result.moderation = moderation;
  result.visual = visual;
  const { atStart, atEnd } = moderation;
  result.summary = {
    phases: {
      total: PHASES.length,
      run: phases.length,
      verified: phases.filter((p) => (p.result as { ok?: boolean }).ok === true).length,
      failed: phases.filter((p) => (p.result as { ok?: boolean }).ok === false).length,
    },
    moderation: {
      // status（与操作台的 /api/status 相同）在开始与结束时都是关闭。
      statusOff:
        atStart?.statusModerationEnabled === false && atEnd?.statusModerationEnabled === false,
      // 宿主启动时记下的审核开关事实。
      recordedOff:
        atStart !== undefined &&
        atStart.switched.length > 0 &&
        atStart.switched.at(-1)?.enabled === false,
      // 操作台顶部常显“审核已关闭”：操作员目视确认，开始时与整个过程中。
      bannerConfirmed: visual.bannerAtStart === true && visual.bannerThroughout === true,
    },
    timeoutAlertConfirmed: visual.timeoutAlert === true,
  };
  result.phases = phases;
  result.finished = new Date().toISOString();
  writeFileSync(`${out}.json`, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result.summary, null, 2));
  say(`结果已写入 ${out}.json`);
}

// 被导入时（核对生成的 patch 与核对逻辑）不运行。
if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(`演练失败：${(error as Error).message}`);
    process.exitCode = 1;
  }
}
