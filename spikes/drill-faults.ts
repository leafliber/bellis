/**
 * 演练用的网络故障注入：由演练以 `node --import <本文件的 URL>?state=<状态文件> 宿主入口` 预加载进真实宿主进程。
 * 状态文件是 JSON `{"block": ["主机名", …]}`，每 100ms 读一次：
 *   - 到列出主机的新 TLS 连接立即以 ECONNREFUSED 失败（不发出任何数据，也就没有发出凭据或文本）；
 *   - 主机刚被列入时，已经建立的到该主机的 TLS 连接被断开，模拟网络中断；
 *   - 从列表中去掉后恢复正常连接。
 * 只改本进程里 `node:tls` 的 `connect`，不改系统设置、配置或凭据。只用于演练，不进入正式代码路径。
 */
import { existsSync, readFileSync } from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';

const statePath = new URL(import.meta.url).searchParams.get('state');
if (!statePath) throw new Error('drill-faults：缺少 state 参数');

let blocked = new Set<string>();
/** 已建立的连接，按主机名。 */
const open = new Map<string, Set<net.Socket>>();

function read(): Set<string> {
  try {
    if (!existsSync(statePath as string)) return new Set();
    const state = JSON.parse(readFileSync(statePath as string, 'utf8')) as { block?: unknown };
    return new Set(Array.isArray(state.block) ? state.block.map(String) : []);
  } catch {
    // 演练正在改写文件：保持上一次的状态。
    return blocked;
  }
}

function refresh(): void {
  const next = read();
  for (const host of next) {
    if (blocked.has(host)) continue;
    for (const socket of open.get(host) ?? []) {
      socket.destroy(
        Object.assign(new Error(`演练：网络故障注入，断开 ${host}`), { code: 'ECONNRESET' }),
      );
    }
  }
  blocked = next;
}
refresh();
setInterval(refresh, 100).unref();

const original = tls.connect.bind(tls);
// ws 以 tls.connect(options) 建连（options.host、options.servername）；其它调用形式原样放行。
(tls as { connect: typeof tls.connect }).connect = ((...args: unknown[]) => {
  const options = args[0];
  const host =
    options !== null && typeof options === 'object'
      ? String(
          (options as { servername?: unknown; host?: unknown }).servername ??
            (options as { host?: unknown }).host ??
            '',
        )
      : '';
  if (host && blocked.has(host)) {
    const socket = new net.Socket();
    process.nextTick(() =>
      socket.destroy(
        Object.assign(new Error(`connect ECONNREFUSED（演练：网络故障注入 ${host}）`), {
          code: 'ECONNREFUSED',
        }),
      ),
    );
    return socket as unknown as tls.TLSSocket;
  }
  const socket = (original as (...a: unknown[]) => tls.TLSSocket)(...args);
  if (host) {
    const set = open.get(host) ?? new Set<net.Socket>();
    open.set(host, set);
    set.add(socket);
    socket.once('close', () => set.delete(socket));
  }
  return socket;
}) as typeof tls.connect;
