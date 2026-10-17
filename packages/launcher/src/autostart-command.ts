/**
 * “登录时运行”计划任务的注册、注销与查看（R-23、R-26）。只在 Windows 上可用，其它平台报告 unsupported。
 * 以 spawn 调用系统自带的 schtasks.exe，不经 shell；它的输出随系统语言本地化，成败只看退出码。
 * 任务 XML 由 task-xml.ts 生成，写进系统临时目录，用完即删。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, win32 } from 'node:path';
import { loadConfig } from '@bellis/config';
import { baseEnvironment } from '@bellis/process';
import {
  checkTask,
  decodeQueryOutput,
  encodeTaskXml,
  type FieldCheck,
  readTaskXml,
  type TaskFiles,
  taskXml,
} from './task-xml.ts';

export const AUTOSTART_USAGE = '用法：autostart <register [配置文件] | unregister | status>';
/** 任务放在根目录，不建任务文件夹：注销后不留下空文件夹。 */
export const TASK_NAME = 'Bellis';
const TASK_DESCRIPTION = 'Bellis 启动器：登录时拉起宿主与看门狗（由 pnpm autostart 注册）';

export interface SchtasksResult {
  /** 退出码；被强制终止时为 null。 */
  code: number | null;
  stdout: Uint8Array;
}

/** 运行 schtasks.exe。`capture` 时收集标准输出，否则输出直接显示在终端。 */
export type Schtasks = (
  args: readonly string[],
  options: { capture: boolean },
) => Promise<SchtasksResult>;

export interface AutostartContext {
  platform: NodeJS.Platform;
  schtasks: Schtasks;
  /** 给维护者看的结果与错误。 */
  print(line: string): void;
  /** 当前用户 `域\用户名`；取不到时抛错。 */
  currentUser(): string;
  /** 任务要运行的启动器，均为绝对路径。 */
  launcher: {
    /** node 可执行文件：运行本命令的那一个。 */
    node: string;
    /** 启动器入口。 */
    entry: string;
    /** 仓库根，作为工作目录。 */
    root: string;
  };
  /** 相对的配置文件路径按此目录解析。 */
  cwd: string;
  /** register 不给配置文件时的缺省值。 */
  defaultConfig: string;
}

/** 执行命令并返回退出码：0 成功，1 失败或不支持，2 用法错误。 */
export async function runAutostartCommand(
  args: readonly string[],
  context: AutostartContext,
): Promise<number> {
  const [command, ...rest] = args;
  const valid =
    (command === 'register' && rest.length <= 1) ||
    ((command === 'unregister' || command === 'status') && rest.length === 0);
  if (!valid) {
    context.print(AUTOSTART_USAGE);
    return 2;
  }
  if (context.platform !== 'win32') {
    context.print(
      `计划任务只在 Windows 上可用，当前平台 ${context.platform} 不支持（unsupported）`,
    );
    return 1;
  }
  try {
    if (command === 'register') return await register(rest[0], context);
    if (command === 'unregister') return await unregister(context);
    return await verify(context, '核对未通过');
  } catch (error) {
    context.print((error as Error).message);
    return 1;
  }
}

async function register(configArg: string | undefined, context: AutostartContext): Promise<number> {
  const config = resolveConfig(resolve(context.cwd, configArg ?? context.defaultConfig));
  const userId = context.currentUser();
  const { node, entry, root } = context.launcher;
  const xml = taskXml({
    userId,
    command: node,
    args: [entry, config],
    workingDirectory: root,
    description: TASK_DESCRIPTION,
  });
  const dir = mkdtempSync(join(tmpdir(), 'bellis-autostart-'));
  let result: SchtasksResult;
  try {
    const file = join(dir, 'task.xml');
    writeFileSync(file, encodeTaskXml(xml));
    result = await context.schtasks(['/Create', '/TN', TASK_NAME, '/XML', file, '/F'], {
      capture: false,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (result.code !== 0) {
    context.print(`注册失败：schtasks 退出码 ${result.code}`);
    return 1;
  }
  context.print(`已注册计划任务 ${TASK_NAME}：${userId} 登录时运行启动器，配置文件 ${config}`);
  return verify(context, '已注册，但读回核对未通过，可用 pnpm autostart unregister 注销');
}

async function unregister(context: AutostartContext): Promise<number> {
  const result = await context.schtasks(['/Delete', '/TN', TASK_NAME, '/F'], { capture: false });
  if (result.code !== 0) {
    context.print(`注销失败：schtasks 退出码 ${result.code}（任务可能不存在）`);
    return 1;
  }
  context.print(`已注销计划任务 ${TASK_NAME}`);
  return 0;
}

/** 用 `/Query /XML` 读回任务，逐项核对并输出摘要。有不一致的项时返回 1。 */
async function verify(context: AutostartContext, failure: string): Promise<number> {
  const result = await context.schtasks(['/Query', '/TN', TASK_NAME, '/XML'], { capture: true });
  if (result.code !== 0) {
    context.print(
      `没有读到计划任务 ${TASK_NAME}：schtasks 退出码 ${result.code}（任务可能未注册）`,
    );
    return 1;
  }
  const { node, entry, root } = context.launcher;
  const checks = checkTask(
    readTaskXml(decodeQueryOutput(result.stdout)),
    { userId: context.currentUser(), command: node, entry, workingDirectory: root },
    localFiles,
  );
  context.print(`计划任务 ${TASK_NAME}：`);
  for (const check of checks) context.print(`  ${formatCheck(check)}`);
  const mismatched = checks.filter((check) => check.verdict === 'mismatch').length;
  const unverified = checks.filter((check) => check.verdict === 'unverified').length;
  if (mismatched > 0) {
    context.print(`${failure}：${mismatched} 项不一致`);
    return 1;
  }
  context.print(unverified > 0 ? `其余各项一致，${unverified} 项未核对` : '各项一致');
  return 0;
}

function formatCheck(check: FieldCheck): string {
  const line = `${check.label}：${check.actual}`;
  if (check.verdict === 'ok') return line;
  if (check.verdict === 'unverified') return `${line}（未核对：${check.note ?? ''}）`;
  return `${line}（不一致：${check.note ? `${check.note}，` : ''}应为 ${check.expected}）`;
}

/** 配置文件规范成绝对路径，确认存在且是宿主与看门狗能读的配置。 */
function resolveConfig(path: string): string {
  let real: string;
  try {
    real = realpathSync.native(path);
  } catch {
    throw new Error(`配置文件不存在或无法访问：${path}`);
  }
  if (!statSync(real).isFile()) throw new Error(`配置文件不是文件：${real}`);
  try {
    loadConfig(real);
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new Error(`配置文件 ${real} 不是合法的 JSON：${error.message}`);
    throw error;
  }
  return real;
}

const localFiles: TaskFiles = {
  exists: (path) => existsSync(path),
  canonical(path) {
    try {
      return realpathSync.native(path).toLowerCase();
    } catch {
      return win32.normalize(path).toLowerCase();
    }
  },
};

/** schtasks.exe 的绝对路径：取自 SystemRoot，不按 PATH 或当前目录查找。 */
export function schtasksPath(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.SystemRoot ?? env.SYSTEMROOT;
  if (!root) throw new Error('缺少环境变量 SystemRoot，找不到 schtasks.exe');
  return win32.join(root, 'System32', 'schtasks.exe');
}

/** 以 spawn 运行可执行文件：不经 shell、隐藏窗口、显式传入环境变量，stdin 关闭以免等待确认。 */
export function spawnSchtasks(executable: () => string = schtasksPath): Schtasks {
  return (args, { capture }) =>
    new Promise((settle, fail) => {
      const child = spawn(executable(), args, {
        shell: false,
        windowsHide: true,
        env: baseEnvironment(),
        stdio: ['ignore', capture ? 'pipe' : 'inherit', 'inherit'],
      });
      const chunks: Buffer[] = [];
      child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
      child.once('error', fail);
      child.once('close', (code) => settle({ code, stdout: Buffer.concat(chunks) }));
    });
}
