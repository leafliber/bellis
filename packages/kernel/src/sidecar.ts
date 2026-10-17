import {
  type ChannelCredentials,
  type Connection,
  encodeSessionKey,
  type RequestOptions,
  RpcPeer,
} from '@bellis/channel';
import {
  baseEnvironment,
  connectToHost,
  handleShutdown,
  ManagedProcess,
  watchLifeline,
} from '@bellis/process';
import {
  ChildEnv,
  ProcessShutdown,
  type RpcParams,
  SIDECAR_PROTOCOL,
  SidecarDescribe,
  SidecarDescription,
  SidecarHealth,
  SidecarHealthResult,
} from '@bellis/protocol';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import type { Manifest, PluginContext, PluginDefinition } from './plugin.ts';
import { defineService, parseRef } from './service.ts';

/**
 * 宿主通道收到的连接按角色分发：sidecar 代理先登记要等待的角色，再启动子进程。
 * 没有人等待的角色直接断开。
 */
export class ChannelHub {
  readonly #waiting = new Map<string, PromiseWithResolvers<Connection>>();

  accept(connection: Connection): boolean {
    const waiter = this.#waiting.get(connection.role);
    if (!waiter) {
      connection.destroy();
      return false;
    }
    this.#waiting.delete(connection.role);
    waiter.resolve(connection);
    return true;
  }

  expect(role: string): { connection: Promise<Connection>; cancel(): void } {
    if (this.#waiting.has(role)) throw new Error(`已在等待角色 ${role}`);
    const waiter = Promise.withResolvers<Connection>();
    waiter.promise.catch(() => {});
    this.#waiting.set(role, waiter);
    return {
      connection: waiter.promise,
      cancel: () => {
        if (this.#waiting.get(role) !== waiter) return;
        this.#waiting.delete(role);
        waiter.reject(new Error(`不再等待角色 ${role}`));
      },
    };
  }
}

/** 宿主提供给 sidecar 代理的基础服务：本次会话的通道地址与密钥，以及连接分发。 */
export interface SidecarHost {
  readonly credentials: ChannelCredentials;
  readonly hub: ChannelHub;
}

export const SidecarHostService = defineService<SidecarHost>('sidecar-host', 1);

/** sidecar 提供的服务在宿主内的形态：经 RPC 转发的客户端。sidecar 只返回数据，不直接驱动设备。 */
export interface SidecarService {
  request(method: string, params?: RpcParams, options?: RequestOptions): Promise<unknown>;
}

/** 怎样拉起一个 sidecar 子进程。环境变量只有系统必需的与这里显式给出的，外加宿主分配的连接信息。 */
export interface SidecarLaunch {
  command: string;
  args: readonly string[];
  env?: Record<string, string>;
  cwd?: string;
  /** 握手与普通请求的截止时间，默认 2000ms。 */
  rpcTimeoutMs?: number;
}

export interface SidecarSpec extends SidecarLaunch {
  manifest: Omit<Manifest, 'process' | 'config'>;
}

/** 已完成握手的 sidecar。 */
export interface RunningSidecar {
  readonly rpc: RpcPeer;
  /** 宿主的直接子进程的 pid。 */
  readonly pid: number;
}

const isDescription = Compile(SidecarDescription);
const isHealth = Compile(SidecarHealthResult);

/** 两个列表含有相同的元素，且各自没有重复。 */
function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return (
    left.size === a.length &&
    right.size === b.length &&
    left.size === right.size &&
    a.every((item) => right.has(item))
  );
}

/**
 * 在插件激活期间拉起 sidecar 并完成握手，返回 RPC 对端。子进程由一个可撤销注册持有。
 * 启动子进程 → 等它以分配的角色 `sidecar.<条目 id>` 连上 → 握手（协议版本、提供的服务须与 `provides`
 * 一致、申请的权限须已授予）→ 健康检查。调用方插件须在 inject 中声明 `SidecarHostService`。
 * 握手完成后子进程退出或连接断开时，先调用 `onLost`，再经 `ctx.fail` 报告失败：内核撤回该插件的服务，
 * 依赖方回到 WAITING，并按退避重启。
 * 停止：RPC shutdown → 关闭 stdin → 超时强制终止（R-06）；收尾超时时直接终止。停在哪一步记入日志。
 */
export async function startSidecar(
  ctx: PluginContext,
  provides: readonly string[],
  launch: SidecarLaunch,
  onLost?: (reason: string) => void,
): Promise<RunningSidecar> {
  const host = ctx.service(SidecarHostService);
  const role = `sidecar.${ctx.entryId}`;
  const pending = host.hub.expect(role);
  let child: ManagedProcess;
  try {
    child = await ManagedProcess.start({
      name: role,
      command: launch.command,
      args: launch.args,
      ...(launch.cwd === undefined ? {} : { cwd: launch.cwd }),
      env: {
        ...baseEnvironment(),
        ...launch.env,
        [ChildEnv.ChannelPath]: host.credentials.path,
        [ChildEnv.ChannelKey]: encodeSessionKey(host.credentials.key),
        [ChildEnv.Role]: role,
      },
    });
  } catch (error) {
    pending.cancel();
    throw error;
  }

  let rpc: RpcPeer | undefined;
  ctx.register(async () => {
    pending.cancel();
    const peer = rpc;
    if (ctx.forced) {
      child.kill();
      const status = await child.exited;
      ctx.log('sidecar.stopped', { pid: child.pid, stage: 'killed', code: status.code });
    } else {
      const result = await child.stop(
        peer ? { shutdown: () => peer.request(ProcessShutdown, { reason: 'unload' }) } : {},
      );
      ctx.log('sidecar.stopped', { pid: child.pid, stage: result.stage, code: result.code });
    }
    peer?.connection.destroy();
  });

  const exitedEarly = child.exited.then((status) => {
    throw new Error(`sidecar 在握手完成前退出：code=${status.code} signal=${status.signal}`);
  });
  const connection = await Promise.race([pending.connection, exitedEarly]);
  const peer = new RpcPeer(connection, { timeoutMs: launch.rpcTimeoutMs ?? 2000 });
  rpc = peer;

  const description = await peer.request(SidecarDescribe);
  if (!isDescription.Check(description)) throw new Error('sidecar 的描述不合法');
  if (description.protocol !== SIDECAR_PROTOCOL) throw new Error('sidecar 协议版本不兼容');
  if (!sameSet(description.provides, provides)) {
    throw new Error(
      `sidecar 提供的服务 ${description.provides.join(',')} 与清单 ${provides.join(',')} 不一致`,
    );
  }
  const ungranted = description.permissions.filter((p) => !ctx.permissions.has(p));
  if (ungranted.length > 0) throw new Error(`sidecar 申请了未授予的权限 ${ungranted.join(',')}`);

  const health = await peer.request(SidecarHealth);
  if (!isHealth.Check(health) || !health.ok) {
    throw new Error(`sidecar 健康检查未通过：${JSON.stringify(health)}`);
  }

  let reported = false;
  const lost = (why: string) => {
    if (reported || ctx.signal.aborted) return;
    reported = true;
    onLost?.(why);
    ctx.fail(new Error(why));
  };
  void child.exited.then((s) => lost(`sidecar 进程退出：code=${s.code} signal=${s.signal}`));
  connection.once('close', () => lost('sidecar 连接断开'));
  return { rpc: peer, pid: child.pid };
}

/**
 * 通用的 sidecar 代理插件：sidecar 声明的每个服务在宿主内都是经 RPC 转发的客户端（`SidecarService`）。
 * 需要把 sidecar 的 RPC 适配成具体服务接口的（例如 `tts@1`），自己定义插件并调用 `startSidecar`。
 */
export function sidecarPlugin(spec: SidecarSpec): PluginDefinition {
  const manifest = {
    ...spec.manifest,
    inject: [...spec.manifest.inject, SidecarHostService.ref],
    process: 'sidecar' as const,
    config: Type.Object({}),
  };
  return {
    manifest,
    async activate(ctx) {
      const { rpc } = await startSidecar(ctx, manifest.provides, spec);
      const client: SidecarService = {
        request: (method, params, options) => rpc.request(method, params, options),
      };
      for (const ref of manifest.provides) {
        const { name, major } = parseRef(ref);
        ctx.provide(defineService<SidecarService>(name, major), client);
      }
    },
  };
}

export interface ServeSidecarOptions {
  provides: readonly string[];
  permissions?: readonly string[];
  health?: () => SidecarHealthResult | Promise<SidecarHealthResult>;
  /** 在握手之前注册业务方法。 */
  setup?: (rpc: RpcPeer) => void;
}

/**
 * sidecar 子进程一侧（Node 实现）：以代理分配的角色连接宿主，应答握手与健康检查。
 * 收到 shutdown、stdin 读到 EOF 或与宿主的连接断开时退出。
 */
export async function serveSidecar(options: ServeSidecarOptions): Promise<RpcPeer> {
  const role = process.env[ChildEnv.Role];
  if (!role) throw new Error(`缺少环境变量 ${ChildEnv.Role}`);
  const rpc = await connectToHost(role);
  const exit = () => process.exit(0);
  rpc.handle(SidecarDescribe, () => ({
    protocol: SIDECAR_PROTOCOL,
    provides: [...options.provides],
    permissions: [...(options.permissions ?? [])],
  }));
  rpc.handle(SidecarHealth, () => options.health?.() ?? { ok: true });
  options.setup?.(rpc);
  handleShutdown(rpc, exit);
  watchLifeline(exit);
  rpc.connection.once('close', exit);
  return rpc;
}
