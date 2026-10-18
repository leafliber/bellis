/**
 * P1 第 10 步：用维护者的真实配置彩排一次（不开推流），并在会话进行中核对密钥（P1 出口“平台”）。
 *
 *   node spikes/drill-rehearsal.ts [--config config/live.json] [--out 结果文件]
 *
 * 像 `pnpm start` 一样用正式的 SecretStore 服务名 bellis 拉起宿主与看门狗，把两者的输出原样写进
 * reports/ 下的日志文件。等 Stage 认证、形象认证（profile 含形象时）、本地 TTS 模型就绪（profile 含时），
 * 确认在场后跑 M1、M2 的开播预检；会话进行中跑一次 `secret audit`（缺省位置含 reports/ 与状态存储目录，
 * 此时会话密钥还在 SecretStore 里），停止会话后再跑一次。不切换模式，不产生输出。
 * 计划内停止时宿主切到安全场景并静音；结束后把节目场景、静音与 Stage 源 URL 恢复原样。
 */
import { spawnSync } from 'node:child_process';
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { connect, decodeSessionKey, RpcPeer } from '@bellis/channel';
import { loadConfig, OBS_SECRET, readObsSecret } from '@bellis/config';
import { launch, type Session } from '@bellis/launcher';
import { ObsClient, type ObsResult } from '@bellis/obs';
import { OperatorMethod, Role } from '@bellis/protocol';
import { KeyringSecretStore } from '@bellis/secret-store';

const file = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
const root = file('../');
const hostMain = file('../packages/host/src/main.ts');
const watchdogMain = file('../packages/watchdog/src/main.ts');
const secretCli = file('../packages/launcher/src/secret.ts');

type LogLine = { t: string; event: string; [field: string]: unknown };

class Lines {
  readonly items: LogLine[] = [];
  readonly #waiters = new Set<() => void>();

  constructor(stream: Readable | null, sink: (line: string) => void) {
    if (!stream) throw new Error('没有可读的输出');
    createInterface({ input: stream }).on('line', (line) => {
      sink(line);
      try {
        this.items.push(JSON.parse(line) as LogLine);
      } catch {
        return;
      }
      for (const wake of this.#waiters) wake();
    });
  }

  async wait(match: (line: LogLine) => boolean, timeoutMs: number): Promise<LogLine> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.items.find(match);
      if (found) return found;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`等待超时：${JSON.stringify(this.items.slice(-5))}`);
      await new Promise<void>((wake) => {
        const done = () => {
          this.#waiters.delete(done);
          wake();
        };
        this.#waiters.add(done);
        setTimeout(done, Math.min(left, 100));
      });
    }
  }
}

function ok(result: ObsResult): Record<string, unknown> {
  if (!result.ok)
    throw new Error(`${result.requestType} 失败：${result.code} ${result.comment ?? ''}`);
  return result.data ?? {};
}

const say = (message: string) => console.log(`${new Date().toISOString()} ${message}`);

/** 跑一次 `secret audit`（缺省位置）；输出只有文件、条目名、编码与次数。 */
function audit(): { exitCode: number | null; output: string[] } {
  const run = spawnSync(process.execPath, [secretCli, 'audit'], { cwd: root, encoding: 'utf8' });
  const output = `${run.stdout}${run.stderr}`.split(/\r?\n/).filter(Boolean);
  return { exitCode: run.status, output };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      config: { type: 'string', default: 'config/live.json' },
      out: { type: 'string' },
    },
  });
  const configPath = resolve(root, values.config);
  const config = loadConfig(configPath);
  const { stageSource } = config.safety.emergency;
  const started = new Date().toISOString();
  const stamp = started.slice(0, 19).replaceAll(':', '-');
  const logPath = join(root, 'reports', `rehearsal-${stamp}.log`);
  mkdirSync(dirname(logPath), { recursive: true });
  const log = createWriteStream(logPath);

  const secret = await readObsSecret(new KeyringSecretStore('bellis'), OBS_SECRET);
  const obs = await ObsClient.connect(secret.url, secret.password);
  const result: Record<string, unknown> = { config: values.config, log: logPath };
  let original: { scene: string; muted: boolean; url: unknown } | undefined;
  let session: Session | undefined;
  try {
    if (ok(await obs.request('GetStreamStatus')).outputActive)
      throw new Error('推流进行中，拒绝运行');
    original = {
      scene: ok(await obs.request('GetCurrentProgramScene')).currentProgramSceneName as string,
      muted: ok(await obs.request('GetInputMute', { inputName: stageSource }))
        .inputMuted as boolean,
      url: (
        ok(await obs.request('GetInputSettings', { inputName: stageSource }))
          .inputSettings as Record<string, unknown>
      ).url,
    };

    const launchedAt = Date.now();
    session = await launch({
      configPath,
      secretService: 'bellis',
      host: { command: process.execPath, args: [hostMain] },
      watchdog: { command: process.execPath, args: [watchdogMain] },
      stdout: 'pipe',
    });
    const host = new Lines(session.host.stdout, (line) => log.write(`host ${line}\n`));
    new Lines(session.watchdog.stdout, (line) => log.write(`watchdog ${line}\n`));
    const key = decodeSessionKey(session.info.channelKey);
    const operator = new RpcPeer(await connect(session.info.channelPath, Role.Operator, { key }), {
      timeoutMs: 10_000,
    });
    const call = (method: string, params: Record<string, unknown> = {}) =>
      operator.request(method, params) as Promise<Record<string, unknown>>;

    const ready = await host.wait((l) => l.event === 'host.ready', 60_000);
    const status = await call(OperatorMethod.Status);
    const plugins = status.plugins as Array<{ id: string; plugin: string; state: string }>;
    const has = (plugin: string) => plugins.some((p) => p.plugin === plugin);
    const since = (line: LogLine) => Date.parse(line.t) - launchedAt;
    const timings: Record<string, number> = { hostReady: since(ready) };
    timings.stageAuthenticated = since(
      await host.wait((l) => l.event === 'stage-page.authenticated', 60_000),
    );
    if (has('avatar-vts'))
      timings.avatarAuthenticated = since(
        await host.wait((l) => l.event === 'avatar.authenticated', 60_000),
      );
    if (has('tts-local'))
      timings.localTtsReady = since(
        await host.wait((l) => l.event === 'fact' && l.type === 'tts.started', 180_000),
      );
    result.timings = timings;
    result.plugins = plugins.map((p) => `${p.id}:${p.state}`);
    say(`就绪：${JSON.stringify(timings)}`);

    await call(OperatorMethod.Presence);
    const preflight: Record<string, unknown> = {};
    for (const target of ['M1', 'M2']) {
      preflight[target] = (await call(OperatorMethod.Preflight, { target })).failures;
    }
    result.preflight = preflight;
    result.mode = (await call(OperatorMethod.Status)).mode;
    say(`预检：${JSON.stringify(preflight)}`);

    result.auditDuringSession = audit();
    say(`会话中核对：${JSON.stringify(result.auditDuringSession)}`);
    operator.connection.close();
    const stopped = await session.stop();
    session = undefined;
    result.stopped = { host: stopped.host.stage, watchdog: stopped.watchdog.stage };
  } finally {
    await session?.stop().catch(() => undefined);
    await new Promise<void>((done) => log.end(done));
    if (original) {
      await obs.request('SetInputSettings', {
        inputName: stageSource,
        inputSettings: { url: original.url ?? '' },
        overlay: true,
      });
      await obs.request('SetCurrentProgramScene', { sceneName: original.scene });
      await obs.request('SetInputMute', { inputName: stageSource, inputMuted: original.muted });
    }
    obs.close();
  }
  result.auditAfterStop = audit();
  say(`停止后核对：${JSON.stringify(result.auditAfterStop)}`);
  const out = resolve(
    values.out ?? join(root, 'reports', `drill-rehearsal-${started.slice(0, 10)}.json`),
  );
  writeFileSync(
    out,
    `${JSON.stringify({ drill: 'rehearsal', started, finished: new Date().toISOString(), node: process.version, ...result }, null, 2)}\n`,
  );
  say(`结果已写入 ${out}`);
}

await main();
