/**
 * P2 第 10 步的真机演练：重启不重做副作用（P2 出口“在发言、投票、Iris 写入进行中强制结束宿主，重启后不重播、
 * 不重复开票、不重复写入”）。
 *
 *   node spikes/drill-p2-restart.ts [--config config/live.json] [--rounds 3] [--timings speech,vote]
 *        [--model real|replay] [--memory] [--entry bellis:drill] [--kill-after-ms 1500] [--hold-ms 5000]
 *        [--wait-ms 90000] [--observe-ms 15000] [--out 结果文件前缀]
 *
 * 三种时机各做 --rounds 轮（--timings 选，缺省 speech、vote；--memory 时缺省再加 memory）：
 * - speech：发言播出中。一条弹幕请角色回应，等回应的某一句开始执行（这一句的 `speech.play` 意图已开始、发言还没结束），
 *   再过 --kill-after-ms 强制结束宿主；
 * - vote：投票倒计时中。一条弹幕请角色发起投票，等开票说明完整播出、倒计时开始（`vote.announced`），再过
 *   --kill-after-ms（至多倒计时的一半）强制结束宿主；
 * - memory（要 --memory）：Iris 写入在途。宿主预加载 drill-iris-hold.ts：写入 Iris 的请求照常发出、Iris 照常收下，
 *   但应答扣住 --hold-ms 毫秒再交给宿主；宿主日志出现 `drill.iris-held` 后 300ms 强制结束宿主。这时 Iris 已经存下
 *   这一批，宿主还没记 `memory.written`、写入意图停在执行中，是重启后最容易写重的时刻。局限：只逼近“Iris 已收下、
 *   宿主没收到应答”这一种在途；请求发出之前与 Iris 收下之前被打断的情形重启后是第一次写，不构成重复；扣住的是
 *   本进程里的 fetch，不是网络层。
 * 强制结束用 process.kill（Windows 上是 TerminateProcess），不经停止协议，同 drill-safety 的崩溃；看门狗随即接管
 * OBS。之后停掉旧会话，在同一个状态存储上重新拉起宿主与看门狗（宿主不会自动重启），记下宿主的恢复报告
 * （`host.recovered`：放弃与结果未知的意图键），切回直播场景、取消静音、确认在场、预检通过后再进入 M2，送一条探测
 * 弹幕，观察 --observe-ms；memory 时机再等重启前在途的那一批补发完。
 *
 * 每轮用一个新的状态存储（系统临时目录），轮与轮互不影响。核对（依据是状态存储里的事实序号与类型）：
 * - speech：被打断的发言（意图键 `<发言编号>#<句序号>`）重启后没有任何一句再授权或开始执行；重启前执行中的那一句
 *   记为结果未知（`intent.orphaned`）；这段发言没有写回（`utterance.played`），--memory 时也没有排队写入 Iris。
 *   另记 Stage 目标是否被结果未知的意图隔离、重启后被隔离拒绝的意图数：有时效的意图只能由操作员结案，而结案的
 *   命令尚未提供（运维“尚未提供”），隔离期间探测弹幕的回应也播不出来。
 * - vote：这次投票只开了一次（`vote.started` 一条），重启后记为中止（`vote.aborted`，cause 为 restart），没有结果；
 *   开票说明只播了一次、重启后没有再请求，没有结果播报；开票意图结果未知后由投票插件对账为成功。
 * - memory：重启前执行中的写入意图结果未知后由记忆插件对账；重启前在途的那一批在重启后补发并记 `memory.written`；
 *   每个排队序号至多记一次写入。再用 Iris 的宿主接口核对：把记为已写入的每一条以原去重键再提交一次（演练专用的
 *   入口），Iris 按键返回原消息，返回的消息 ID 应与 `memory.written` 记下的相同，即同一去重键只有一条。局限：宿主
 *   接口没有按去重键列出消息的读取，这项核对依赖 Iris“同一入口相同的键返回原消息”的契约（S-09 已核对）。
 *
 * 弹幕用录制回放注入（danmaku-replay，`startOn: output`，进入 M2 后 3 秒送出）；B 站真实平台的测试暂缓。
 * --model real（缺省）用维护者配置的决策模型（会外发、按调用计费；模型可能不回应或不发起投票，这一轮记为没能制造出
 * 这个时机）；--model replay 把模型客户端换成回放（llm-replay，输出是写好的回应与投票），决策插件的冷场闲聊关掉，
 * 时机确定、不外发。--memory 时启用 Iris 客户端与记忆插件，入口改成 --entry（缺省 bellis:drill，演练专用，宿主令牌
 * 的范围须包含它）。其余照用维护者的配置（TTS、Stage、形象、OBS），SecretStore 服务名 bellis。
 *
 * 推流进行中、或有别的 Bellis 进程在运行时拒绝运行。结束后把节目场景、静音与 Stage 源的设置（含 URL）恢复原样并
 * 读回比对。结果写 <前缀>.json（缺省 reports/drill-p2-restart-<时刻>）：每轮的核对结果与依据（事件序号、类型、
 * 意图键、投票编号与条数），不含弹幕、模型与字幕的内容，也不含凭据。状态存储（有内容）结束时删除。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { OBS_SECRET, SIM_OBS_SECRET } from '@bellis/config';
import { IRIS_DEFAULT_URL, IRIS_SECRET, IrisClient } from '@bellis/iris';
import { secretPermission, systemClock } from '@bellis/kernel';
import {
  dedupeKey,
  entryIdBlocker,
  type IrisMessage,
  MemoryConfig,
  type QueuedItem,
} from '@bellis/memory';
import type { PatchOp } from '@bellis/protocol';
import { KeyringSecretStore, SESSION_SECRET } from '@bellis/secret-store';
import Value from 'typebox/value';
import { pluginSecrets } from '../packages/host/src/secrets.ts';
import { waitForNoOtherBellis } from './bellis-processes.ts';
import {
  checkIntArg,
  connectObs,
  DrillDir,
  entryOf,
  inspectObs,
  type LiveConfig,
  LiveHost,
  type LogLine,
  type ObsScene,
  profileEntry,
  readLiveConfig,
  restoreObs,
  root,
  SECRET_SERVICE,
  type StoreEvent,
  StoreReader,
  say,
  sleep,
  waitForEvent,
} from './live-drill.ts';

export type Timing = 'speech' | 'vote' | 'memory';
const TIMINGS: readonly Timing[] = ['speech', 'vote', 'memory'];

/** 合成弹幕（不含个人信息）与回放模型的输出。 */
const TEXT = {
  speech: '主播能详细讲讲今天要玩的游戏吗？',
  vote: '我们来投个票吧：下一把玩魔女审判还是逆转裁判？',
  memory: '主播晚上好，第一次来',
  probe: '主播还在吗？',
} as const;
const REPLY =
  '好呀，这是一段用来演练重启的发言，第一句先打个招呼。第二句接着说，我们今天准备玩一款推理游戏。' +
  '第三句讲讲规则，大家可以在弹幕里一起猜。第四句快要说完了，谢谢大家耐心听。最后一句，演练到这里就结束啦。';
const PROBE_REPLY = '我在呢，谢谢你来。';
const VOTE = { question: '下一把玩什么？', options: ['魔女审判', '逆转裁判'], durationSec: 60 };
/** 弹幕在进入 M2 之后多久送出。 */
const LEAD_MS = 3000;

const holdModule = pathToFileURL(join(root, 'spikes', 'drill-iris-hold.ts')).href;

export interface Options {
  live: LiveConfig;
  scene: ObsScene;
  dir: DrillDir;
  model: 'real' | 'replay';
  memory: { entryId: string } | undefined;
  killAfterMs: number;
  holdMs: number;
  waitMs: number;
  observeMs: number;
}

/** 一次启动的 patch：弹幕换成回放（进入 M2 后开始）、互动包启用；按需换回放模型、启用记忆。 */
export function patchOps(
  options: Options,
  message: { id: string; text: string },
  outputs: readonly string[],
): PatchOp[] {
  const { live } = options;
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
        config: {
          messages: [
            {
              atMs: LEAD_MS,
              id: message.id,
              viewer: 'drill-viewer-1',
              nickname: '观众1',
              text: message.text,
            },
          ],
          startOn: 'output',
        },
      },
    },
  ];
  for (const plugin of ['audience-triage', 'audience-vote', 'llm-openai', 'director']) {
    const entry = entryOf(live, plugin);
    if (!entry)
      throw new Error(`profile 里没有 ${plugin} 的条目：从样例整段复制 interaction 包，并填好配置`);
    if (options.model === 'replay' && plugin === 'llm-openai') {
      ops.push({
        op: 'replace',
        entry: {
          id: entry.id,
          plugin: 'llm-replay',
          config: { outputs: [...outputs], latencyMs: 500 },
        },
      });
    } else if (options.model === 'replay' && plugin === 'director') {
      // 回放的输出按调用顺序取用：关掉冷场闲聊，免得闲聊先取走写好的输出。
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
  if (options.memory) {
    const iris = entryOf(live, 'iris-client');
    const store = entryOf(live, 'memory');
    if (!iris || !store) throw new Error('profile 里没有记忆包（iris、memory）：从样例整段复制');
    if (iris.disabled) ops.push({ op: 'enable', id: iris.id });
    ops.push({
      op: 'replace',
      entry: profileEntry(store, {
        disabled: false,
        config: { ...(store.config as Record<string, unknown>), entryId: options.memory.entryId },
      }),
    });
  }
  return ops;
}

const speak = (text: string, replyTo: string) => JSON.stringify({ action: 'speak', replyTo, text });

/** 只留编号与类型的依据：事实序号、类型，以及不含内容的字段。 */
function evidence(event: StoreEvent) {
  const d = event.data;
  const keep: Record<string, unknown> = {};
  for (const field of [
    'id',
    'key',
    'ref',
    'kind',
    'voteId',
    'cause',
    'end',
    'source',
    'by',
    'from',
    'to',
    'seqs',
    'messageIds',
  ]) {
    if (field in d) keep[field] = d[field];
  }
  if (event.type === 'utterance.played' && typeof d.heard === 'string')
    keep.heardChars = [...d.heard].length;
  if (event.type === 'intent.reconciled') keep.ok = 'result' in d;
  return { seq: event.seq, type: event.type, ...keep };
}

/** 重启后的第一条事实：新进程恢复时记的放弃与结果未知，或安全核启动。 */
function restartSeq(events: readonly StoreEvent[], killSeq: number): number {
  const first = events.find(
    (e) =>
      e.seq > killSeq &&
      (e.type === 'intent.orphaned' ||
        e.type === 'intent.abandoned' ||
        e.type === 'safety.started'),
  );
  return first?.seq ?? Number.POSITIVE_INFINITY;
}

interface Phase {
  host: LiveHost;
  store: StoreReader;
  storePath: string;
}

/** 拉起一次宿主并进入 M2；回放的弹幕随之开始计时。 */
async function launchPhase(
  options: Options,
  name: string,
  storePath: string,
  ops: PatchOp[],
  preload?: string,
): Promise<Phase> {
  const configPath = await options.dir.writeConfig(options.live, name, ops, storePath);
  const host = await LiveHost.start(configPath, preload);
  try {
    await host.ready();
    await host.enterM2(options.scene, 240_000);
  } catch (error) {
    await host.stop();
    throw error;
  }
  return { host, store: new StoreReader(storePath), storePath };
}

/** 意图编号到意图键（`intent.started` 只带编号）。 */
function intentKey(store: StoreReader, id: unknown): { key: string; type: string } | undefined {
  const found = store.intents().find((intent) => intent.id === id);
  return found ? { key: found.key, type: found.type } : undefined;
}

/** 在指定时机强制结束宿主；返回结束前最后一条事实的序号与这一时机的标识。没能制造出时机时抛错。 */
async function induce(
  timing: Timing,
  phase: Phase,
  options: Options,
): Promise<{ killSeq: number; target: Record<string, unknown> }> {
  const { store, host } = phase;
  if (timing === 'speech') {
    const started = await waitForEvent(
      store,
      (e) => {
        if (e.type !== 'intent.started') return false;
        const intent = intentKey(store, e.data.id);
        // 角色的回应（不含过渡语）：意图键是 director:<实例>:<序号>#<句序号>。
        return (
          intent?.type === 'speech.play' &&
          intent.key.startsWith('director:') &&
          !intent.key.includes(':fallback:')
        );
      },
      0,
      options.waitMs,
      '角色的回应开始播出（模型可能没有回应）',
    );
    const sentence = intentKey(store, started.data.id)?.key ?? '';
    const utterance = sentence.replace(/#\d+$/u, '');
    await sleep(options.killAfterMs);
    const ended = store
      .events(started.seq)
      .some((e) => e.type === 'utterance.played' && e.data.id === utterance);
    if (ended) throw new Error(`回应在 ${options.killAfterMs}ms 内就说完了，没能在播出中结束宿主`);
    const executing = store
      .intents()
      .filter((i) => i.key.startsWith(`${utterance}#`) && i.state === 'executing')
      .map((i) => i.key);
    const killSeq = store.lastSeq();
    host.kill();
    return {
      killSeq,
      target: { utterance, startedSentence: sentence, executingAtKill: executing },
    };
  }
  if (timing === 'vote') {
    const announced = await waitForEvent(
      store,
      (e) => e.type === 'vote.announced',
      0,
      options.waitMs,
      '投票开始倒计时（模型可能没有发起投票）',
    );
    const voteId = String(announced.data.voteId);
    const durationMs = Number(announced.data.durationMs);
    await sleep(Math.min(options.killAfterMs, durationMs / 2));
    const killSeq = store.lastSeq();
    host.kill();
    return { killSeq, target: { voteId, durationMs } };
  }
  const held = await host.host.wait(
    (l: LogLine) => l.event === 'drill.iris-held',
    options.waitMs,
    0,
    'Iris 写入（drill-iris-hold 扣住应答）',
  );
  await sleep(300);
  const executing = store
    .intents()
    .filter((i) => i.type === 'memory.write' && i.state === 'executing')
    .map((i) => i.key);
  const killSeq = store.lastSeq();
  host.kill();
  return { killSeq, target: { heldStatus: held.status, executingAtKill: executing } };
}

/** 排队写入 Iris 的条目（由 `memory.queued` 归约），与记下的写入。 */
function memoryLedger(events: readonly StoreEvent[]) {
  const epoch = events.find((e) => e.type === 'memory.epoch')?.data.id;
  const queued = new Map<number, QueuedItem>();
  const written = new Map<number, number[]>();
  for (const e of events) {
    if (e.type === 'memory.queued') {
      const d = e.data as Record<string, unknown>;
      queued.set(e.seq, {
        seq: e.seq,
        at: e.recordedAt,
        kind: d.kind as QueuedItem['kind'],
        ref: String(d.ref),
        account: (d.account as string | null) ?? null,
        sender: String(d.sender),
        content: String(d.content),
      });
    }
    if (e.type === 'memory.written') {
      const seqs = (e.data.seqs as number[]) ?? [];
      const ids = (e.data.messageIds as number[]) ?? [];
      seqs.forEach((seq, i) => {
        const list = written.get(seq) ?? [];
        list.push(ids[i] as number);
        written.set(seq, list);
      });
    }
  }
  return { epoch: typeof epoch === 'string' ? epoch : undefined, queued, written };
}

/**
 * 用 Iris 的宿主接口核对：记为已写入的每一条以原去重键再提交一次，Iris 按键返回原消息；返回的 ID 应与
 * `memory.written` 记下的相同。令牌只在本进程里用于请求头，不打印、不写进结果。
 */
async function verifyIris(options: Options, events: readonly StoreEvent[]) {
  const { epoch, queued, written } = memoryLedger(events);
  if (!epoch || !options.memory) return { checked: 0, note: '没有去重键前缀（记忆没有运行）' };
  const memory = entryOf(options.live, 'memory');
  const iris = entryOf(options.live, 'iris-client');
  const config = Value.Default(MemoryConfig, structuredClone(memory?.config ?? {})) as MemoryConfig;
  const baseUrl = String(
    (iris?.config as { baseUrl?: unknown } | undefined)?.baseUrl ?? IRIS_DEFAULT_URL,
  );
  const token = (
    await pluginSecrets(
      new KeyringSecretStore(SECRET_SERVICE),
      new Set([secretPermission(IRIS_SECRET)]),
      new Set([SESSION_SECRET, OBS_SECRET, SIM_OBS_SECRET]),
    ).read(IRIS_SECRET)
  )?.trim();
  if (!token) throw new Error(`SecretStore（${SECRET_SERVICE}）中没有 ${IRIS_SECRET}`);
  const client = new IrisClient({
    baseUrl,
    token,
    clock: systemClock(),
    requestTimeoutMs: 30_000,
    maxResponseBytes: 8 * 1024 * 1024,
  });
  const items = [...written.keys()]
    .map((seq) => queued.get(seq))
    .filter((item): item is QueuedItem => item !== undefined);
  if (items.length === 0) return { checked: 0, note: '没有记为已写入的条目' };
  const messages: IrisMessage[] = items.map((item) => ({
    platform: config.platform,
    sender: item.sender,
    ...(item.account === null ? {} : { accountId: item.account }),
    content: item.content,
    occurredAt: new Date(item.at).toISOString(),
    dedupeKey: dedupeKey(epoch, item),
    kind: item.kind,
    entryName: config.entryName,
    entryKind: 'live',
    pace: config.pace,
  }));
  const result = await client.writeMessages(
    options.memory.entryId,
    messages,
    new AbortController().signal,
  );
  const rows = items.map((item, i) => {
    const recorded = written.get(item.seq) ?? [];
    return {
      seq: item.seq,
      kind: item.kind,
      recorded,
      returned: result.messageIds[i],
      same: recorded.length === 1 && recorded[0] === result.messageIds[i],
    };
  });
  return { checked: rows.length, same: rows.filter((r) => r.same).length, rows };
}

/** 核对一轮：重启前后的事实。 */
export function verify(
  timing: Timing,
  events: readonly StoreEvent[],
  intents: ReturnType<StoreReader['intents']>,
  killSeq: number,
  target: Record<string, unknown>,
  memory: boolean,
) {
  const restart = restartSeq(events, killSeq);
  const after = events.filter((e) => e.seq >= restart);
  const keyOf = new Map(intents.map((i) => [i.id, i.key]));
  const keyed = (e: StoreEvent) => String(e.data.key ?? keyOf.get(Number(e.data.id)) ?? '');
  const recovery = after.filter(
    (e) => e.type === 'intent.orphaned' || e.type === 'intent.abandoned',
  );
  const base = { killSeq, restartSeq: Number.isFinite(restart) ? restart : null };
  if (!Number.isFinite(restart)) return { ...base, ok: false, problems: ['没有找到重启后的事实'] };

  if (timing === 'speech') {
    const utterance = String(target.utterance);
    const own = (e: StoreEvent) => keyed(e).startsWith(`${utterance}#`);
    const redone = after.filter(
      (e) => (e.type === 'intent.authorized' || e.type === 'intent.started') && own(e),
    );
    const writeback = events.filter(
      (e) => e.type === 'utterance.played' && e.data.id === utterance,
    );
    const queued = events.filter(
      (e) =>
        e.type === 'memory.queued' && e.data.kind === 'self_output' && e.data.ref === utterance,
    );
    const orphaned = recovery.filter((e) => e.type === 'intent.orphaned' && own(e));
    const isolated = intents.filter((i) => i.state === 'unknown' && i.target === 'stage');
    const denied = after.filter(
      (e) => e.type === 'intent.denied' && String(e.data.reason ?? '').includes('隔离'),
    );
    const problems = [
      ...(redone.length > 0 ? ['被打断的发言重启后又授权或执行了'] : []),
      ...(writeback.length > 0 ? ['被打断的发言有写回（宿主在播出中被结束，不该记下结果）'] : []),
      ...(memory && queued.length > 0 ? ['被打断的发言排队写入了 Iris'] : []),
      ...(orphaned.length === 0 ? ['重启前执行中的那一句没有记为结果未知'] : []),
    ];
    return {
      ...base,
      ok: problems.length === 0,
      problems,
      noReplay: redone.length === 0,
      writeback: writeback.map(evidence),
      queuedForIris: queued.map(evidence),
      orphaned: orphaned.map(evidence),
      // 发现：有时效的意图只能由操作员结案，结案的命令尚未提供；隔离期间新的发言都被拒绝。
      stageIsolated: isolated.map((i) => ({ id: i.id, key: i.key })),
      deniedAsIsolated: denied.length,
      evidence: events
        .filter((e) => own(e) || (e.type === 'utterance.played' && e.data.id === utterance))
        .map(evidence),
    };
  }

  if (timing === 'vote') {
    const voteId = String(target.voteId);
    const mine = events.filter((e) => e.type.startsWith('vote.') && e.data.voteId === voteId);
    const startedCount = mine.filter((e) => e.type === 'vote.started').length;
    const aborted = mine.filter((e) => e.type === 'vote.aborted');
    const ended = mine.filter((e) => e.type === 'vote.ended');
    const speech = (part: string) =>
      events.filter((e) => e.type === 'utterance.played' && e.data.id === `vote:${voteId}:${part}`);
    const speechIntents = (part: string) =>
      after.filter(
        (e) =>
          (e.type === 'intent.authorized' || e.type === 'intent.started') &&
          keyed(e).startsWith(`vote:${voteId}:${part}#`),
      );
    const reconciled = after.filter(
      (e) => e.type === 'intent.reconciled' && keyed(e) === `vote:${voteId}`,
    );
    const problems = [
      ...(startedCount !== 1 ? [`这次投票开了 ${startedCount} 次`] : []),
      ...(aborted.length !== 1 || aborted[0]?.data.cause !== 'restart'
        ? ['重启后没有恰好一条 cause 为 restart 的中止']
        : []),
      ...(ended.length > 0 ? ['重启打断的投票出了结果'] : []),
      ...(speech('opening').length !== 1 ? ['开票说明的写回不是恰好一次'] : []),
      ...(speechIntents('opening').length > 0 ? ['重启后又请求播出开票说明'] : []),
      ...(speech('result').length > 0 || speechIntents('result').length > 0
        ? ['中止的投票播报了结果']
        : []),
    ];
    return {
      ...base,
      ok: problems.length === 0,
      problems,
      reconciled: reconciled.map(evidence),
      evidence: [...mine, ...speech('opening'), ...speech('result'), ...reconciled]
        .sort((a, b) => a.seq - b.seq)
        .map(evidence),
    };
  }

  const { queued, written } = memoryLedger(events);
  const before = events.filter((e) => e.seq <= killSeq);
  const writtenBefore = new Set(
    before
      .filter((e) => e.type === 'memory.written')
      .flatMap((e) => (e.data.seqs as number[]) ?? []),
  );
  // 结束宿主时还在待发队列里的（含在途的那一批）；重启后排队的不算。
  const pendingAtKill = [...queued.keys()].filter(
    (seq) => seq <= killSeq && !writtenBefore.has(seq),
  );
  const twice = [...written].filter(([, ids]) => ids.length > 1).map(([seq]) => seq);
  const unwritten = pendingAtKill.filter((seq) => !written.has(seq));
  const executing = (target.executingAtKill as string[]) ?? [];
  const reconciled = after.filter(
    (e) => e.type === 'intent.reconciled' && executing.includes(keyed(e)),
  );
  const problems = [
    ...(executing.length === 0 ? ['结束宿主时没有执行中的写入意图（没能制造出在途）'] : []),
    ...(reconciled.length !== executing.length ? ['重启前执行中的写入意图没有全部对账'] : []),
    ...(twice.length > 0 ? [`排队序号 ${twice.join('、')} 记了不止一次写入`] : []),
    ...(unwritten.length > 0
      ? [`重启前在途的序号 ${unwritten.join('、')} 重启后没有补发成功`]
      : []),
  ];
  return {
    ...base,
    ok: problems.length === 0,
    problems,
    pendingAtKill,
    reconciled: reconciled.map(evidence),
    evidence: events
      .filter((e) => e.type.startsWith('memory.') && e.type !== 'memory.epoch')
      .map(evidence),
  };
}

async function round(
  timing: Timing,
  index: number,
  run: string,
  options: Options,
): Promise<Record<string, unknown>> {
  const name = `${timing}-${index}`;
  const storePath = join(options.dir.dir, `${name}.db`);
  const id = `drill-${run}-${name}`;
  const probeId = `${id}-probe`;
  const outputs =
    timing === 'speech'
      ? [speak(REPLY, `c-${id}`)]
      : timing === 'vote'
        ? [JSON.stringify({ action: 'vote', ...VOTE })]
        : [JSON.stringify({ action: 'silence', reason: '演练' })];
  const record: Record<string, unknown> = { timing, index, danmakuId: id };
  let phase: Phase | undefined;
  try {
    say(`第 ${index} 轮 ${timing}：拉起宿主……`);
    phase = await launchPhase(
      options,
      `${name}-before`,
      storePath,
      patchOps(options, { id, text: TEXT[timing] }, outputs),
      timing === 'memory' ? `${holdModule}?hold-ms=${options.holdMs}` : undefined,
    );
    const { killSeq, target } = await induce(timing, phase, options);
    record.target = target;
    record.killedAt = new Date().toISOString();
    say(`第 ${index} 轮 ${timing}：已强制结束宿主`);
    const acted = await phase.host.watchdog
      .wait((l) => l.event === 'watchdog.acted', 10_000, 0, '看门狗接管')
      .catch(() => undefined);
    record.watchdog = acted ? { reason: acted.reason, ok: acted.ok } : null;
    phase.store.close();
    await phase.host.stop();
    phase = undefined;

    // 在同一个状态存储上重新拉起：探测弹幕（回放模型时有一句写好的回应）。
    phase = await launchPhase(
      options,
      `${name}-after`,
      storePath,
      patchOps(options, { id: probeId, text: TEXT.probe }, [speak(PROBE_REPLY, `c-${probeId}`)]),
    );
    const recovered = phase.host.host.find((l) => l.event === 'host.recovered');
    record.recovered = recovered
      ? { abandoned: recovered.abandoned, orphaned: recovered.orphaned }
      : null;
    await sleep(options.observeMs);
    if (timing === 'memory') {
      // 等重启前在途的那一批补发完（安全停止中不写，进入 M2 之后才补发）。
      const deadline = Date.now() + options.waitMs;
      for (;;) {
        const { queued, written } = memoryLedger(phase.store.events());
        const pending = [...queued.keys()].filter((seq) => !written.has(seq));
        if (pending.length === 0 || Date.now() > deadline) break;
        await sleep(500);
      }
    }
    const events = phase.store.events();
    const intents = phase.store.intents();
    record.result = verify(timing, events, intents, killSeq, target, options.memory !== undefined);
    if (timing === 'memory')
      record.iris = await verifyIris(options, events).catch((error) => ({
        error: (error as Error).message,
      }));
    record.probe = {
      replied: events.some(
        (e) =>
          e.type === 'utterance.played' && e.data.source === 'danmaku-reply' && e.seq > killSeq,
      ),
    };
  } catch (error) {
    record.error = (error as Error).message;
    say(`第 ${index} 轮 ${timing} 没做成：${(error as Error).message}`);
  } finally {
    phase?.store.close();
    await phase?.host.stop();
  }
  return record;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      config: { type: 'string', default: 'config/live.json' },
      rounds: { type: 'string', default: '3' },
      timings: { type: 'string' },
      model: { type: 'string', default: 'real' },
      memory: { type: 'boolean', default: false },
      entry: { type: 'string', default: 'bellis:drill' },
      'kill-after-ms': { type: 'string', default: '1500' },
      'hold-ms': { type: 'string', default: '5000' },
      'wait-ms': { type: 'string', default: '90000' },
      'observe-ms': { type: 'string', default: '15000' },
      out: { type: 'string' },
    },
  });
  const rounds = checkIntArg('--rounds', values.rounds, 1);
  const killAfterMs = checkIntArg('--kill-after-ms', values['kill-after-ms'], 0);
  const holdMs = checkIntArg('--hold-ms', values['hold-ms'], 1000);
  const waitMs = checkIntArg('--wait-ms', values['wait-ms'], 10_000);
  const observeMs = checkIntArg('--observe-ms', values['observe-ms'], 0);
  if (values.model !== 'real' && values.model !== 'replay')
    throw new Error('--model 只能是 real 或 replay');
  const timings = (values.timings ?? (values.memory ? 'speech,vote,memory' : 'speech,vote'))
    .split(',')
    .map((t) => t.trim()) as Timing[];
  for (const timing of timings) {
    if (!TIMINGS.includes(timing)) throw new Error(`--timings 只能取 ${TIMINGS.join('、')}`);
  }
  if (timings.includes('memory') && !values.memory) throw new Error('memory 时机要加 --memory');
  if (values.memory) {
    const blocked = entryIdBlocker(values.entry);
    if (blocked) throw new Error(`--entry 不合法：${blocked}`);
  }
  const live = readLiveConfig(values.config);
  const started = new Date().toISOString();
  const run = started.replace(/\D/g, '').slice(2, 14);
  const out = resolve(
    values.out ?? join(root, 'reports', `drill-p2-restart-${started.replace(/[:.]/g, '-')}`),
  );
  mkdirSync(dirname(out), { recursive: true });

  const result: Record<string, unknown> = {
    drill: 'p2-restart',
    started,
    node: process.version,
    config: values.config,
    params: {
      rounds,
      timings,
      model: values.model,
      memory: values.memory,
      ...(values.memory ? { entry: values.entry } : {}),
      killAfterMs,
      holdMs,
      waitMs,
      observeMs,
    },
  };
  const records: Array<Record<string, unknown>> = [];
  const dir = new DrillDir('p2-restart');
  let scene: ObsScene | undefined;
  try {
    await waitForNoOtherBellis({ log: say });
    scene = await inspectObs(live, await connectObs());
    result.obsVersion = scene.version;
    const options: Options = {
      live,
      scene,
      dir,
      model: values.model as Options['model'],
      memory: values.memory ? { entryId: values.entry } : undefined,
      killAfterMs,
      holdMs,
      waitMs,
      observeMs,
    };
    for (const timing of timings) {
      for (let index = 1; index <= rounds; index++) {
        const record = await round(timing, index, run, options);
        records.push(record);
        say(
          `第 ${index} 轮 ${timing}：${JSON.stringify(record.result ?? { error: record.error })}`,
        );
      }
    }
  } catch (error) {
    result.error = (error as Error).message;
    say(`演练中止：${(error as Error).message}`);
  } finally {
    if (scene) {
      result.obsRestored = await restoreObs(scene);
      scene.obs.close();
    }
    dir.remove();
  }
  const done = (timing: Timing) => records.filter((r) => r.timing === timing);
  result.summary = Object.fromEntries(
    timings.map((timing) => {
      const list = done(timing);
      const verified = list.filter((r) => (r.result as { ok?: boolean } | undefined)?.ok === true);
      return [
        timing,
        {
          rounds: list.length,
          verified: verified.length,
          failed: list.filter((r) => (r.result as { ok?: boolean } | undefined)?.ok === false)
            .length,
          // 没做成：没能制造出这个时机，或预检没通过、宿主没拉起来等。
          incomplete: list.filter((r) => r.error !== undefined).length,
        },
      ];
    }),
  );
  result.rounds = records;
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
