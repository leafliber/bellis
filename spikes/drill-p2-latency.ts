/**
 * P2 第 10 步的真机演练：弹幕到首个音频（P2 出口“弹幕到首个音频实测”，时延目标见总体架构）。
 *
 *   node spikes/drill-p2-latency.ts [--config config/live.json] [--count 20] [--interval-ms 20000]
 *        [--lead-ms 3000] [--settle-ms 30000] [--memory] [--entry bellis:drill] [--out 结果文件前缀]
 *
 * B 站真实平台的测试暂缓（P2 任务卡），弹幕用录制回放注入，平台投递的时延不计入。用维护者的真实配置（profile 与它的
 * patch、OBS、凭据，SecretStore 服务名 bellis）拉起宿主与看门狗，另加一个本演练生成的临时 patch（写在系统临时目录，
 * 不入库，结束时删除）：
 * - 弹幕接入条目换成回放（danmaku-replay，`startOn: output`）：按 --count 与 --interval-ms 生成的合成弹幕，第一条在
 *   进入 M2 之后 --lead-ms 送出，之后每隔 --interval-ms 一条；分诊、投票、模型客户端与决策插件启用（真实决策模型，
 *   会外发到模型服务、按调用计费）；
 * - --memory：启用 Iris 客户端与记忆插件（召回进入决策，写入照常），入口改成 --entry（缺省 bellis:drill，演练专用，
 *   宿主令牌的范围须包含它），合成弹幕与演练中的发言不写进直播间的入口；缺省不启用记忆。
 * 其余照用维护者的配置：TTS、Stage、形象、OBS、遥测。状态存储放在系统临时目录（演练的事实与内容不进直播用的事件
 * 日志），结束时删除；遥测写在它旁边，读完复制到报告旁边（遥测里没有内容）。
 *
 * 流程：等宿主就绪、Stage 认证、看门狗连上 OBS；切回直播场景、取消静音、确认在场，等开播预检通过后进入 M2，回放随之
 * 开始计时。每条弹幕到点前 2 秒确认在场（续上在场确认）；这时不在 M2（例如决策模型连续失败触发了降级）就记下这一轮，
 * 重新跑预检并进入 M2。最后一条送出后再等 --settle-ms，停止会话（宿主计划内停止：切安全场景并静音）。
 *
 * 测量（读这次的遥测 JSONL，口径见运维“直方图”）：
 * - `bellis.danmaku.time_to_first_audio` 与 `.presented`：样本数与 p50/p95/p99/max，对照时延目标 p95 ≤ 4 秒。
 *   另按弹幕核对：每条注入的弹幕有没有根 span（`danmaku.receive`），它的 trace 里有没有在 Stage 开始播出的句子
 *   （`stage.play` 的 started 事件），以此算出每条弹幕的首音时延；没得到回应的弹幕（模型沉默、出错、被合并、过期、
 *   不在 M2 等）是失败样本，不剔除：按条给出的分位数把它们算作无穷大；
 * - 决策模型：首块 `gen_ai.client.inference.time_to_first_chunk`、首个正文块 `bellis.llm.time_to_first_output`、
 *   整次调用 `gen_ai.client.inference.duration`，以及模型调用的结局计数（意图类型与 error.type）；
 * - TTS 首包 `bellis.tts.time_to_first_audio`（含其它发言的句子）；启用记忆时另有 `bellis.memory.recall.duration`。
 * 这些都是宿主侧的口径：首音以宿主收到 Stage 页面回报“开始播出”为准，`.presented` 再加呈现延迟 D 估计 OBS 输出，
 * 都不含推流与观众端的延迟。
 *
 * 推流进行中、或有别的 Bellis 进程在运行时拒绝运行。会切换节目场景、静音 Stage 源并改写 Stage 浏览器源的 URL；
 * 结束后把节目场景、静音与 Stage 源的设置（含 URL）恢复原样并读回比对。结果写 <前缀>.json（缺省
 * reports/drill-p2-latency-<时刻>），遥测复制到 <前缀>-telemetry/；只含编号、类型、计数与时延，不含弹幕、模型与字幕
 * 的内容，也不含凭据。宿主日志里有发言的内容，不落盘。
 */
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { entryIdBlocker } from '@bellis/memory';
import { OperatorMethod, type PatchOp } from '@bellis/protocol';
import { GenAi, loadDir, Metric, type TelemetryView, type ViewSpan } from '@bellis/telemetry';
import { telemetryDir } from '../packages/telemetry/src/locate.ts';
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
  say,
  sleep,
  summarize,
} from './live-drill.ts';

/** 时延目标：弹幕到首个音频 p95 ≤ 4 秒（总体架构“时延目标”）。 */
const TARGET_P95_MS = 4000;

/** 合成弹幕：普通的打招呼与提问，不含个人信息，也不是投票的写法。 */
const TEXTS = [
  '主播晚上好',
  '今天打算玩什么游戏？',
  '主播最喜欢什么颜色？',
  '刚下班来看直播了',
  '主播今天心情怎么样？',
  '推荐一部最近好看的动画吧',
  '主播喜欢猫还是狗？',
  '今天天气好热啊',
  '主播会唱歌吗？',
  '第一次来直播间，打个招呼',
] as const;
const VIEWERS = 7;

interface Round {
  index: number;
  id: string;
  /** 计划的送出时刻（从进入 M2 算起）。 */
  atMs: number;
  /** 到点前确认在场时的模式；不在 M2 时重新进入的结果。 */
  modeBefore: unknown;
  reentered?: { ok: boolean; error?: string };
}

/** 生成演练的 patch：弹幕接入换成回放，互动包启用；--memory 时启用记忆并改用演练的入口。 */
export function patchOps(
  live: LiveConfig,
  messages: Array<{ atMs: number; id: string; viewer: string; nickname: string; text: string }>,
  memory: { entryId: string } | undefined,
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
        config: { messages, startOn: 'output' },
      },
    },
  ];
  for (const plugin of ['audience-triage', 'audience-vote', 'llm-openai', 'director']) {
    const entry = entryOf(live, plugin);
    if (!entry)
      throw new Error(`profile 里没有 ${plugin} 的条目：从样例整段复制 interaction 包，并填好配置`);
    if (entry.disabled) ops.push({ op: 'enable', id: entry.id });
  }
  if (memory) {
    const iris = entryOf(live, 'iris-client');
    const store = entryOf(live, 'memory');
    if (!iris || !store) throw new Error('profile 里没有记忆包（iris、memory）：从样例整段复制');
    if (iris.disabled) ops.push({ op: 'enable', id: iris.id });
    ops.push({
      op: 'replace',
      entry: profileEntry(store, {
        disabled: false,
        config: { ...(store.config as Record<string, unknown>), entryId: memory.entryId },
      }),
    });
  }
  return ops;
}

/** 一条弹幕的首音：它的 trace 里在 Stage 开始播出的最早一句，减去根 span 的开始。 */
export function perDanmaku(view: TelemetryView, ids: readonly string[]) {
  const roots = new Map<string, ViewSpan>();
  for (const span of view.spans) {
    const id = span.attributes['bellis.danmaku.id'];
    if (span.name === 'danmaku.receive' && typeof id === 'string' && ids.includes(id))
      roots.set(id, span);
  }
  const started = new Map<string, bigint>();
  for (const span of view.spans) {
    if (span.name !== 'stage.play') continue;
    const event = span.events.find((e) => e.name === 'bellis.stage.started');
    if (!event) continue;
    const earliest = started.get(span.traceId);
    if (earliest === undefined || event.time < earliest) started.set(span.traceId, event.time);
  }
  return ids.map((id) => {
    const root = roots.get(id);
    const at = root ? started.get(root.traceId) : undefined;
    return {
      id,
      received: root !== undefined,
      firstAudioMs:
        root && at !== undefined ? Number(at - root.start) / 1_000_000 : Number.POSITIVE_INFINITY,
    };
  });
}

/** 直方图（秒）的原值换成毫秒的分位数。 */
function metric(view: TelemetryView, name: string) {
  const values = view.metrics.get(`${name} s`)?.values ?? [];
  return summarize(values.map((seconds) => seconds * 1000));
}

/** 模型调用的结局：意图类型或 error.type 的计数。 */
function directorOutcomes(view: TelemetryView) {
  const counts: Record<string, number> = {};
  for (const span of view.spans) {
    if (span.scope !== 'director' || span.attributes[GenAi.OperationName] !== 'chat') continue;
    const error = span.attributes['error.type'];
    const key =
      typeof error === 'string'
        ? `error:${error}`
        : `action:${String(span.attributes['bellis.director.action'] ?? '?')}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      config: { type: 'string', default: 'config/live.json' },
      count: { type: 'string', default: '20' },
      'interval-ms': { type: 'string', default: '20000' },
      'lead-ms': { type: 'string', default: '3000' },
      'settle-ms': { type: 'string', default: '30000' },
      memory: { type: 'boolean', default: false },
      entry: { type: 'string', default: 'bellis:drill' },
      out: { type: 'string' },
    },
  });
  const count = checkIntArg('--count', values.count, 1);
  const intervalMs = checkIntArg('--interval-ms', values['interval-ms'], 1000);
  const leadMs = checkIntArg('--lead-ms', values['lead-ms'], 0);
  const settleMs = checkIntArg('--settle-ms', values['settle-ms'], 0);
  if (values.memory) {
    const blocked = entryIdBlocker(values.entry);
    if (blocked) throw new Error(`--entry 不合法：${blocked}`);
  }
  const live = readLiveConfig(values.config);
  const started = new Date().toISOString();
  const run = started.replace(/\D/g, '').slice(2, 14);
  const out = resolve(
    values.out ?? join(root, 'reports', `drill-p2-latency-${started.replace(/[:.]/g, '-')}`),
  );
  mkdirSync(dirname(out), { recursive: true });

  const messages = Array.from({ length: count }, (_, i) => ({
    atMs: leadMs + i * intervalMs,
    id: `drill-${run}-${i + 1}`,
    viewer: `drill-viewer-${(i % VIEWERS) + 1}`,
    nickname: `观众${(i % VIEWERS) + 1}`,
    text: TEXTS[i % TEXTS.length] as string,
  }));
  const ids = messages.map((m) => m.id);
  const dir = new DrillDir('p2-latency');
  const storePath = join(dir.dir, 'state.db');
  const result: Record<string, unknown> = {
    drill: 'p2-latency',
    started,
    node: process.version,
    config: values.config,
    params: {
      count,
      intervalMs,
      leadMs,
      settleMs,
      memory: values.memory,
      ...(values.memory ? { entry: values.entry } : {}),
    },
    danmakuIds: ids,
  };
  const rounds: Round[] = [];
  let scene: ObsScene | undefined;
  let host: LiveHost | undefined;
  let telemetry: string | undefined;
  try {
    const configPath = await dir.writeConfig(
      live,
      'p2-latency',
      patchOps(live, messages, values.memory ? { entryId: values.entry } : undefined),
      storePath,
    );
    telemetry = telemetryDir(configPath);
    await waitForNoOtherBellis({ log: say });
    scene = await inspectObs(live, await connectObs());
    result.obsVersion = scene.version;

    say('拉起宿主与看门狗……');
    host = await LiveHost.start(configPath);
    await host.ready();
    // 第一次等开播预检通过：本地 TTS 等可能还在加载，多等一会儿。
    await host.enterM2(scene, 240_000);
    const t0 = Date.now();
    result.m2At = new Date(t0).toISOString();
    say(`已进入 M2，回放开始计时：${count} 条弹幕，间隔 ${intervalMs}ms`);

    for (const [index, message] of messages.entries()) {
      await sleep(Math.max(0, t0 + message.atMs - 2000 - Date.now()));
      await host.call(OperatorMethod.Presence);
      const status = await host.call(OperatorMethod.Status);
      const round: Round = {
        index: index + 1,
        id: message.id,
        atMs: message.atMs,
        modeBefore: status.mode,
      };
      if (status.mode !== 'M2') {
        say(`第 ${index + 1} 条到点前不在 M2（${String(status.mode)}），重新进入`);
        try {
          await host.enterM2(scene, 30_000);
          round.reentered = { ok: true };
        } catch (error) {
          round.reentered = { ok: false, error: (error as Error).message };
        }
      }
      rounds.push(round);
    }
    await sleep(Math.max(0, t0 + (messages.at(-1)?.atMs ?? 0) + settleMs - Date.now()));
    const status = await host.call(OperatorMethod.Status);
    result.final = { mode: status.mode, llm: status.llm, memory: status.memory };
  } catch (error) {
    result.error = (error as Error).message;
    say(`演练中止：${(error as Error).message}`);
  } finally {
    // 计划内停止：宿主写完剩下的遥测再退出。
    await host?.stop();
    if (scene) {
      result.obsRestored = await restoreObs(scene);
      scene.obs.close();
    }
  }

  result.rounds = rounds;
  try {
    await measure(result, telemetry, ids, out, values.memory);
  } finally {
    // 状态存储（有内容）与遥测原件都在临时目录里。
    dir.remove();
  }
  result.finished = new Date().toISOString();
  writeFileSync(`${out}.json`, `${JSON.stringify(result, null, 2)}\n`);
  console.log(
    JSON.stringify({ firstAudio: result.firstAudio ?? null, llm: result.llm ?? null }, null, 2),
  );
  say(`结果已写入 ${out}.json`);
}

/** 读这次的遥测，写进结果，并把遥测复制到报告旁边。 */
async function measure(
  result: Record<string, unknown>,
  telemetry: string | undefined,
  ids: readonly string[],
  out: string,
  memory: boolean,
): Promise<void> {
  if (telemetry && existsSync(telemetry)) {
    const view = await loadDir(telemetry);
    const danmaku = perDanmaku(view, ids);
    const firstAudio = metric(view, Metric.DanmakuFirstAudio);
    const all = summarize(danmaku.map((d) => d.firstAudioMs));
    const p95 = all.p95;
    result.telemetry = { files: view.files, lines: view.lines, invalid: view.invalid };
    result.firstAudio = {
      target: { p95Ms: TARGET_P95_MS },
      metric: firstAudio,
      presented: metric(view, Metric.DanmakuFirstAudioPresented),
      perDanmaku: {
        injected: ids.length,
        received: danmaku.filter((d) => d.received).length,
        answered: danmaku.filter((d) => Number.isFinite(d.firstAudioMs)).length,
        // 没得到回应的算作无穷大，失败样本不剔除。
        ms: all,
        meetsTarget: typeof p95 === 'number' ? p95 <= TARGET_P95_MS : false,
        samples: danmaku.map((d) => ({
          id: d.id,
          received: d.received,
          ms: Number.isFinite(d.firstAudioMs) ? Math.round(d.firstAudioMs * 10) / 10 : null,
        })),
      },
    };
    result.llm = {
      timeToFirstChunk: metric(view, GenAi.InferenceTimeToFirstChunk),
      timeToFirstOutput: metric(view, Metric.LlmFirstOutput),
      duration: metric(view, GenAi.InferenceDuration),
      outcomes: directorOutcomes(view),
    };
    result.tts = { timeToFirstAudio: metric(view, Metric.TtsFirstAudio) };
    if (memory) result.memory = { recall: metric(view, Metric.MemoryRecallDuration) };
    cpSync(telemetry, `${out}-telemetry`, { recursive: true });
    result.telemetryCopy = `${out}-telemetry`;
  } else {
    result.telemetry = '没有遥测文件：profile 里要启用 telemetry 插件（样例缺省启用）';
  }
}

// 被导入时（核对生成的 patch 与测量逻辑）不运行。
if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(`演练失败：${(error as Error).message}`);
    process.exitCode = 1;
  }
}
