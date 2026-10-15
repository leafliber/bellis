import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import type { Readable } from 'node:stream';

export interface ProcessSpec {
  /** 用于日志的名字。 */
  name: string;
  command: string;
  args: readonly string[];
  /** 完整的环境变量，不隐式继承父进程环境（见 `baseEnvironment`）。 */
  env: Record<string, string>;
  cwd?: string;
  stdout?: 'inherit' | 'pipe' | 'ignore';
  stderr?: 'inherit' | 'pipe' | 'ignore';
}

export interface ExitStatus {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface StopOptions {
  /** 第 1 步：请求子进程自行收尾，通常是 RPC `process.shutdown`。 */
  shutdown?: () => Promise<unknown>;
  /** 每一步的等待上限，默认 2000ms。 */
  graceMs?: number;
}

export type StopStage = 'already-exited' | 'shutdown' | 'stdin-eof' | 'killed';

export interface StopResult extends ExitStatus {
  /** 子进程在哪一步退出。 */
  stage: StopStage;
}

const DEFAULT_GRACE_MS = 2000;

/**
 * 宿主管理的子进程（R-06）。
 *
 * - 一律 `spawn`，不用 shell、不用 detached，隐藏窗口，环境变量显式传入。
 * - stdin 是生命线：子进程读到 EOF 即自行退出。父进程正常停止时关闭它；父进程崩溃时操作系统关闭它。
 *   Windows 上另有 libuv 的 Job 保证父进程退出时直接子进程被终止。
 * - 停止顺序：shutdown 请求 → 关闭 stdin → 超时强制终止。不依赖信号。
 */
export class ManagedProcess {
  readonly name: string;
  readonly pid: number;
  /** 子进程退出时 resolve，永不 reject。 */
  readonly exited: Promise<ExitStatus>;
  readonly #child: ChildProcess;
  #status: ExitStatus | undefined;

  private constructor(name: string, child: ChildProcess, pid: number) {
    this.name = name;
    this.#child = child;
    this.pid = pid;
    this.exited = new Promise((resolve) => {
      child.once('exit', (code, signal) => {
        this.#status = { code, signal };
        resolve(this.#status);
      });
    });
    // 子进程已退出时写 stdin 会得到 EPIPE，这里吞掉；退出状态由 exited 报告。
    child.stdin?.on('error', () => {});
  }

  /** 启动子进程；可执行文件不存在等情况下 reject。 */
  static async start(spec: ProcessSpec): Promise<ManagedProcess> {
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      shell: false,
      detached: false,
      windowsHide: true,
      stdio: ['pipe', spec.stdout ?? 'inherit', spec.stderr ?? 'inherit'],
    });
    await Promise.race([
      once(child, 'spawn'),
      once(child, 'error').then(([error]) => {
        throw error;
      }),
    ]);
    return new ManagedProcess(spec.name, child, child.pid as number);
  }

  get stdout(): Readable | null {
    return this.#child.stdout;
  }

  get stderr(): Readable | null {
    return this.#child.stderr;
  }

  get status(): ExitStatus | undefined {
    return this.#status;
  }

  /** 按 R-06 的顺序停止子进程，返回它在哪一步退出。 */
  async stop(options: StopOptions = {}): Promise<StopResult> {
    const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
    if (this.#status) return { ...this.#status, stage: 'already-exited' };

    if (options.shutdown) {
      // 请求失败（连接已断、超时）不影响后续步骤。
      await withDeadline(options.shutdown(), graceMs).catch(() => {});
      const status = await this.#waitExit(graceMs);
      if (status) return { ...status, stage: 'shutdown' };
    }

    this.#child.stdin?.end();
    const status = await this.#waitExit(graceMs);
    if (status) return { ...status, stage: 'stdin-eof' };

    // Windows 上任何信号都是 TerminateProcess；POSIX 上用 SIGKILL 保证不被忽略。
    this.#child.kill('SIGKILL');
    return { ...(await this.exited), stage: 'killed' };
  }

  /** 立即强制终止，不经过收尾。 */
  kill(): void {
    if (!this.#status) this.#child.kill('SIGKILL');
  }

  async #waitExit(ms: number): Promise<ExitStatus | undefined> {
    if (this.#status) return this.#status;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), ms);
    });
    try {
      return await Promise.race([this.exited, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`未在 ${ms}ms 内完成`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
