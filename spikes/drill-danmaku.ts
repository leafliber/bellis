/**
 * P2 第 2 步：B 站直播开放平台弹幕接入的真机演练（R-18）。
 *
 *   node spikes/drill-danmaku.ts [--duration-s 600] [--app-id 项目ID] [--profile config/profiles/live.json]
 *        [--out 结果文件]
 *
 * 按接入插件的方式开启场次、连长连接、收一段时间消息，然后关闭场次；Ctrl+C 提前结束（仍会关闭场次）。
 * 项目 ID 与时限取自 profile 里 `danmaku-bilibili` 条目的配置（缺省值见插件），`--app-id` 优先。
 * 凭据按宿主装配插件的方式读取（`pluginSecrets`，只放行 `secret:bilibili` 与 `secret:bilibili-code`），
 * 来自 SecretStore 服务名 bellis，只在本进程内用于签名与开启场次；不复制、不打印、不写进结果。
 *
 * 统计：各命令的条数与按插件规则的归类（含去重）；平台时间戳到本机收到的时延分布（平台时间戳是秒级，时延含
 * 0–1 秒的截断，且含两边墙钟的偏差）；场次的开启、失败与失效，长连接的连上、断开与原因，缺口与时长。
 * 结果写到 reports/drill-danmaku-<时间>.json。报告与输出里不写弹幕正文、昵称、头像与任何凭据，只写编号、类型、计数与时延。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { arch, platform, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  BilibiliClient,
  BilibiliConfig,
  type ClientSink,
  configBlocker,
  danmakuBilibili,
  Intake,
  OpenApi,
  readCredentials,
  readIdentityCode,
  timings,
} from '@bellis/bilibili';
import { OBS_SECRET, SIM_OBS_SECRET } from '@bellis/config';
import { readJsonFile, resolveProfile, systemClock } from '@bellis/kernel';
import { KeyringSecretStore, SESSION_SECRET } from '@bellis/secret-store';
import Value from 'typebox/value';
import { pluginSecrets } from '../packages/host/src/secrets.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const round1 = (v: number) => Math.round(v * 10) / 10;

function summarize(values: readonly number[]) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const r = (v: number | undefined) => (v === undefined ? null : round1(v));
  return {
    n: sorted.length,
    min: r(sorted[0]),
    p50: r(at(0.5)),
    p95: r(at(0.95)),
    p99: r(at(0.99)),
    max: r(sorted.at(-1)),
  };
}

const say = (message: string) => console.log(`${new Date().toISOString()} ${message}`);

/** profile 里 danmaku-bilibili 条目的配置；文件不存在或没有这个条目时为 undefined。 */
function profileConfig(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  const found = resolveProfile(readJsonFile(path), []).find(
    (entry) => entry.plugin === danmakuBilibili.manifest.id,
  );
  return found ? { ...(found.config as Record<string, unknown>) } : undefined;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'duration-s': { type: 'string', default: '600' },
      'app-id': { type: 'string' },
      profile: { type: 'string', default: 'config/profiles/live.json' },
      out: { type: 'string' },
    },
  });
  const durationS = Number(values['duration-s']);
  if (!Number.isFinite(durationS) || durationS <= 0) throw new Error('--duration-s 须为正数');
  const profilePath = resolve(root, values.profile);
  const raw = profileConfig(profilePath) ?? {};
  if (values['app-id'] !== undefined) raw.appId = Number(values['app-id']);
  const config = Value.Default(BilibiliConfig, raw) as BilibiliConfig;
  if (!Value.Check(BilibiliConfig, config)) {
    throw new Error(
      `danmaku-bilibili 的配置不合法：${JSON.stringify([...Value.Errors(BilibiliConfig, config)].slice(0, 3))}`,
    );
  }
  // 与 profile 授予插件的权限相同：清单申请的外发主机与两项凭据。
  const permissions = new Set(danmakuBilibili.manifest.permissions);
  const blocker = configBlocker(config, permissions);
  if (blocker) {
    throw new Error(
      `${blocker}${config.appId <= 0 ? `（用 --app-id 给出，或在 ${values.profile} 的 danmaku-bilibili 条目里配置）` : ''}`,
    );
  }

  const secrets = pluginSecrets(
    new KeyringSecretStore('bellis'),
    permissions,
    new Set([SESSION_SECRET, OBS_SECRET, SIM_OBS_SECRET]),
  );
  // 缺凭据时的说明里有录入方法，不含任何值。
  const credentials = await readCredentials(secrets);
  const code = await readIdentityCode(secrets);

  const startedAt = new Date();
  const stamp = startedAt.toISOString().slice(0, 19).replaceAll(':', '-');
  const outPath = resolve(root, values.out ?? join('reports', `drill-danmaku-${stamp}.json`));
  mkdirSync(dirname(outPath), { recursive: true });

  const clock = systemClock();
  const intake = new Intake(config.dedupCapacity);
  const commands: Record<string, number> = {};
  const kinds: Record<string, number> = {};
  const latency: { danmaku: number[]; all: number[] } = { danmaku: [], all: [] };
  const gaps: Array<{
    reason: string;
    startedAt: string;
    durationMs?: number;
    recovered?: boolean;
  }> = [];
  const events: Record<string, number> = {};
  const sessions = {
    opened: [] as Array<{ gameId: unknown; links: unknown }>,
    failed: [] as Array<{ code: unknown; retryInMs: unknown; reason: unknown }>,
    invalid: [] as unknown[],
    ended: 0,
    endFailed: [] as Array<{ code: unknown; error: unknown }>,
  };
  const links = {
    ready: [] as unknown[],
    closed: [] as Array<{ host: unknown; reason: unknown; readyMs: unknown }>,
    failed: [] as Array<{ host: unknown; reason: unknown }>,
    skipped: [] as Array<{ host: unknown; reason: unknown }>,
  };
  const malformed: unknown[] = [];

  const sink: ClientSink = {
    command(command, receivedAt) {
      const cmd = command.cmd.slice(0, 64);
      commands[cmd] = (commands[cmd] ?? 0) + 1;
      const result = intake.accept(command, receivedAt);
      kinds[result.kind] = (kinds[result.kind] ?? 0) + 1;
      if (result.kind === 'duplicate') return;
      const timestamp = (command.data as { timestamp?: unknown } | null)?.timestamp;
      if (typeof timestamp === 'number' && timestamp > 0) {
        const ms = receivedAt - timestamp * 1000;
        latency.all.push(ms);
        if (result.kind === 'danmaku' || result.kind === 'emoji') latency.danmaku.push(ms);
      }
    },
    gapStarted(gap) {
      gaps.push({ reason: gap.reason, startedAt: new Date(gap.startedAt).toISOString() });
    },
    gapEnded(gap) {
      const open = gaps.findLast((g) => g.durationMs === undefined);
      if (open) {
        open.durationMs = gap.durationMs;
        open.recovered = gap.recovered;
      }
    },
  };
  // 客户端的日志只有编号、主机、计数、状态与原因，原样打印。
  const log = (event: string, fields: Record<string, unknown>) => {
    events[event] = (events[event] ?? 0) + 1;
    say(`${event} ${JSON.stringify(fields)}`);
    switch (event) {
      case 'bilibili.session-opened':
        sessions.opened.push({ gameId: fields.gameId, links: fields.links });
        break;
      case 'bilibili.session-failed':
        sessions.failed.push({
          code: fields.code,
          retryInMs: fields.retryInMs,
          reason: fields.reason,
        });
        break;
      case 'bilibili.session-invalid':
        sessions.invalid.push(fields.reason);
        break;
      case 'bilibili.session-ended':
        sessions.ended += 1;
        break;
      case 'bilibili.end-failed':
        sessions.endFailed.push({ code: fields.code, error: fields.error });
        break;
      case 'bilibili.link-ready':
        links.ready.push(fields.host);
        break;
      case 'bilibili.link-closed':
        links.closed.push({ host: fields.host, reason: fields.reason, readyMs: fields.readyMs });
        break;
      case 'bilibili.link-failed':
        links.failed.push({ host: fields.host, reason: fields.reason });
        break;
      case 'bilibili.host-skipped':
        links.skipped.push({ host: fields.host, reason: fields.reason });
        break;
      case 'bilibili.malformed':
        malformed.push(fields.reason);
        break;
    }
  };

  const api = new OpenApi({
    endpoint: config.endpoint,
    credentials,
    clock,
    wallNow: Date.now,
    timeoutMs: config.httpTimeoutMs,
  });
  api.redact(code);
  const client = new BilibiliClient({
    ...timings(config),
    api,
    appId: config.appId,
    code,
    permissions,
    clock,
    wallNow: Date.now,
    log,
    sink,
  });

  say(`开始：收 ${durationS} 秒，Ctrl+C 提前结束；结果写到 ${outPath}`);
  client.start();
  const startedClock = clock.now();
  let interrupted = false;
  await new Promise<void>((done) => {
    const timer = setTimeout(done, durationS * 1000);
    process.once('SIGINT', () => {
      interrupted = true;
      clearTimeout(timer);
      done();
    });
  });
  say('结束：关闭场次');
  await client.stop();
  const elapsedMs = Math.round(clock.now() - startedClock);

  const result = {
    drill: 'danmaku',
    startedAt: startedAt.toISOString(),
    endedAt: new Date().toISOString(),
    plannedS: durationS,
    elapsedMs,
    interrupted,
    machine: { platform: platform(), release: release(), arch: arch(), node: process.version },
    endpointHost: new URL(config.endpoint).host,
    commands,
    kinds,
    latencyMs: {
      note: '本机收到的墙钟时刻减平台时间戳（秒级）×1000：含 0–1 秒截断与两边墙钟偏差；重复的不计',
      danmaku: summarize(latency.danmaku),
      all: summarize(latency.all),
    },
    sessions,
    links,
    gaps,
    malformed,
    logEvents: events,
    finalState: client.status,
  };
  writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
  say(
    `完成：${
      Object.entries(commands)
        .map(([cmd, n]) => `${cmd.replace('LIVE_OPEN_PLATFORM_', '')} ${n}`)
        .join('，') || '没有收到消息'
    }；缺口 ${gaps.length} 个；结果见 ${outPath}`,
  );
}

main().catch((error: unknown) => {
  console.error(`演练失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
