/**
 * 操作员命令行的实现（`pnpm operator`）：解析参数，经本机通道调宿主的操作员动作（与操作台是同一套），
 * 把结果原样打印成 JSON。`console` 向宿主要一次性登录令牌，用系统自带的方式打开浏览器（令牌放在 URL 片段里）；
 * 打不开时把带令牌的地址打印出来。
 */
import { spawn } from 'node:child_process';
import { OperatorConsoleLoginResult, OperatorMethod } from '@bellis/protocol';
import { Compile } from 'typebox/compile';

export const OPERATOR_USAGE =
  '用法：operator <status | mode 目标 | presence | estop [原因] | veto [句键] | release [句键] | preflight [M1|M2|M3] | forget 平台ID | resolve 意图编号 <succeeded|failed> | resolve --list | console>';

export interface OperatorCommandIo {
  /** 经本机通道调宿主的操作员方法。 */
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  /** 用系统自带的方式在浏览器里打开地址；打不开时抛错。 */
  open(url: string): Promise<void>;
  print(line: string): void;
}

export type OperatorCommand =
  | { kind: 'call'; method: string; params: Record<string, unknown> }
  | { kind: 'unresolved' }
  | { kind: 'console' };

const isLogin = Compile(OperatorConsoleLoginResult);

/**
 * 等宿主应答的时限：切换模式与只跑预检要等开播预检跑完（含配置了的决策模型探测，其截止时间至多 20 秒），
 * 放宽到 30 秒；其余 5 秒。
 */
export function requestTimeoutMs(method: string): number {
  return method === OperatorMethod.Mode || method === OperatorMethod.Preflight ? 30_000 : 5000;
}

/** 解析命令行参数；用法不对时为 undefined。 */
export function parseOperatorArgs(args: readonly string[]): OperatorCommand | undefined {
  const [command, ...rest] = args;
  const optional = (params: (value: string) => Record<string, unknown>) =>
    rest.length > 1 ? undefined : rest[0] === undefined ? {} : params(rest[0]);
  const call = (method: string, params: Record<string, unknown> | undefined) =>
    params === undefined ? undefined : ({ kind: 'call', method, params } as const);
  switch (command) {
    case 'status':
      return rest.length === 0 ? call(OperatorMethod.Status, {}) : undefined;
    case 'presence':
      return rest.length === 0 ? call(OperatorMethod.Presence, {}) : undefined;
    case 'mode':
      return rest.length === 1 ? call(OperatorMethod.Mode, { target: rest[0] }) : undefined;
    case 'estop':
      // 急停的原因可以带空格；不给就用缺省原因。
      return call(OperatorMethod.EmergencyStop, {
        reason: rest.length > 0 ? rest.join(' ') : '操作员急停',
      });
    case 'veto':
      return call(
        OperatorMethod.Veto,
        optional((key) => ({ key })),
      );
    case 'release':
      return call(
        OperatorMethod.Release,
        optional((key) => ({ key })),
      );
    case 'preflight':
      return call(
        OperatorMethod.Preflight,
        optional((target) => ({ target })),
      );
    case 'forget':
      // 观众的平台稳定 ID（B 站为 open_id）；格式由宿主按同一份 Schema 校验。
      return rest.length === 1 ? call(OperatorMethod.Forget, { account: rest[0] }) : undefined;
    case 'resolve':
      // --list 列出结果未知的意图（取自 status）；结案要给意图编号与结局，结局由宿主按同一份 Schema 校验。
      if (rest.length === 1 && rest[0] === '--list') return { kind: 'unresolved' };
      return rest.length === 2 && /^[1-9][0-9]{0,15}$/.test(rest[0] ?? '')
        ? call(OperatorMethod.Resolve, { id: Number(rest[0]), outcome: rest[1] })
        : undefined;
    case 'console':
      return rest.length === 0 ? { kind: 'console' } : undefined;
    default:
      return undefined;
  }
}

/** 执行命令并返回退出码：0 成功，1 失败，2 用法错误。 */
export async function runOperatorCommand(
  args: readonly string[],
  io: OperatorCommandIo,
): Promise<number> {
  const command = parseOperatorArgs(args);
  if (!command) {
    io.print(OPERATOR_USAGE);
    return 2;
  }
  if (command.kind === 'call') {
    io.print(JSON.stringify(await io.request(command.method, command.params), null, 2));
    return 0;
  }
  if (command.kind === 'unresolved') {
    const status = (await io.request(OperatorMethod.Status, {})) as { unresolved?: unknown };
    io.print(JSON.stringify(status.unresolved ?? null, null, 2));
    return status.unresolved === null ? 1 : 0;
  }
  const login = await io.request(OperatorMethod.ConsoleLogin, {});
  if (!isLogin.Check(login)) {
    io.print(JSON.stringify(login, null, 2));
    return 1;
  }
  // 令牌只放在片段里：不随请求发出、不进 Referer，页面读出后立即从地址栏抹掉。
  const address = `${login.url}#${login.token}`;
  const seconds = Math.round(login.expiresInMs / 1000);
  try {
    await io.open(address);
    io.print(`已在浏览器里打开操作台：${login.url}（登录令牌 ${seconds} 秒内有效、只能用一次）`);
  } catch (error) {
    io.print(`没能打开浏览器（${(error as Error).message}），请在浏览器里打开下面的地址：`);
    io.print(address);
    io.print(
      `这个地址带一次性登录令牌：只能用一次，${seconds} 秒内有效，不要分享；用过或过期后重新运行 pnpm operator console。`,
    );
  }
  return 0;
}

/**
 * 各平台自带的打开方式，都不经 shell：Windows 用 `rundll32 url.dll,FileProtocolHandler`（交给默认浏览器，
 * 保留 URL 片段，成功时退出码为 0；explorer.exe 成功时也返回 1，判断不了成败），macOS 用 `open`，
 * 其余用 `xdg-open`。
 */
export function browserCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
): [command: string, args: string[]] {
  if (platform === 'win32') return ['rundll32.exe', ['url.dll,FileProtocolHandler', url]];
  if (platform === 'darwin') return ['open', [url]];
  return ['xdg-open', [url]];
}

/**
 * 打开浏览器；命令不存在或以非零退出码结束时抛错，超过 timeoutMs 还没结束就当作已打开。
 * `spec` 只给测试替换命令用。
 */
export function openBrowser(
  url: string,
  timeoutMs = 10_000,
  spec: [command: string, args: string[]] = browserCommand(url),
): Promise<void> {
  const [command, args] = spec;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', windowsHide: true });
    const timer = setTimeout(() => {
      child.unref();
      resolve();
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${command} 退出码 ${code}`));
    });
  });
}
