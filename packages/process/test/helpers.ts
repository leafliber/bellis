import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

export const fixture = (name: string) =>
  fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

/** 读取第一行满足条件的输出。 */
export async function firstLine(
  stream: Readable | null,
  match: (line: string) => boolean,
): Promise<string> {
  if (!stream) throw new Error('没有可读的输出');
  for await (const line of createInterface({ input: stream })) {
    if (match(line)) return line;
  }
  throw new Error('输出已结束');
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function waitUntil(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`条件未在 ${timeoutMs}ms 内满足`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
