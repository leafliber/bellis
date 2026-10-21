import { type FileHandle, mkdir, open, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Clock } from '@bellis/kernel';
import type { TelemetryWriter } from './core.ts';

/**
 * 遥测的 JSONL 文件：`<目录>/<进程>-<UTC 时刻>-<序号>.jsonl`，例如 `host-20261021T101500123Z-0.jsonl`、
 * `sidecar.tts-local-20261021T101502000Z-0.jsonl`。进程名区分宿主与各个 sidecar（sidecar 用它的通道角色）。
 *
 * - 轮转：当前文件写到 `maxFileBytes`，或开始写已满 `maxFileAgeMs`，下一批换新文件；
 * - 保留：每次换新文件后，同一进程名的文件只留最新的 `maxFiles` 个（按文件名里的时刻排序），更早的删除；
 *   别的进程的文件不动；
 * - 目录在第一次写时创建；打不开、写不进时这一批以错误结束，下一批重新打开新文件。
 *   不重试、不缓存，由调用方计数丢弃（见 `TelemetryCore`）。
 */
export interface FileWriterOptions {
  dir: string;
  /** 进程名：`host` 或 sidecar 的通道角色。 */
  role: string;
  clock: Clock;
  maxFileBytes: number;
  maxFileAgeMs: number;
  maxFiles: number;
}

const ROLE = /^[a-z][a-z0-9_.-]{0,63}$/;
const FILE = /^(.+)-(\d{8}T\d{9}Z)-(\d+)\.jsonl$/;

/** 时刻写成文件名里的 UTC 基本格式（到毫秒），按字典序即按时间排序。 */
export function fileStamp(unixMs: number): string {
  return new Date(Math.floor(unixMs)).toISOString().replace(/[-:.]/g, '');
}

/** 文件名拆成进程名、时刻与序号；不是遥测文件时返回 undefined。 */
export function parseFileName(
  name: string,
): { role: string; stamp: string; seq: number } | undefined {
  const match = FILE.exec(name);
  if (!match) return undefined;
  return { role: match[1] as string, stamp: match[2] as string, seq: Number(match[3]) };
}

interface Current {
  handle: FileHandle;
  name: string;
  bytes: number;
  openedAt: number;
}

export class FileWriter implements TelemetryWriter {
  readonly #options: FileWriterOptions;
  #current: Current | undefined;
  #seq = 0;

  constructor(options: FileWriterOptions) {
    if (!ROLE.test(options.role)) throw new Error(`遥测的进程名不合格：${options.role}`);
    this.#options = options;
  }

  async write(chunk: string): Promise<void> {
    const bytes = Buffer.byteLength(chunk);
    const { clock, maxFileBytes, maxFileAgeMs } = this.#options;
    const current = this.#current;
    if (
      current &&
      ((current.bytes > 0 && current.bytes + bytes > maxFileBytes) ||
        clock.now() - current.openedAt >= maxFileAgeMs)
    ) {
      await this.#closeCurrent();
    }
    const target = this.#current ?? (await this.#openNext());
    try {
      await target.handle.write(chunk);
      target.bytes += bytes;
    } catch (error) {
      // 写坏的文件不再续写：下一批换新文件。
      await this.#closeCurrent();
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.#closeCurrent();
  }

  async #closeCurrent(): Promise<void> {
    const current = this.#current;
    this.#current = undefined;
    await current?.handle.close().catch(() => undefined);
  }

  async #openNext(): Promise<Current> {
    const { dir, role, clock } = this.#options;
    await mkdir(dir, { recursive: true });
    const now = clock.now();
    const stamp = fileStamp((clock.epochMs ?? 0) + now);
    for (;;) {
      const name = `${role}-${stamp}-${this.#seq}.jsonl`;
      this.#seq += 1;
      try {
        const handle = await open(join(dir, name), 'wx');
        this.#current = { handle, name, bytes: 0, openedAt: now };
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    await this.#prune();
    return this.#current as Current;
  }

  /** 同一进程名的文件只留最新的 maxFiles 个（含当前文件）。删不掉的跳过。 */
  async #prune(): Promise<void> {
    const { dir, role, maxFiles } = this.#options;
    const own = (await readdir(dir))
      .map((name) => ({ name, parsed: parseFileName(name) }))
      .filter((file) => file.parsed?.role === role)
      .sort((a, b) =>
        a.parsed?.stamp === b.parsed?.stamp
          ? (a.parsed?.seq ?? 0) - (b.parsed?.seq ?? 0)
          : (a.parsed?.stamp ?? '') < (b.parsed?.stamp ?? '')
            ? -1
            : 1,
      );
    const excess = own.slice(0, Math.max(0, own.length - maxFiles));
    for (const file of excess) {
      if (file.name === this.#current?.name) continue;
      await rm(join(dir, file.name), { force: true }).catch(() => undefined);
    }
  }
}

/** 仿真与测试用：写到内存里，按行保存。 */
export class MemoryWriter implements TelemetryWriter {
  readonly lines: string[] = [];

  write(chunk: string): void {
    for (const line of chunk.split('\n')) if (line !== '') this.lines.push(line);
  }

  close(): void {}
}
