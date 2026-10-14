import { createConnection, createServer, type Socket } from 'node:net';
import { Connection, type ConnectionOptions, checkSessionKey } from './connection.ts';
import { ChannelError } from './errors.ts';

export interface ListenOptions extends ConnectionOptions {
  /** 握手成功的连接。须在回调内同步挂上监听器；回调抛错时连接被断开，错误交给 onError。 */
  onConnection: (connection: Connection) => void;
  /** 握手失败（认证失败、超时、协议错误、提前断开、握手过多）时调用，用于告警。 */
  onRejected: (error: ChannelError) => void;
  /** 监听期间服务端自身的错误，以及 onConnection 抛出的错误。 */
  onError: (error: Error) => void;
  /** 同时进行的未认证握手上限，默认 16；超出的连接立即断开。 */
  maxPendingHandshakes?: number;
}

export interface ChannelServer {
  readonly path: string;
  /** 停止监听，并断开全部连接（含握手中的）。 */
  close(): Promise<void>;
}

const DEFAULT_MAX_PENDING_HANDSHAKES = 16;

/**
 * 在本机通道地址上监听（宿主永远是服务端）。
 * 地址已被占用时以 `address-in-use` 失败：会话地址每次随机生成，出现即按可能被抢注告警，不得用同名重试。
 * 不设置 readableAll / writableAll；访问控制靠握手认证，而非文件或管道权限（D-12）。
 */
export async function listen(path: string, options: ListenOptions): Promise<ChannelServer> {
  checkSessionKey(options.key);
  const maxPending = options.maxPendingHandshakes ?? DEFAULT_MAX_PENDING_HANDSHAKES;
  const sockets = new Set<Socket>();
  let pending = 0;

  const server = createServer((socket) => {
    if (pending >= maxPending) {
      socket.destroy();
      options.onRejected(new ChannelError('busy', `未认证的握手已达上限 ${maxPending}`));
      return;
    }
    pending += 1;
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    Connection.accept(socket, options).then(
      (connection) => {
        pending -= 1;
        try {
          options.onConnection(connection);
        } catch (error) {
          connection.destroy();
          options.onError(error as Error);
        }
      },
      (error: ChannelError) => {
        pending -= 1;
        options.onRejected(error);
      },
    );
  });

  const close = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
      for (const socket of sockets) socket.destroy();
    });

  return new Promise((resolve, reject) => {
    const onStartError = (error: NodeJS.ErrnoException) => {
      reject(
        error.code === 'EADDRINUSE'
          ? new ChannelError('address-in-use', `通道地址已被占用，可能被抢注：${path}`, {
              cause: error,
            })
          : error,
      );
    };
    server.once('error', onStartError);
    server.listen(path, () => {
      server.off('error', onStartError);
      server.on('error', options.onError);
      resolve({ path, close });
    });
  });
}

/** 以给定角色连接本机通道，握手成功后返回连接。 */
export async function connect(
  path: string,
  role: string,
  options: ConnectionOptions,
): Promise<Connection> {
  checkSessionKey(options.key);
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
