/**
 * 宿主进程入口。由启动器拉起（R-23），从环境变量获得本次会话的通道地址与密钥，作为本机通道的服务端。
 * 插件内核与安全核在后续步骤装配到这里。
 */
import { listen, RpcPeer } from '@bellis/channel';
import {
  channelCredentialsFromEnv,
  handleShutdown,
  logEvent,
  watchLifeline,
} from '@bellis/process';
import { HostStopping, Role } from '@bellis/protocol';

const RPC_TIMEOUT_MS = 2000;

const credentials = channelCredentialsFromEnv();
const peers = new Set<RpcPeer>();
let stopping = false;

const server = await listen(credentials.path, {
  key: credentials.key,
  onConnection(connection) {
    const rpc = new RpcPeer(connection, { timeoutMs: RPC_TIMEOUT_MS });
    peers.add(rpc);
    connection.on('close', () => peers.delete(rpc));
    if (connection.role === Role.Launcher) {
      handleShutdown(rpc, (reason) => void stop(reason ?? Role.Launcher));
    }
    logEvent('host.connection-accepted', { role: connection.role });
  },
  onRejected(error) {
    logEvent('host.connection-rejected', { code: error.code, message: error.message });
  },
  onError(error) {
    logEvent('host.channel-error', { message: error.message });
  },
});

watchLifeline(() => void stop('stdin-eof'));
// 控制台的 Ctrl+C 会送达同一控制台的全部进程；宿主只按启动器的停止顺序退出。
process.on('SIGINT', () => {});
logEvent('host.ready', { pid: process.pid, ppid: process.ppid });

async function stop(reason: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logEvent('host.stopping', { reason });
  for (const peer of peers) {
    if (peer.connection.isOpen) peer.notify(HostStopping, { reason });
  }
  await server.close();
  process.exit(0);
}
