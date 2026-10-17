/**
 * 凭据核对（P1 出口：真实密钥不出现在日志、事件和报告中）。
 * 在给定的文件里按字节查找 SecretStore 中的值及其常见编码，不解析文件格式（SQLite 的文本按明文存储）。
 * 只输出文件路径、条目名、编码种类与次数，从不输出值、值的片段或命中处前后的内容。
 */
import { readdirSync } from 'node:fs';
import * as nodeFs from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { loadConfig, OBS_SECRET, SIM_OBS_SECRET } from '@bellis/config';
import { SESSION_SECRET, type SecretStore } from '@bellis/secret-store';

/** 短于此长度（码点数）的值不核对：在任意文件里都可能偶然出现，命中与否都说明不了问题。 */
export const AUDIT_MIN_LENGTH = 8;
const CHUNK_SIZE = 1 << 20;
const SKIP_DIRS = new Set(['node_modules', '.git', '.venv']);
/** 输出中的路径与说明若含任一值的这么长的片段，就换成 `HIDDEN`。 */
const FRAGMENT = 8;
export const HIDDEN = '（路径已隐去：含疑似凭据片段）';

/**
 * 已知 JSON 格式的条目里属于秘密的字段；地址、PID、时间等字段不是秘密，不查，免得误报。
 * `decode` 表示字段是二进制密钥的 base64url 文本，解码后的字节另按几种常见写法核对。
 */
const JSON_ENTRIES: ReadonlyMap<string, ReadonlyArray<{ field: string; decode?: true }>> = new Map([
  [OBS_SECRET, [{ field: 'password' }]],
  [SIM_OBS_SECRET, [{ field: 'password' }]],
  [SESSION_SECRET, [{ field: 'channelKey', decode: true }]],
]);

/** 扫描用到的文件操作，测试可以替换。 */
export interface AuditFs {
  lstat(path: string): Promise<{
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
  }>;
  readdir(path: string): Promise<string[]>;
  open(
    path: string,
    flags: 'r',
  ): Promise<{
    read(
      buffer: Buffer,
      offset: number,
      length: number,
      position: number,
    ): Promise<{ bytesRead: number }>;
    close(): Promise<void>;
  }>;
}

const nodeAuditFs: AuditFs = {
  lstat: (path) => nodeFs.lstat(path),
  readdir: (path) => nodeFs.readdir(path),
  open: (path, flags) => nodeFs.open(path, flags),
};

export interface AuditOptions {
  print(line: string): void;
  /** 相对路径按此目录解析。 */
  cwd: string;
  /** 不给路径时的缺省位置。 */
  defaults(): { paths: string[]; notes: string[] };
  fs?: AuditFs;
  chunkSize?: number;
}

interface Needle {
  label: string;
  encoding: string;
  bytes: Buffer;
}

interface Hit {
  label: string;
  encoding: string;
  count: number;
}

/**
 * 缺省位置：仓库的 `reports/`、`config/`、`.bellis/`，以及 `config/*.json` 中各个状态存储所在的目录。
 * 状态存储按目录扫描，SQLite 的 `-wal`、`-shm` 文件随之包括在内。
 */
export function defaultAuditLocations(root: string): { paths: string[]; notes: string[] } {
  const configDir = join(root, 'config');
  const paths = [join(root, 'reports'), configDir, join(root, '.bellis')];
  const notes: string[] = [];
  let files: string[] = [];
  try {
    files = readdirSync(configDir).filter((name) => name.endsWith('.json'));
  } catch {
    // config/ 不存在时只扫其余位置；它本身会作为缺省位置报告“不存在”。
  }
  for (const file of files.sort()) {
    try {
      const store = dirname(loadConfig(join(configDir, file)).storePath);
      if (!paths.some((path) => pathKey(path) === pathKey(store))) paths.push(store);
    } catch {
      notes.push(`配置无法读取，未据此确定状态存储位置：${join(configDir, file)}`);
    }
  }
  return { paths, notes };
}

/** 比较用的路径：Windows 上不区分大小写。 */
function pathKey(path: string): string {
  const absolute = resolve(path);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

/** 执行核对并返回退出码：0 无命中，1 有命中或读取失败。不给路径时扫描缺省位置。 */
export async function runSecretAudit(
  paths: readonly string[],
  store: SecretStore,
  options: AuditOptions,
): Promise<number> {
  const fs = options.fs ?? nodeAuditFs;
  const print = options.print;

  const needles: Needle[] = [];
  const checked: string[] = [];
  const skipped: string[] = [];
  let entryFailures = 0;
  for (const name of await store.names()) {
    let value: string | undefined;
    try {
      value = await store.get(name);
    } catch (error) {
      skipped.push(`${name}：读取失败（${errorCode(error)}）`);
      entryFailures++;
      continue;
    }
    if (value === undefined) {
      skipped.push(`${name}：读取时已不存在`);
      continue;
    }
    for (const target of secretTargets(name, value)) {
      if (target.value === undefined) {
        skipped.push(`${target.label}：${target.reason}`);
      } else if ([...target.value].length < AUDIT_MIN_LENGTH) {
        skipped.push(`${target.label}：太短，未核对`);
      } else {
        checked.push(target.label);
        needles.push(...encodings(target.label, target.value, target.decode));
      }
    }
  }
  const fragments = fragmentSet(needles);
  const shown = (text: string) => (containsFragment(text, fragments) ? HIDDEN : text);

  let locations: string[];
  const missingOk = paths.length === 0;
  if (missingOk) {
    const defaults = options.defaults();
    locations = defaults.paths;
    for (const note of defaults.notes) print(shown(note));
  } else {
    locations = [...paths];
  }

  const maxLength = Math.max(0, ...needles.map((needle) => needle.bytes.length));
  const chunkSize = options.chunkSize ?? CHUNK_SIZE;
  const buffer = Buffer.alloc(Math.max(0, maxLength - 1) + chunkSize);
  const seen = new Set<string>();
  const failures: string[] = [];
  const notScanned: string[] = [];
  const missing: string[] = [];
  let files = 0;
  let bytes = 0;
  let hitLines = 0;
  let hitTotal = 0;

  const scanFile = async (path: string) => {
    const key = pathKey(path);
    if (seen.has(key)) return;
    seen.add(key);
    let handle: Awaited<ReturnType<AuditFs['open']>>;
    try {
      handle = await fs.open(path, 'r');
    } catch (error) {
      failures.push(`${shown(path)}：${errorCode(error)}`);
      return;
    }
    const counts = new Map<Needle, number>();
    let position = 0;
    let complete = false;
    try {
      let carry = 0;
      for (;;) {
        const { bytesRead } = await handle.read(buffer, carry, chunkSize, position);
        if (bytesRead === 0) break;
        position += bytesRead;
        const view = buffer.subarray(0, carry + bytesRead);
        for (const needle of needles) {
          const length = needle.bytes.length;
          // 只数结束于本块新数据中的命中；完全落在重叠部分的，上一块已经数过。
          let at = view.indexOf(needle.bytes, Math.max(0, carry - length + 1));
          while (at !== -1) {
            counts.set(needle, (counts.get(needle) ?? 0) + 1);
            at = view.indexOf(needle.bytes, at + 1);
          }
        }
        const keep = Math.min(view.length, Math.max(0, maxLength - 1));
        view.copy(buffer, 0, view.length - keep);
        carry = keep;
      }
      complete = true;
    } catch (error) {
      // 读到一半失败：已读部分的命中照常报告，文件记为读取失败。
      failures.push(`${shown(path)}：${errorCode(error)}`);
    } finally {
      await handle.close().catch(() => {});
    }
    if (complete) {
      files++;
      bytes += position;
    }
    const hits = new Map<string, Hit>();
    for (const needle of needles) {
      const count = counts.get(needle);
      if (count === undefined) continue;
      const id = `${needle.label}\u0000${needle.encoding}`;
      const hit = hits.get(id) ?? { label: needle.label, encoding: needle.encoding, count: 0 };
      hit.count += count;
      hits.set(id, hit);
    }
    for (const hit of hits.values()) {
      hitLines++;
      hitTotal += hit.count;
      print(`命中：${shown(path)}，${hit.label}，${hit.encoding}，${hit.count} 次`);
    }
  };

  const walk = async (path: string, top: boolean): Promise<void> => {
    let info: Awaited<ReturnType<AuditFs['lstat']>>;
    try {
      info = await fs.lstat(path);
    } catch (error) {
      if (top && missingOk && errorCode(error) === 'ENOENT') missing.push(shown(path));
      else failures.push(`${shown(path)}：${errorCode(error)}`);
      return;
    }
    if (info.isSymbolicLink()) {
      notScanned.push(`${shown(path)}：链接，未跟随`);
    } else if (info.isDirectory()) {
      if (!top && SKIP_DIRS.has(basename(path).toLowerCase())) return;
      let names: string[];
      try {
        names = await fs.readdir(path);
      } catch (error) {
        failures.push(`${shown(path)}：${errorCode(error)}`);
        return;
      }
      for (const name of names.sort()) await walk(join(path, name), false);
    } else if (info.isFile()) {
      await scanFile(path);
    } else {
      notScanned.push(`${shown(path)}：不是普通文件`);
    }
  };

  for (const location of locations) await walk(resolve(options.cwd, location), true);

  print(`扫描了 ${files} 个文件，共 ${bytes} 字节`);
  print(`核对的条目：${checked.length > 0 ? checked.join('、') : '（没有）'}`);
  for (const line of skipped) print(`跳过的条目：${line}`);
  for (const line of missing) print(`缺省位置不存在：${line}`);
  for (const line of notScanned) print(`未扫描：${line}`);
  for (const line of failures) print(`读取失败：${line}`);
  const problems: string[] = [];
  if (hitLines > 0) problems.push(`命中 ${hitLines} 项，共 ${hitTotal} 次`);
  if (failures.length > 0) problems.push(`${failures.length} 个路径读取失败`);
  if (entryFailures > 0) problems.push(`${entryFailures} 个条目读取失败`);
  print(problems.length > 0 ? `结果：${problems.join('；')}` : '结果：没有命中');
  return problems.length > 0 ? 1 : 0;
}

type Target =
  | { label: string; value: string; decode: boolean }
  | { label: string; value: undefined; reason: string };

/** 一个条目里要核对的值：已知 JSON 格式只取秘密字段，其余条目取整个值。 */
function secretTargets(name: string, value: string): Target[] {
  const fields = JSON_ENTRIES.get(name);
  if (fields === undefined) return [{ label: name, value, decode: false }];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    parsed = undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return [{ label: `${name}（整个值：格式不符）`, value, decode: false }];
  }
  const record = parsed as Record<string, unknown>;
  const targets: Target[] = [];
  for (const { field, decode } of fields) {
    const label = `${name}（${field} 字段）`;
    const text = record[field];
    if (typeof text === 'string') targets.push({ label, value: text, decode: decode === true });
    else targets.push({ label, value: undefined, reason: '没有此字段，未核对' });
  }
  return targets;
}

/**
 * 一个值要查找的字节序列。文本形式：原文、base64、base64url、URL 编码、JSON 转义，各自再有 UTF-16LE 形式。
 * 二进制密钥另查解码后的字节、hex 与标准 base64。同一条目内字节相同的形式只保留第一种。
 */
function encodings(label: string, value: string, decode: boolean): Needle[] {
  const texts: Array<[string, string]> = [['原文', value]];
  const utf8 = Buffer.from(value, 'utf8');
  for (const part of base64Stable(utf8, 'base64')) texts.push(['base64', part]);
  for (const part of base64Stable(utf8, 'base64url')) texts.push(['base64url', part]);
  try {
    texts.push(['URL 编码', encodeURIComponent(value)]);
  } catch {
    // 含孤立代理项的字符串无法 URL 编码，也就不会以这种形式出现。
  }
  texts.push(['URL 表单编码', new URLSearchParams({ v: value }).toString().slice(2)]);
  const json = JSON.stringify(value).slice(1, -1);
  texts.push(['JSON 转义', json]);
  texts.push(['JSON 转义（\\u 形式）', asciiJson(json)]);
  const raw: Array<[string, Buffer]> = [];
  if (decode && /^[A-Za-z0-9_-]+$/.test(value)) {
    const key = Buffer.from(value, 'base64url');
    raw.push(['解码后的字节', key]);
    texts.push(['解码后 hex', key.toString('hex')]);
    texts.push(['解码后 base64', key.toString('base64').replace(/=+$/, '')]);
  }
  const needles: Needle[] = [];
  const add = (encoding: string, bytes: Buffer) => {
    if (bytes.length === 0 || needles.some((needle) => needle.bytes.equals(bytes))) return;
    needles.push({ label, encoding, bytes });
  };
  for (const [encoding, text] of texts) add(encoding, Buffer.from(text, 'utf8'));
  for (const [encoding, bytes] of raw) add(encoding, bytes);
  for (const [encoding, text] of texts) add(`UTF-16LE ${encoding}`, Buffer.from(text, 'utf16le'));
  return needles;
}

/**
 * 值嵌在更长数据中被 base64 编码时，它的编码随起始字节对 3 取余而不同。对偏移 0、1、2 各取
 * 只由值本身决定的那段字符（去掉头尾与相邻数据共用比特的字符）。
 */
export function base64Stable(bytes: Buffer, alphabet: 'base64' | 'base64url'): string[] {
  const parts: string[] = [];
  for (let offset = 0; offset < 3; offset++) {
    const text = Buffer.concat([Buffer.alloc(offset), bytes]).toString(alphabet);
    const start = Math.ceil((8 * offset) / 6);
    const end = Math.floor((8 * (offset + bytes.length)) / 6);
    if (end > start) parts.push(text.slice(start, end));
  }
  return parts;
}

/** 非 ASCII 字符写成 `\uXXXX`（小写，补码点按两个代理项），如 Python `json.dumps` 的缺省输出。 */
export function asciiJson(json: string): string {
  return json.replace(/[^\p{ASCII}]/gu, (char) =>
    Array.from(
      { length: char.length },
      (_, i) => `\\u${char.charCodeAt(i).toString(16).padStart(4, '0')}`,
    ).join(''),
  );
}

function fragmentSet(needles: readonly Needle[]): Set<string> {
  const fragments = new Set<string>();
  for (const needle of needles) {
    if (needle.encoding.startsWith('UTF-16LE') || needle.encoding === '解码后的字节') continue;
    const text = needle.bytes.toString('utf8');
    for (let i = 0; i + FRAGMENT <= text.length; i++) fragments.add(text.slice(i, i + FRAGMENT));
  }
  return fragments;
}

function containsFragment(text: string, fragments: ReadonlySet<string>): boolean {
  for (let i = 0; i + FRAGMENT <= text.length; i++) {
    if (fragments.has(text.slice(i, i + FRAGMENT))) return true;
  }
  return false;
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : '未知错误';
}
