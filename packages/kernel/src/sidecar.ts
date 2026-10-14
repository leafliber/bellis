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
import type { Manifest, PluginDefinition } from './plugin.ts';
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

export interface SidecarSpec {
  manifest: Omit<Manifest, 'process' | 'config'>;
  command: string;
  args: readonly string[];
  env?: Record<string, string>;
  rpcTimeoutMs?: number;
}

const isDescription = Compile(SidecarDescription);
const isHealth = Compile(SidecarHealthResult);

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item) => b.includes(item));
}

/**
 * sidecar 代理插件：用一个可撤销注册持有整个子进程。
 * 启动子进程 → 等它以分配的角色连上 → 握手（协议版本、提供的服务、申请的权限）→ 健康检查 → 注册服务。
 * 子进程退出或连接断开时报告失败，内核撤回其服务，依赖方回到 WAITING，并按退避重启。
 * 停止：RPC shutdown → 关闭 stdin → 超时强制终止（R-06）；收尾超时时直接终止。
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
      const host = ctx.service(SidecarHostService);
      const role = `sidecar.${ctx.entryId}`;
      const pending = host.hub.expect(role);
      let child: ManagedProcess;
      try {
        child = await ManagedProcess.start({
          name: role,
          command: spec.command,
          args: spec.args,
          env: {
            ...baseEnvironment(),
            ...spec.env,
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
        } else {
          await child.stop(
            peer ? { shutdown: () => peer.request(ProcessShutdown, { reason: 'unload' }) } : {},
          );
        }
        await child.exited;
        peer?.connection.destroy();
      });

      const exitedEarly = child.exited.then((status) => {
        throw new Error(`sidecar 在握手完成前退出：code=${status.code} signal=${status.signal}`);
      });
      const connection = await Promise.race([pending.connection, exitedEarly]);
      const peer = new RpcPeer(connection, { timeoutMs: spec.rpcTimeoutMs ?? 2000 });
      rpc = peer;

      const description = await peer.request(SidecarDescribe);
      if (!isDescription.Check(description)) throw new Error('sidecar 的描述不合法');
      if (description.protocol !== SIDECAR_PROTOCOL) throw new Error('sidecar 协议版本不兼容');
      if (!sameSet(description.provides, manifest.provides)) {
        throw new Error(
          `sidecar 提供的服务 ${description.provides.join(',')} 与清单 ${manifest.provides.join(',')} 不一致`,
        );
      }
      const ungranted = description.permissions.filter((p) => !ctx.permissions.has(p));
      if (ungranted.length > 0)
        throw new Error(`sidecar 申请了未授予的权限 ${ungranted.join(',')}`);

      const health = await peer.request(SidecarHealth);
      if (!isHealth.Check(health) || !health.ok) {
        throw new Error(`sidecar 健康检查未通过：${JSON.stringify(health)}`);
      }

      const client: SidecarService = {
        request: (method, params, options) => peer.request(method, params, options),
      };
      for (const ref of manifest.provides) {
        const { name, major } = parseRef(ref);
        ctx.provide(defineService<SidecarService>(name, major), client);
      }

      const lost = (why: string) => {
        if (!ctx.signal.aborted) ctx.fail(new Error(why));
      };
      void child.exited.then((s) => lost(`sidecar 进程退出：code=${s.code} signal=${s.signal}`));
      connection.once('close', () => lost('sidecar 连接断开'));
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
