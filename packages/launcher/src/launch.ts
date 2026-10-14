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
import { ChildEnv, ProcessShutdown, Role, type SessionInfo } from '@bellis/protocol';
import { SESSION_SECRET, type SecretStore, writeSessionInfo } from '@bellis/secret-store';

export interface CommandSpec {
  command: string;
  args: readonly string[];
}

export interface LaunchOptions {
  /** 写入本次会话连接信息的 SecretStore。 */
  store: SecretStore;
  /** 看门狗用来打开同一个 SecretStore 的服务名。 */
  secretService: string;
  host: CommandSpec;
  watchdog: CommandSpec;
  stdout?: 'inherit' | 'pipe';
  /** 等待宿主可连接的上限，默认 10 秒。 */
  readyTimeoutMs?: number;
}

const RPC_TIMEOUT_MS = 2000;

/** 一次运行中的会话：宿主与看门狗是启动器的两个独立子进程，看门狗不是宿主的子进程（R-23）。 */
export class Session {
  readonly info: SessionInfo;
  readonly host: ManagedProcess;
  readonly watchdog: ManagedProcess;
  readonly #hostRpc: RpcPeer;
  readonly #store: SecretStore;

  constructor(
    info: SessionInfo,
    host: ManagedProcess,
    watchdog: ManagedProcess,
    hostRpc: RpcPeer,
    store: SecretStore,
  ) {
    this.info = info;
    this.host = host;
    this.watchdog = watchdog;
    this.#hostRpc = hostRpc;
    this.#store = store;
  }

  /** 先停宿主（RPC → stdin → 强制终止），再停看门狗，最后删除会话连接信息。 */
  async stop(): Promise<{ host: StopResult; watchdog: StopResult }> {
    const host = await this.host.stop({
      shutdown: () => this.#hostRpc.request(ProcessShutdown, { reason: 'launcher' }),
    });
    const watchdog = await this.watchdog.stop();
    await this.#store.delete(SESSION_SECRET);
    return { host, watchdog };
  }
}

/** 生成会话连接信息并写入 SecretStore，依次拉起看门狗与宿主，等宿主可连接后返回。 */
export async function launch(options: LaunchOptions): Promise<Session> {
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
  await writeSessionInfo(options.store, info);

  const started: ManagedProcess[] = [];
  try {
    const watchdog = await ManagedProcess.start({
      name: 'watchdog',
      ...options.watchdog,
      env: {
        ...baseEnvironment(),
        [ChildEnv.SessionId]: sessionId,
        [ChildEnv.SecretService]: options.secretService,
      },
      stdout: options.stdout ?? 'inherit',
    });
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
    const hostRpc = await connectWhenReady(info, key, host, options.readyTimeoutMs ?? 10_000);
    return new Session(info, host, watchdog, hostRpc, options.store);
  } catch (error) {
    for (const child of started.reverse()) await child.stop();
    await options.store.delete(SESSION_SECRET);
    throw error;
  }
}

async function connectWhenReady(
  info: SessionInfo,
  key: Uint8Array,
  host: ManagedProcess,
  timeoutMs: number,
): Promise<RpcPeer> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const connection = await connect(info.channelPath, Role.Launcher, { key });
      return new RpcPeer(connection, { timeoutMs: RPC_TIMEOUT_MS });
    } catch (error) {
      if ((error as ChannelError).code !== 'connect-failed') throw error;
      if (host.status) throw new Error(`宿主在就绪前退出：${JSON.stringify(host.status)}`);
      if (Date.now() > deadline) throw new Error(`宿主未在 ${timeoutMs}ms 内就绪`);
    }
    await sleep(50);
  }
}
