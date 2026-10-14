import { createConnection, createServer, type Socket } from 'node:net';
import { Connection, type ConnectionOptions } from './connection.ts';
import { ChannelError } from './errors.ts';

export interface ListenOptions extends ConnectionOptions {
  /** 握手成功的连接。须在回调内同步挂上监听器。 */
  onConnection: (connection: Connection) => void;
  /** 握手失败（认证失败、超时、协议错误、提前断开）时调用，用于告警。 */
  onRejected?: (error: ChannelError) => void;
}

export interface ChannelServer {
  readonly path: string;
  /** 停止监听，并断开全部连接（含握手中的）。 */
  close(): Promise<void>;
}

/**
 * 在本机通道地址上监听（宿主永远是服务端）。
 * 地址已被占用时以 `address-in-use` 失败：会话地址每次随机生成，出现即按可能被抢注告警，不得用同名重试。
 * 不设置 readableAll / writableAll；访问控制靠握手认证，而非文件或管道权限（D-12）。
 */
export function listen(path: string, options: ListenOptions): Promise<ChannelServer> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    Connection.accept(socket, options).then(options.onConnection, (error: ChannelError) =>
      options.onRejected?.(error),
    );
  });

  const close = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
      for (const socket of sockets) socket.destroy();
    });

  return new Promise((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      reject(
        error.code === 'EADDRINUSE'
          ? new ChannelError('address-in-use', `通道地址已被占用，可能被抢注：${path}`, {
              cause: error,
            })
          : error,
      );
    });
    server.listen(path, () => resolve({ path, close }));
  });
}

/** 以给定角色连接本机通道，握手成功后返回连接。 */
export function connect(
  path: string,
  role: string,
  options: ConnectionOptions,
): Promise<Connection> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    const onError = (error: Error) => {
      reject(
        new ChannelError('connect-failed', `无法连接通道：${error.message}`, { cause: error }),
      );
    };
    socket.once('error', onError);
    socket.once('connect', () => {
      socket.off('error', onError);
      Connection.open(socket, role, options).then(resolve, reject);
    });
  });
}
