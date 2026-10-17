/**
 * 真机演练前的并发检查：本机是否已有别的 Bellis 启动器、宿主、看门狗，或会操作 OBS 的探针与演练在运行。
 * 两个真实会话同时运行会争抢同一个 OBS 浏览器源（互相改写 URL、切场景）；用同一个 SecretStore
 * 服务名时还会互相覆盖会话信息。只读进程列表里的命令行，不读进程内存与环境变量。
 * 本进程与它直接拉起的子进程（演练自己的宿主、看门狗、operator 命令行）不算。
 */
import { spawn } from 'node:child_process';

const BELLIS = new RegExp(
  [
    String.raw`packages[\\/](launcher|host|watchdog)[\\/]src[\\/]main\.ts`,
    String.raw`spikes[\\/](drill-[\w-]+|s10-watchdog|s01-stage[\\/]server)\.ts`,
  ].join('|'),
);

export interface BellisProcess {
  pid: number;
  ppid: number;
  commandLine: string;
}

function run(command: string, args: readonly string[]): Promise<string> {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', fail);
    child.on('close', (code) =>
      code === 0 ? done(stdout) : fail(new Error(stderr.trim() || `${command} 退出码 ${code}`)),
    );
  });
}

async function nodeProcesses(): Promise<BellisProcess[]> {
  if (process.platform === 'win32') {
    const out = await run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress`,
    ]);
    if (!out.trim()) return [];
    const parsed = JSON.parse(out) as
      | { ProcessId: number; ParentProcessId: number; CommandLine: string | null }
      | Array<{ ProcessId: number; ParentProcessId: number; CommandLine: string | null }>;
    return (Array.isArray(parsed) ? parsed : [parsed]).map((p) => ({
      pid: p.ProcessId,
      ppid: p.ParentProcessId,
      commandLine: p.CommandLine ?? '',
    }));
  }
  const out = await run('ps', ['-eo', 'pid=,ppid=,args=']);
  return out
    .split('\n')
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), commandLine: m[3] ?? '' }));
}

/** 别的 Bellis 进程（不含本进程及其直接子进程）。 */
export async function otherBellisProcesses(): Promise<BellisProcess[]> {
  return (await nodeProcesses()).filter(
    (p) => p.pid !== process.pid && p.ppid !== process.pid && BELLIS.test(p.commandLine),
  );
}

/**
 * 等到没有别的 Bellis 进程：每 pollMs 查一次，超过 timeoutMs 仍有就抛错，由调用方停下报告。
 * 缺省每 30 秒查一次、最多等 20 分钟。
 */
export async function waitForNoOtherBellis(
  options: { pollMs?: number; timeoutMs?: number; log?: (message: string) => void } = {},
): Promise<void> {
  const pollMs = options.pollMs ?? 30_000;
  const deadline = Date.now() + (options.timeoutMs ?? 20 * 60_000);
  for (;;) {
    const others = await otherBellisProcesses();
    if (others.length === 0) return;
    const summary = others.map((p) => `${p.pid}: ${p.commandLine}`).join('\n');
    if (Date.now() + pollMs > deadline) throw new Error(`仍有别的 Bellis 进程在运行：\n${summary}`);
    options.log?.(`有别的 Bellis 进程在运行，${pollMs / 1000} 秒后再查：\n${summary}`);
    await new Promise((wait) => setTimeout(wait, pollMs));
  }
}
