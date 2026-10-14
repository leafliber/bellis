import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  type ChannelError,
  connect,
  createChannelPath,
  createSessionKey,
  encodeSessionKey,
  RpcPeer,
} from '@bellis/channel';
import { baseEnvironment, ManagedProcess, type StopResult } from '@bellis/process';
import {
  ChildEnv,
  HostStatus,
  HostStatusResult,
  ProcessShutdown,
  Role,
  type SessionInfo,
} from '@bellis/protocol';
import { KeyringSecretStore, SESSION_SECRET, writeSessionInfo } from '@bellis/secret-store';
import { Compile } from 'typebox/compile';

export interface CommandSpec {
  command: string;
  args: readonly string[];
}

export interface LaunchOptions {
  /** 系统凭据库中的服务名。启动器与看门狗打开同一个凭据库，保证看门狗读得到会话信息。 */
  secretService: string;
  host: CommandSpec;
  watchdog: CommandSpec;
  stdout?: 'inherit' | 'pipe';
  /** 等待宿主可连接、看门狗连上宿主的上限，默认 10 秒。 */
  readyTimeoutMs?: number;
  /** 看门狗意外退出后最多重启几次，默认 5 次。 */
  maxWatchdogRestarts?: number;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}

const RPC_TIMEOUT_MS = 2000;
const POLL_MS = 50;
const WATCHDOG_RESTART_DELAY_MS = 500;
const isHostStatus = Compile(HostStatusResult);

/**
 * 一次运行中的会话：宿主与看门狗是启动器的两个独立子进程，看门狗不是宿主的子进程（R-23）。
 * 看门狗意外退出时启动器重启它，宿主不能长时间无人兜底。
 */
export class Session {
  readonly info: SessionInfo;
  readonly host: ManagedProcess;
  readonly #hostRpc: RpcPeer;
  readonly #options: LaunchOptions;
  readonly #store: KeyringSecretStore;
  #watchdog: ManagedProcess;
  #restarts = 0;
  #stopping = false;

  constructor(
    info: SessionInfo,
    host: ManagedProcess,
    watchdog: ManagedProcess,
    hostRpc: RpcPeer,
    options: LaunchOptions,
  ) {
    this.info = info;
    this.host = host;
    this.#watchdog = watchdog;
    this.#hostRpc = hostRpc;
    this.#options = options;
    this.#store = new KeyringSecretStore(options.secretService);
    this.#supervise(watchdog);
  }

  /** 当前的看门狗进程（重启后会变）。 */
  get watchdog(): ManagedProcess {
    return this.#watchdog;
  }

  /** 先停宿主（RPC → stdin → 强制终止），再停看门狗，最后删除会话连接信息。 */
  async stop(): Promise<{ host: StopResult; watchdog: StopResult }> {
    this.#stopping = true;
    const host = await this.host.stop({
      shutdown: () => this.#hostRpc.request(ProcessShutdown, { reason: 'launcher' }),
    });
    const watchdog = await this.#watchdog.stop();
    await this.#store.delete(SESSION_SECRET);
    return { host, watchdog };
  }

  #supervise(watchdog: ManagedProcess): void {
    void watchdog.exited.then(async (status) => {
      if (this.#stopping) return;
      const log = this.#options.log ?? (() => {});
      const limit = this.#options.maxWatchdogRestarts ?? 5;
      if (this.#restarts >= limit) {
        log('launcher.watchdog-gave-up', { ...status, restarts: this.#restarts });
        return;
      }
      this.#restarts += 1;
      log('launcher.watchdog-exited', { ...status, restart: this.#restarts });
      await sleep(WATCHDOG_RESTART_DELAY_MS);
      if (this.#stopping) return;
      this.#watchdog = await startWatchdog(this.info, this.#options);
      this.#supervise(this.#watchdog);
    });
  }
}

/**
 * 生成会话连接信息并写入系统凭据库，依次拉起看门狗与宿主；
 * 等宿主可连接、且看门狗已连上宿主后才返回。
 */
export async function launch(options: LaunchOptions): Promise<Session> {
  const store = new KeyringSecretStore(options.secretService);
  const sessionId = randomBytes(4).toString('hex');
  const key = createSessionKey();
  const info: SessionInfo = {
    v: 1,
    sessionId,
    channelPath: createChannelPath(sessionId),
    channelKey: encodeSessionKey(key),
    launcherPid: process.pid,
    startedAt: new Date().toISOString(),
  };
  await writeSessionInfo(store, info);

  const started: ManagedProcess[] = [];
  try {
    const watchdog = await startWatchdog(info, options);
    started.push(watchdog);
    const host = await ManagedProcess.start({
      name: 'host',
      ...options.host,
      env: {
        ...baseEnvironment(),
        [ChildEnv.SessionId]: sessionId,
        [ChildEnv.ChannelPath]: info.channelPath,
        [ChildEnv.ChannelKey]: info.channelKey,
      },
      stdout: options.stdout ?? 'inherit',
    });
    started.push(host);
    const deadline = Date.now() + (options.readyTimeoutMs ?? 10_000);
    const hostRpc = await connectWhenReady(info, key, host, deadline);
    await waitForWatchdog(hostRpc, watchdog, deadline);
    return new Session(info, host, watchdog, hostRpc, options);
  } catch (error) {
    for (const child of started.reverse()) await child.stop();
    await store.delete(SESSION_SECRET);
    throw error;
  }
}

function startWatchdog(info: SessionInfo, options: LaunchOptions): Promise<ManagedProcess> {
  return ManagedProcess.start({
    name: 'watchdog',
    ...options.watchdog,
    env: {
      ...baseEnvironment(),
      [ChildEnv.SessionId]: info.sessionId,
      [ChildEnv.SecretService]: options.secretService,
    },
    stdout: options.stdout ?? 'inherit',
  });
}

async function connectWhenReady(
  info: SessionInfo,
  key: Uint8Array,
  host: ManagedProcess,
  deadline: number,
): Promise<RpcPeer> {
  for (;;) {
    try {
      const connection = await connect(info.channelPath, Role.Launcher, { key });
      return new RpcPeer(connection, { timeoutMs: RPC_TIMEOUT_MS });
    } catch (error) {
      if ((error as ChannelError).code !== 'connect-failed') throw error;
      if (host.status) throw new Error(`宿主在就绪前退出：${JSON.stringify(host.status)}`);
      if (Date.now() > deadline) throw new Error('宿主未在时限内就绪');
    }
    await sleep(POLL_MS);
  }
}

async function waitForWatchdog(hostRpc: RpcPeer, watchdog: ManagedProcess, deadline: number) {
  for (;;) {
    const status = await hostRpc.request(HostStatus);
    if (isHostStatus.Check(status) && status.watchdogConnected) return;
    if (watchdog.status) throw new Error(`看门狗在就绪前退出：${JSON.stringify(watchdog.status)}`);
    if (Date.now() > deadline) throw new Error('看门狗未在时限内连上宿主');
    await sleep(POLL_MS);
  }
}
