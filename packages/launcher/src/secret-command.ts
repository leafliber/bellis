/**
 * 凭据录入命令的实现（D-28）：维护者自己把凭据写进 SecretStore，Agent 与日志都不经手。
 * 值只从不回显的输入读取，不打印、不写日志；列出时只显示名字。
 * `audit` 核对文件中有没有出现凭据的值，只输出文件、条目名、编码与次数（见 secret-audit.ts）。
 */
import { createInterface } from 'node:readline';
import { createInterface as createPromptInterface } from 'node:readline/promises';
import { OBS_SECRET, SIM_OBS_SECRET, writeObsSecret } from '@bellis/config';
import { SESSION_SECRET, type SecretStore } from '@bellis/secret-store';
import { type AuditFs, defaultAuditLocations, runSecretAudit } from './secret-audit.ts';

export const SECRET_USAGE = '用法：secret <list | set 名字 | delete 名字 | audit [路径…]>';

/** 由启动器写入与删除的条目，不能手工改。 */
const MANAGED = new Set([SESSION_SECRET, SIM_OBS_SECRET]);
const DEFAULT_OBS_URL = 'ws://127.0.0.1:4455';
const SECRET_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export interface Prompter {
  /** 读一行输入。`hidden` 时不回显。输入结束或被取消时抛错。 */
  ask(question: string, options: { hidden: boolean }): Promise<string>;
}

export interface SecretCommandIo {
  prompt: Prompter;
  /** 给维护者看的结果与错误；从不包含凭据的值。 */
  print(line: string): void;
  /** audit 的相对路径按此目录解析。 */
  cwd: string;
  /** 仓库根：audit 不给路径时，缺省位置由此确定。 */
  root: string;
  /** audit 用到的文件操作，测试可以替换。 */
  fs?: AuditFs;
}

/** 执行命令并返回退出码：0 成功，1 失败（audit：有命中或读取失败），2 用法错误。 */
export async function runSecretCommand(
  args: readonly string[],
  store: SecretStore,
  io: SecretCommandIo,
): Promise<number> {
  const [command, name, ...rest] = args;
  if (command === 'audit') {
    const paths = args.slice(1);
    // 不支持选项；以 - 开头的文件名写成 ./-x。
    if (paths.some((path) => path === '' || path.startsWith('-'))) {
      io.print(SECRET_USAGE);
      return 2;
    }
    return runSecretAudit(paths, store, {
      print: io.print,
      cwd: io.cwd,
      defaults: () => defaultAuditLocations(io.root),
      ...(io.fs ? { fs: io.fs } : {}),
    });
  }
  if (command === 'list' && name === undefined) {
    const names = await store.names();
    if (names.length === 0) io.print('（没有凭据）');
    for (const entry of names) io.print(MANAGED.has(entry) ? `${entry}（由启动器管理）` : entry);
    return 0;
  }
  if ((command !== 'set' && command !== 'delete') || name === undefined || rest.length > 0) {
    io.print(SECRET_USAGE);
    return 2;
  }
  if (!SECRET_NAME.test(name)) {
    io.print(`凭据名不合法：${name}`);
    return 2;
  }
  if (MANAGED.has(name)) {
    io.print(`${name} 由启动器管理，不能手工修改`);
    return 1;
  }
  if (command === 'delete') {
    io.print((await store.delete(name)) ? `已删除 ${name}` : `没有 ${name}`);
    return 0;
  }
  const existed = (await store.get(name)) !== undefined;
  if (name === OBS_SECRET) {
    const url =
      (await io.prompt.ask(`obs-websocket 地址（回车用 ${DEFAULT_OBS_URL}）：`, {
        hidden: false,
      })) || DEFAULT_OBS_URL;
    const password = await askTwice(io, 'obs-websocket 密码（不回显；未设密码直接回车）');
    if (password === undefined) return 1;
    try {
      await writeObsSecret(store, password ? { url, password } : { url }, OBS_SECRET);
    } catch (error) {
      io.print((error as Error).message);
      return 1;
    }
  } else {
    const value = await askTwice(io, `${name} 的值（不回显）`);
    if (value === undefined) return 1;
    if (value === '') {
      io.print('值为空，未写入');
      return 1;
    }
    await store.set(name, value);
  }
  io.print(existed ? `已覆盖 ${name}` : `已写入 ${name}`);
  return 0;
}

/** 不回显地读两遍，两遍一致才返回；不一致时返回 undefined。 */
async function askTwice(io: SecretCommandIo, label: string): Promise<string | undefined> {
  const first = await io.prompt.ask(`${label}：`, { hidden: true });
  const second = await io.prompt.ask('再输入一遍：', { hidden: true });
  if (first !== second) {
    io.print('两次输入不一致，未写入');
    return undefined;
  }
  return first;
}

export type KeyResult =
  | { kind: 'more'; buffer: string }
  | { kind: 'done'; value: string }
  | { kind: 'cancelled' };

/**
 * 不回显输入时逐块处理按键：回车结束，Ctrl+C 取消，退格删一个码点，其余控制字符与转义序列忽略。
 * 一块里可能有整段粘贴的内容。
 */
export function applyKeys(buffer: string, chunk: string): KeyResult {
  let value = buffer;
  for (let i = 0; i < chunk.length; i++) {
    const char = chunk[i] as string;
    if (char === '\r' || char === '\n') return { kind: 'done', value };
    if (char === '\u0003') return { kind: 'cancelled' };
    if (char === '\u0008' || char === '\u007f') {
      value = Array.from(value).slice(0, -1).join('');
    } else if (char === '\u001b') {
      // 方向键等转义序列：跳过到序列末尾的字母或 ~。
      i++;
      if (chunk[i] === '[' || chunk[i] === 'O') {
        while (i + 1 < chunk.length && !/[A-Za-z~]/.test(chunk[i] as string)) i++;
      }
    } else if (char >= ' ') {
      value += char;
    }
  }
  return { kind: 'more', buffer: value };
}

/**
 * 从终端读入。stdin 是终端时，不回显的输入用原始模式逐键读取；
 * stdin 不是终端（管道）时按行读取，本来就没有回显。
 */
export function terminalPrompter(
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream,
): Prompter & { close(): void } {
  if (!input.isTTY) {
    const lines = createInterface({ input, terminal: false })[Symbol.asyncIterator]();
    return {
      async ask(question) {
        output.write(question);
        const next = await lines.next();
        output.write('\n');
        if (next.done) throw new Error('输入已结束');
        return next.value;
      },
      close() {
        input.destroy();
      },
    };
  }
  return {
    async ask(question, { hidden }) {
      if (!hidden) {
        const rl = createPromptInterface({ input, output });
        try {
          return await rl.question(question);
        } finally {
          rl.close();
        }
      }
      output.write(question);
      return new Promise<string>((resolve, reject) => {
        let buffer = '';
        const finish = () => {
          input.off('data', onData);
          input.setRawMode(false);
          input.pause();
          output.write('\n');
        };
        const onData = (data: Buffer | string) => {
          const result = applyKeys(buffer, data.toString());
          if (result.kind === 'more') {
            buffer = result.buffer;
            return;
          }
          finish();
          if (result.kind === 'done') resolve(result.value);
          else reject(new Error('已取消'));
        };
        input.setRawMode(true);
        input.resume();
        input.on('data', onData);
      });
    },
    close() {
      input.pause();
    },
  };
}
