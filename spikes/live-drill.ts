/**
 * P2 真机演练（drill-p2-latency、drill-p2-restart、drill-p2-console）共用的部分：
 * - 读维护者的真实配置（`config/live.json` 与它的 profile、patch），生成演练的临时 patch 与配置：配置原样，只把
 *   状态存储换到系统临时目录（演练的事实与内容不进直播用的事件日志，结束时删除），patch 列表末尾加上演练的 patch；
 * - 像 `pnpm start` 一样用正式的 SecretStore 服务名 bellis 拉起宿主与看门狗，操作员连接、开播预检与进入 M1 或 M2；
 * - 只读打开状态存储（宿主运行中也能读）；
 * - OBS 的盘点、推流检查、恢复与读回核对（见 obs-snapshot.ts）。
 * 报告只写编号、类型、计数与时延：这里给出的辅助都不读、不打印凭据的值，宿主日志（含发言内容）不落盘。
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { connect, decodeSessionKey, RpcPeer } from '@bellis/channel';
import { loadConfig, OBS_SECRET, readObsSecret } from '@bellis/config';
import { type ResolvedEntry, readJsonFile, resolveProfile, secretPermission } from '@bellis/kernel';
import { launch, type Session } from '@bellis/launcher';
import { ObsClient, type ObsResult } from '@bellis/obs';
import {
  type HostConfig,
  OperatorMethod,
  type PatchOp,
  type ProfileEntry,
  ProfilePatch,
  Role,
} from '@bellis/protocol';
import { KeyringSecretStore, SESSION_SECRET } from '@bellis/secret-store';
import { percentile } from '@bellis/telemetry';
import { Compile } from 'typebox/compile';
import { differences, type ObsSnapshot, restoreSnapshot, snapshot } from './obs-snapshot.ts';

const file = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
export const root = file('../');
const hostMain = file('../packages/host/src/main.ts');
const watchdogMain = file('../packages/watchdog/src/main.ts');
const isPatch = Compile(ProfilePatch);

/** 正式的 SecretStore 服务名：与 `pnpm start` 相同。 */
export const SECRET_SERVICE = 'bellis';

export const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
export const say = (message: string) => console.log(`${new Date().toISOString()} ${message}`);

export function ok(result: ObsResult): Record<string, unknown> {
  if (!result.ok)
    throw new Error(`${result.requestType} 失败：${result.code} ${result.comment ?? ''}`);
  return result.data ?? {};
}

/** 毫秒样本的样本数与 p50/p95/p99/max（最近秩法，与 `pnpm telemetry summary` 相同；失败样本不剔除）。 */
export function summarize(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const round = (value: number | undefined) =>
    value === undefined ? null : Number.isFinite(value) ? Math.round(value * 10) / 10 : 'inf';
  return {
    n: sorted.length,
    p50: round(percentile(sorted, 0.5)),
    p95: round(percentile(sorted, 0.95)),
    p99: round(percentile(sorted, 0.99)),
    max: round(sorted.at(-1)),
  };
}

export type LogLine = { t: string; event: string; [field: string]: unknown };

/** 逐行收集 JSON 日志，按位置等待某一行出现。只留在内存里，不落盘（宿主日志里有发言的内容）。 */
export class Lines {
  readonly items: LogLine[] = [];
  readonly #waiters = new Set<() => void>();

  constructor(stream: Readable | null) {
    if (!stream) throw new Error('没有可读的输出');
    createInterface({ input: stream }).on('line', (line) => {
      try {
        this.items.push(JSON.parse(line) as LogLine);
      } catch {
        return;
      }
      for (const wake of this.#waiters) wake();
    });
  }

  find(match: (line: LogLine) => boolean, from = 0): LogLine | undefined {
    return this.items.slice(from).find(match);
  }

  async wait(
    match: (line: LogLine) => boolean,
    timeoutMs: number,
    from = 0,
    what = '日志',
  ): Promise<LogLine> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.find(match, from);
      if (found) return found;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`等待${what}超时（${Math.round(timeoutMs / 1000)} 秒）`);
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

export const isFact = (type: string) => (line: LogLine) =>
  line.event === 'fact' && line.type === type;

/** 维护者的真实配置：配置文件、配置本身，以及按它的 patch 展开后的 profile 条目。 */
export interface LiveConfig {
  path: string;
  config: HostConfig;
  entries: ResolvedEntry[];
}

/** 读维护者的真实配置；缺文件、是仿真配置或 profile 不合法时给出怎么补的说明。 */
export function readLiveConfig(arg: string): LiveConfig {
  const path = resolve(root, arg);
  if (!existsSync(path))
    throw new Error(
      `找不到配置文件 ${arg}：从 config/live.example.json 复制一份并按本机填写（不入库），见运维“真实配置的样例”`,
    );
  const config = loadConfig(path);
  if (config.simulation)
    throw new Error(
      `${arg} 是仿真配置（simulation 为 true）：这个演练要用真实配置，例如 config/live.json`,
    );
  if (!existsSync(config.profile))
    throw new Error(
      `找不到 profile ${config.profile}：从 config/profiles/live.example.json 复制一份（不入库）`,
    );
  for (const patch of config.patches) {
    if (!existsSync(patch)) throw new Error(`找不到配置里列出的 patch ${patch}`);
  }
  const entries = resolveProfile(readJsonFile(config.profile), config.patches.map(readJsonFile));
  if (!entries.find((entry) => entry.id === 'moderation')?.explicitSwitch)
    throw new Error('profile 中必须显式设置审核插件（moderation）的启用或关闭（D-18）');
  return { path, config, entries };
}

/** profile 里用某个插件的条目。 */
export function entryOf(live: LiveConfig, plugin: string): ResolvedEntry | undefined {
  return live.entries.find((entry) => entry.plugin === plugin);
}

/** 把展开后的条目写回 profile 条目（patch 的 replace 用），可以覆盖其中的字段。 */
export function profileEntry(
  entry: ResolvedEntry,
  overrides: Partial<ProfileEntry> = {},
): ProfileEntry {
  return {
    id: entry.id,
    plugin: entry.plugin,
    config: entry.config,
    grant: [...entry.grant],
    disabled: entry.disabled,
    ...overrides,
  };
}

/**
 * 演练的临时目录（系统临时目录下）：状态存储、演练的 patch 与配置都在这里，结束时整体删除。
 * 状态存储里有发言、弹幕与记忆的内容，不放进 reports/。
 */
export class DrillDir {
  readonly dir: string;

  constructor(name: string) {
    this.dir = mkdtempSync(join(tmpdir(), `bellis-${name}-`));
  }

  /**
   * 写演练的 patch 与引用它的配置，返回配置文件的路径：维护者的配置原样，状态存储换成 storePath，patch 列表末尾
   * 加上这个 patch。顺带核对展开后启用的条目用到的凭据都已录入（只看名字，不读值）。
   */
  async writeConfig(
    live: LiveConfig,
    name: string,
    ops: PatchOp[],
    storePath: string,
  ): Promise<string> {
    const patch = { name: `drill-${name}`.slice(0, 48), ops };
    if (!isPatch.Check(patch)) {
      const first = [...isPatch.Errors(patch)][0];
      throw new Error(
        `演练生成的 patch 不合法：${first?.instancePath ?? ''} ${first?.message ?? ''}`,
      );
    }
    const entries = resolveProfile(readJsonFile(live.config.profile), [
      ...live.config.patches.map(readJsonFile),
      patch,
    ]);
    await requireSecrets(entries);
    const patchPath = join(this.dir, `${name}.patch.json`);
    writeFileSync(patchPath, `${JSON.stringify(patch, null, 2)}\n`);
    const configPath = join(this.dir, `${name}.config.json`);
    const config: HostConfig = {
      ...live.config,
      storePath,
      patches: [...live.config.patches, patchPath],
    };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    return configPath;
  }

  remove(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/** 启用的条目被授予的凭据（`secret:<名字>`）与 OBS 凭据都要已录入；只看名字，不读值。 */
async function requireSecrets(entries: readonly ResolvedEntry[]): Promise<void> {
  const names = new Set(await new KeyringSecretStore(SECRET_SERVICE).names());
  const needed = new Map<string, string>([[OBS_SECRET, 'OBS 应急连接']]);
  for (const entry of entries) {
    if (entry.disabled) continue;
    for (const grant of entry.grant) {
      const name = grant.startsWith('secret:') ? grant.slice('secret:'.length) : undefined;
      if (name && grant === secretPermission(name)) needed.set(name, `条目 ${entry.id}`);
    }
  }
  const missing = [...needed].filter(([name]) => !names.has(name));
  if (missing.length > 0)
    throw new Error(
      `SecretStore（${SECRET_SERVICE}）里缺凭据：${missing
        .map(([name, user]) => `${name}（${user}用）`)
        .join('、')}。由维护者用 pnpm secret set <名字> 录入`,
    );
}

/** 读取凭据并连上真实 OBS；缺凭据或连不上时给出清楚的报错（不打印凭据与地址）。 */
export async function connectObs(eventSubscriptions = 0): Promise<ObsClient> {
  let secret: Awaited<ReturnType<typeof readObsSecret>>;
  try {
    secret = await readObsSecret(new KeyringSecretStore(SECRET_SERVICE), OBS_SECRET);
  } catch (error) {
    throw new Error(
      `读不到 OBS 凭据（${(error as Error).message}）。这个演练需要真实 OBS，先用 pnpm secret set obs 录入 obs-websocket 的地址与密码`,
    );
  }
  try {
    return await ObsClient.connect(secret.url, secret.password, {
      timeoutMs: 3000,
      eventSubscriptions,
    });
  } catch (error) {
    throw new Error(
      `连不上 OBS（${(error as Error).message}）。这个演练需要真实 OBS：先启动 OBS、开启 obs-websocket，并核对 pnpm secret set obs 录入的地址与密码`,
    );
  }
}

/** OBS 的现场与名字。 */
export interface ObsScene {
  obs: ObsClient;
  stageSource: string;
  safeScene: string;
  /** 开始时的节目场景：每次进入 M2 前切回它。 */
  liveScene: string;
  original: ObsSnapshot;
  version: unknown;
}

/** 推流进行中拒绝运行；盘点 OBS，核对安全场景与 Stage 源都在、节目场景不是安全场景。 */
export async function inspectObs(live: LiveConfig, obs: ObsClient): Promise<ObsScene> {
  const { stageSource, safeScene } = live.config.safety.emergency;
  if (ok(await obs.request('GetStreamStatus')).outputActive)
    throw new Error('推流进行中，拒绝运行');
  const version = ok(await obs.request('GetVersion')).obsVersion;
  const original = await snapshot(obs, stageSource, safeScene);
  if (!original.scenes.includes(safeScene)) throw new Error(`OBS 中没有安全场景「${safeScene}」`);
  if (!original.inputs.includes(stageSource))
    throw new Error(`OBS 中没有 Stage 源「${stageSource}」`);
  if (original.programScene === safeScene)
    throw new Error('节目场景已经是安全场景：先切回直播场景再运行，演练结束后会切回它');
  return { obs, stageSource, safeScene, liveScene: original.programScene, original, version };
}

/**
 * 把 Stage 源的设置（含 URL）、节目场景与静音写回开始时的样子并读回比对。连不上 OBS 时把原状态打印出来，
 * 由操作员手动恢复。
 */
export async function restoreObs(scene: ObsScene) {
  const { original, stageSource, safeScene } = scene;
  let client: ObsClient | undefined = scene.obs;
  let fresh = false;
  try {
    ok(await client.request('GetVersion'));
  } catch {
    client = await connectObs().catch(() => undefined);
    fresh = client !== undefined;
  }
  const manual = {
    programScene: original.programScene,
    stageSource,
    stageMuted: original.stageMuted,
  };
  if (!client) {
    say(
      `连不上 OBS，没能恢复现场。请在 OBS 里手动恢复：节目场景切回「${original.programScene}」，Stage 源「${stageSource}」${original.stageMuted ? '保持静音' : '取消静音'}。Stage 源的 URL 由下次启动的宿主重新下发。`,
    );
    return { ok: false, manual };
  }
  try {
    const steps = await restoreSnapshot(client, original, stageSource);
    const diffs = differences(original, await snapshot(client, stageSource, safeScene));
    const restored = { ok: steps.length === 0 && diffs.length === 0, steps, diffs };
    say(`OBS 恢复：${JSON.stringify(restored)}`);
    return restored;
  } catch (error) {
    say(
      `恢复现场时 OBS 出错（${(error as Error).message}）。请在 OBS 里核对：节目场景应为「${original.programScene}」，Stage 源「${stageSource}」${original.stageMuted ? '静音' : '未静音'}`,
    );
    return { ok: false, error: (error as Error).message, manual };
  } finally {
    if (fresh) client.close();
  }
}

/** 一次会话：真实的宿主与看门狗，加一个操作员连接。 */
export class LiveHost {
  readonly session: Session;
  readonly host: Lines;
  readonly watchdog: Lines;
  readonly #operator: RpcPeer;

  private constructor(session: Session, operator: RpcPeer) {
    this.session = session;
    this.#operator = operator;
    this.host = new Lines(session.host.stdout);
    this.watchdog = new Lines(session.watchdog.stdout);
  }

  /**
   * 拉起宿主与看门狗。`preload` 是给宿主进程预加载的模块（`node --import`，演练的故障注入用）。
   * 宿主在就绪前退出时提示用 `pnpm start` 看它的日志。
   */
  static async start(configPath: string, preload?: string): Promise<LiveHost> {
    let session: Session;
    try {
      session = await launch({
        configPath,
        secretService: SECRET_SERVICE,
        host: {
          command: process.execPath,
          args: [...(preload ? ['--import', preload] : []), hostMain],
        },
        watchdog: { command: process.execPath, args: [watchdogMain] },
        stdout: 'pipe',
        readyTimeoutMs: 30_000,
      });
    } catch (error) {
      throw new Error(
        `拉不起宿主与看门狗（${(error as Error).message}）。用 pnpm start 加同一份配置运行一次，看宿主日志里的原因`,
      );
    }
    const key = decodeSessionKey(session.info.channelKey);
    // 切换模式与只跑预检的应答至多 30 秒（预检可能含决策模型的探测）。
    const operator = new RpcPeer(await connect(session.info.channelPath, Role.Operator, { key }), {
      timeoutMs: 40_000,
    });
    return new LiveHost(session, operator);
  }

  call(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return this.#operator.request(method, params) as Promise<Record<string, unknown>>;
  }

  /** 等宿主加载完插件、Stage 认证、看门狗连上 OBS。 */
  async ready(timeoutMs = 240_000): Promise<void> {
    await this.host.wait((l) => l.event === 'host.ready', timeoutMs, 0, '宿主加载完插件');
    await this.host.wait(
      (l) => l.event === 'stage-page.authenticated',
      60_000,
      0,
      'Stage 页面认证（检查 OBS 里 Stage 浏览器源是否可见、URL 是否被改写）',
    );
    await this.watchdog.wait(
      (l) => l.event === 'watchdog.obs-connected',
      30_000,
      0,
      '看门狗连上 OBS',
    );
  }

  /**
   * 像操作员一样回到可以开播的状态并进入输出模式（M1 或 M2）：还在输出模式时先急停，切回直播场景、取消静音、
   * 确认在场（M2 的前提，M1 不要求），等这个模式的开播预检通过（本地 TTS 等可能还在加载），再切过去；超时仍未
   * 通过时抛错，带上未通过的项。
   */
  async enter(scene: ObsScene, target: 'M1' | 'M2', timeoutMs: number): Promise<void> {
    const status = await this.call(OperatorMethod.Status);
    if (status.mode !== 'safe-stop')
      await this.call(OperatorMethod.EmergencyStop, { reason: '演练：复位' });
    ok(await scene.obs.request('SetCurrentProgramScene', { sceneName: scene.liveScene }));
    ok(
      await scene.obs.request('SetInputMute', { inputName: scene.stageSource, inputMuted: false }),
    );
    await this.call(OperatorMethod.Presence);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const failures = (await this.call(OperatorMethod.Preflight, { target })).failures as string[];
      if (failures.length === 0) break;
      if (Date.now() > deadline)
        throw new Error(
          `开播预检未通过（等了 ${Math.round(timeoutMs / 1000)} 秒）：${failures.join('；')}`,
        );
      await sleep(1000);
    }
    const result = await this.call(OperatorMethod.Mode, { target });
    if (result.ok !== true) throw new Error(`进入 ${target} 失败：${JSON.stringify(result)}`);
  }

  /** 进入 M2（见 {@link enter}）。 */
  enterM2(scene: ObsScene, timeoutMs: number): Promise<void> {
    return this.enter(scene, 'M2', timeoutMs);
  }

  /** 强制结束宿主进程（Windows 上是 TerminateProcess），不经停止协议；看门狗随后接管 OBS。 */
  kill(): void {
    process.kill(this.session.host.pid);
  }

  /** 停止会话（宿主已退出时只停看门狗），删除会话连接信息。 */
  async stop(): Promise<void> {
    this.#operator.connection.close();
    await this.session.stop().catch(() => undefined);
    await new KeyringSecretStore(SECRET_SERVICE).delete(SESSION_SECRET).catch(() => false);
  }
}

/** 状态存储里的一条事实。 */
export interface StoreEvent {
  seq: number;
  type: string;
  recordedAt: number;
  data: Record<string, unknown>;
}

export interface StoreIntent {
  id: number;
  key: string;
  type: string;
  target: string;
  state: string;
  timeSensitive: boolean;
}

/** 只读打开状态存储（宿主运行中也能读：WAL 下读不阻塞写）。宿主建好数据库之后才能打开。 */
export class StoreReader {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    this.#db = new DatabaseSync(path, { readOnly: true });
  }

  events(afterSeq = 0): StoreEvent[] {
    return this.#db
      .prepare('SELECT seq, type, recorded_at, data FROM events WHERE seq > ? ORDER BY seq')
      .all(afterSeq)
      .map((row) => ({
        seq: Number(row.seq),
        type: String(row.type),
        recordedAt: Number(row.recorded_at),
        data: JSON.parse(String(row.data)) as Record<string, unknown>,
      }));
  }

  intents(): StoreIntent[] {
    return this.#db
      .prepare('SELECT id, key, type, target, state, time_sensitive FROM intents ORDER BY id')
      .all()
      .map((row) => ({
        id: Number(row.id),
        key: String(row.key),
        type: String(row.type),
        target: String(row.target),
        state: String(row.state),
        timeSensitive: Number(row.time_sensitive) === 1,
      }));
  }

  /** 最新的事件序号。 */
  lastSeq(): number {
    const row = this.#db.prepare('SELECT MAX(seq) AS seq FROM events').get();
    return Number(row?.seq ?? 0);
  }

  close(): void {
    this.#db.close();
  }
}

/** 等状态存储里出现满足条件的事实，返回它；超时抛错。 */
export async function waitForEvent(
  store: StoreReader,
  match: (event: StoreEvent) => boolean,
  afterSeq: number,
  timeoutMs: number,
  what: string,
): Promise<StoreEvent> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = store.events(afterSeq).find(match);
    if (found) return found;
    if (Date.now() > deadline)
      throw new Error(`等${what}超时（${Math.round(timeoutMs / 1000)} 秒）`);
    await sleep(50);
  }
}

/** 整数参数：不是不小于 min 的整数时抛错。 */
export function checkIntArg(name: string, value: string | undefined, min: number): number {
  const n = Number(value);
  if (!(Number.isInteger(n) && n >= min)) throw new Error(`${name} 须为不小于 ${min} 的整数`);
  return n;
}
