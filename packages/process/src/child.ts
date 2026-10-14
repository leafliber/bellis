import {
  type ChannelCredentials,
  type ConnectionOptions,
  connect,
  decodeSessionKey,
  RpcPeer,
} from '@bellis/channel';
import { ChildEnv, ProcessShutdown, ProcessShutdownParams } from '@bellis/protocol';
import { Compile } from 'typebox/compile';

/**
 * 子进程一侧：stdin 只作生命线，不传数据。读到 EOF（父进程要求停止或已经退出）时调用 onEnd。
 * 返回撤销函数。
 */
export function watchLifeline(
  onEnd: () => void,
  input: NodeJS.ReadableStream & { destroy?: () => void } = process.stdin,
): () => void {
  let fired = false;
  const handler = () => {
    if (fired) return;
    fired = true;
    onEnd();
  };
  const discard = () => {};
  input.on('data', discard);
  input.on('end', handler);
  input.on('close', handler);
  input.on('error', handler);
  input.resume();
  return () => {
    input.off('data', discard);
    input.off('end', handler);
    input.off('close', handler);
    input.off('error', handler);
    input.destroy?.();
  };
}

/** 从环境变量读取本次会话的通道地址与密钥（子进程经环境变量获得，R-23）。 */
export function channelCredentialsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ChannelCredentials {
  const path = env[ChildEnv.ChannelPath];
  const key = env[ChildEnv.ChannelKey];
  if (!path || !key) {
    throw new Error(`缺少环境变量 ${ChildEnv.ChannelPath} 或 ${ChildEnv.ChannelKey}`);
  }
  return { path, key: decodeSessionKey(key) };
}

/** 子进程以给定角色连接宿主，返回 RPC 对端。 */
export async function connectToHost(
  role: string,
  options: Omit<ConnectionOptions, 'key'> & { timeoutMs?: number } = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<RpcPeer> {
  const { path, key } = channelCredentialsFromEnv(env);
  const connection = await connect(path, role, { ...options, key });
  return new RpcPeer(connection, { timeoutMs: options.timeoutMs ?? 2000 });
}

const isShutdownParams = Compile(ProcessShutdownParams);

/**
 * 注册 `process.shutdown`：先应答，再在下一轮事件循环开始收尾，避免应答被退出打断。
 */
export function handleShutdown(rpc: RpcPeer, onShutdown: (reason?: string) => void): () => void {
  return rpc.handle(ProcessShutdown, (params) => {
    const reason = isShutdownParams.Check(params) ? params.reason : undefined;
    setImmediate(() => onShutdown(reason));
    return { accepted: true };
  });
}
