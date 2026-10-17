import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { OBS_SECRET, SIM_OBS_SECRET } from '@bellis/config';
import { MemorySecretStore, SESSION_SECRET, type SecretStore } from '@bellis/secret-store';
import fc from 'fast-check';
import {
  type AuditFs,
  type AuditOptions,
  asciiJson,
  base64Stable,
  defaultAuditLocations,
  HIDDEN,
  runSecretAudit,
} from '../src/secret-audit.ts';
import { runSecretCommand, SECRET_USAGE } from '../src/secret-command.ts';

// 以下全是测试用的假值。
/** 含引号、反斜杠、空格、&、非 ASCII 与 ~?>：各种编码互不相同，三种偏移的 base64 里都有 + 或 /。 */
const OBS_PASSWORD = 'Qz~~~??>>> "x\\é&W';
const OBS_URL = 'ws://127.0.0.1:4455';
const SIM_URL = 'ws://127.0.0.1:40001';
const VTS_TOKEN = 'vtsTokFAKE0a9b8c7d6e5f4';
const SHORT = 'Zq3!x';
const NOT_JSON = 'NOT-JSON-obsFake-7Hd92kLq';
/** 解码后的标准 base64 与 base64url 文本不同（含 - 或 _）。 */
const KEY_BYTES = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 53 + 250) & 0xff));
const CHANNEL_KEY = KEY_BYTES.toString('base64url');
const SESSION = {
  v: 1,
  sessionId: 's1fake',
  channelPath: '\\\\.\\pipe\\bellis-s1fake-0123456789abcdef0123456789',
  channelKey: CHANNEL_KEY,
  launcherPid: 4242,
  startedAt: '2026-10-17T01:02:03.000Z',
};
const OBS_LABEL = 'obs（password 字段）';
const SESSION_LABEL = 'session（channelKey 字段）';

/** 输出里不能出现的值；再加上它们的几种编码。 */
const SECRETS = [OBS_PASSWORD, VTS_TOKEN, SHORT, NOT_JSON, CHANNEL_KEY].flatMap((value) => {
  const utf8 = Buffer.from(value, 'utf8');
  return [
    value,
    utf8.toString('base64'),
    utf8.toString('base64url'),
    encodeURIComponent(value),
    JSON.stringify(value),
  ];
});
SECRETS.push(KEY_BYTES.toString('hex'), KEY_BYTES.toString('base64'));

const root = mkdtempSync(join(tmpdir(), 'bellis-audit-test-'));
after(() => rmSync(root, { recursive: true, force: true }));
const everything: string[] = [];

function assertNoSecrets(lines: readonly string[]): void {
  const text = lines.join('\n');
  for (const secret of SECRETS) {
    if (secret.length < 8) {
      assert.ok(!text.includes(secret), '输出含有值');
      continue;
    }
    for (let i = 0; i + 8 <= secret.length; i++) {
      assert.ok(!text.includes(secret.slice(i, i + 8)), '输出含有值的片段');
    }
  }
}

/** 在临时目录下建一组文件，返回这组文件所在的目录。 */
function files(name: string, contents: Record<string, string | Buffer>): string {
  const base = join(root, name);
  mkdirSync(base, { recursive: true });
  for (const [file, content] of Object.entries(contents)) {
    const path = join(base, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return base;
}

async function fakeStore(): Promise<MemorySecretStore> {
  const store = new MemorySecretStore();
  await store.set(OBS_SECRET, JSON.stringify({ url: OBS_URL, password: OBS_PASSWORD }));
  await store.set(SIM_OBS_SECRET, JSON.stringify({ url: SIM_URL }));
  await store.set(SESSION_SECRET, JSON.stringify(SESSION));
  await store.set('vts', VTS_TOKEN);
  await store.set('tts.short', SHORT);
  return store;
}

interface Hit {
  path: string;
  label: string;
  encoding: string;
  count: number;
}

function collect(printed: string[]) {
  everything.push(...printed);
  assertNoSecrets(printed);
  const hits: Hit[] = printed
    .filter((line) => line.startsWith('命中：'))
    .map((line) => {
      const [path, label, encoding, count] = line.slice('命中：'.length).split('，');
      return {
        path: path ?? '',
        label: label ?? '',
        encoding: encoding ?? '',
        count: Number.parseInt(count ?? '', 10),
      };
    });
  return { printed, hits };
}

/** 经命令入口运行 `secret audit`。 */
async function audit(args: string[], store: SecretStore, repoRoot = root) {
  const printed: string[] = [];
  const code = await runSecretCommand(['audit', ...args], store, {
    prompt: {
      async ask() {
        throw new Error('audit 不应提问');
      },
    },
    print: (line) => printed.push(line),
    cwd: root,
    root: repoRoot,
  });
  return { code, ...collect(printed) };
}

/** 直接调用核对函数，可以指定块大小与文件操作。 */
async function auditDirect(
  paths: string[],
  store: SecretStore,
  options: Partial<Pick<AuditOptions, 'fs' | 'chunkSize'>> = {},
) {
  const printed: string[] = [];
  const code = await runSecretAudit(paths, store, {
    print: (line) => printed.push(line),
    cwd: root,
    defaults: () => ({ paths: [], notes: [] }),
    ...options,
  });
  return { code, ...collect(printed) };
}

function hitsIn(hits: readonly Hit[], file: string) {
  return hits
    .filter((hit) => basename(hit.path) === file)
    .map(({ label, encoding, count }) => ({ label, encoding, count }));
}

/** Python `json.dumps(OBS_PASSWORD)` 的输出。 */
const OBS_PASSWORD_PYTHON_JSON = '"Qz~~~??>>> \\"x\\\\\\u00e9&W"';

test('各种编码都能查到：原文、三种偏移的 base64、base64url、URL 编码、JSON 转义及其 UTF-16LE', async () => {
  const password = Buffer.from(OBS_PASSWORD, 'utf8');
  const embed = (prefix: number) =>
    Buffer.concat([Buffer.from('0123456'.slice(0, prefix)), password, Buffer.from('tail')]);
  const expected: Record<string, string> = {
    'raw.log': '原文',
    'b64-0.txt': 'base64',
    'b64-1.txt': 'base64',
    'b64-2.txt': 'base64',
    'b64-5.txt': 'base64',
    'b64url-1.txt': 'base64url',
    'b64url-3.txt': 'base64url',
    'url.txt': 'URL 编码',
    'form.txt': 'URL 表单编码',
    'json.log': 'JSON 转义',
    'json-ascii.log': 'JSON 转义（\\u 形式）',
    'utf16.log': 'UTF-16LE 原文',
    'utf16-b64.log': 'UTF-16LE base64',
    'utf16-json.log': 'UTF-16LE JSON 转义',
  };
  const dir = files('encodings', {
    'raw.log': `t=1 pw=${OBS_PASSWORD}\n`,
    'b64-0.txt': embed(0).toString('base64'),
    'b64-1.txt': embed(1).toString('base64'),
    'b64-2.txt': embed(2).toString('base64'),
    'b64-5.txt': `data:${embed(5).toString('base64')}`,
    'b64url-1.txt': embed(1).toString('base64url'),
    'b64url-3.txt': embed(3).toString('base64url'),
    'url.txt': `GET /x?pw=${encodeURIComponent(OBS_PASSWORD)}&n=1`,
    'form.txt': new URLSearchParams({ pw: OBS_PASSWORD, n: '1' }).toString(),
    'json.log': `${JSON.stringify({ event: 'x', password: OBS_PASSWORD })}\n`,
    'json-ascii.log': `{"password": ${OBS_PASSWORD_PYTHON_JSON}}\n`,
    'utf16.log': Buffer.from(`﻿日志 ${OBS_PASSWORD}\r\n`, 'utf16le'),
    'utf16-b64.log': Buffer.from(embed(2).toString('base64'), 'utf16le'),
    'utf16-json.log': Buffer.from(JSON.stringify({ password: OBS_PASSWORD }), 'utf16le'),
  });
  const result = await audit([dir], await fakeStore());
  assert.equal(result.code, 1);
  for (const [file, encoding] of Object.entries(expected)) {
    assert.deepEqual(hitsIn(result.hits, file), [{ label: OBS_LABEL, encoding, count: 1 }], file);
  }
  assert.equal(result.hits.length, Object.keys(expected).length);
  assert.ok(
    result.printed.includes(
      `扫描了 ${Object.keys(expected).length} 个文件，共 ${Object.keys(expected).reduce(
        (sum, file) => sum + readFileSync(join(dir, file)).length,
        0,
      )} 字节`,
    ),
  );
  assert.equal(
    result.printed.at(-1),
    `结果：命中 ${result.hits.length} 项，共 ${result.hits.length} 次`,
  );
});

test('JSON 条目只查秘密字段；会话密钥另查解码后的字节、hex 与标准 base64', async () => {
  const dir = files('fields', {
    'fields.log': JSON.stringify({ ...SESSION, channelKey: undefined, obs: OBS_URL, sim: SIM_URL }),
    'key.log': `BELLIS_CHANNEL_KEY=${CHANNEL_KEY}\n`,
    'hex.log': `key <${KEY_BYTES.toString('hex')}>`,
    'std.log': `key=${KEY_BYTES.toString('base64')}`,
    'raw.bin': Buffer.concat([Buffer.from([0, 1, 2]), KEY_BYTES, Buffer.from([3])]),
    'utf16-hex.log': Buffer.from(KEY_BYTES.toString('hex'), 'utf16le'),
  });
  const result = await audit([dir], await fakeStore());
  assert.deepEqual(hitsIn(result.hits, 'fields.log'), []);
  for (const [file, encoding] of [
    ['key.log', '原文'],
    ['hex.log', '解码后 hex'],
    ['std.log', '解码后 base64'],
    ['raw.bin', '解码后的字节'],
    ['utf16-hex.log', 'UTF-16LE 解码后 hex'],
  ] as const) {
    assert.deepEqual(
      hitsIn(result.hits, file),
      [{ label: SESSION_LABEL, encoding, count: 1 }],
      file,
    );
  }
  assert.ok(result.printed.includes(`核对的条目：${OBS_LABEL}、${SESSION_LABEL}、vts`));
  assert.ok(result.printed.includes('跳过的条目：obs-sim（password 字段）：没有此字段，未核对'));
  assert.ok(result.printed.includes('跳过的条目：tts.short：太短，未核对'));
});

test('只有非秘密字段与太短的值出现时没有命中，退出码为 0', async () => {
  const dir = files('clean', {
    'events.log': `${JSON.stringify({ ...SESSION, channelKey: undefined })}\n${OBS_URL}\n${SHORT}\n`,
  });
  const result = await audit([dir], await fakeStore());
  assert.equal(result.code, 0);
  assert.deepEqual(result.hits, []);
  assert.equal(result.printed.at(-1), '结果：没有命中');
});

test('已知条目不是预期的 JSON 时按整个值核对', async () => {
  const store = new MemorySecretStore();
  await store.set(OBS_SECRET, NOT_JSON);
  const dir = files('not-json', { 'a.log': `x${NOT_JSON}x` });
  const result = await audit([dir], store);
  assert.deepEqual(hitsIn(result.hits, 'a.log'), [
    { label: 'obs（整个值：格式不符）', encoding: '原文', count: 1 },
  ]);
});

test('跨块边界的命中都能查到，且只数一次', async () => {
  const dir = files('chunks', {
    'utf8.log': `${VTS_TOKEN}.....${VTS_TOKEN}${VTS_TOKEN}--${VTS_TOKEN}`,
    'utf16.log': Buffer.from(`${VTS_TOKEN}${VTS_TOKEN}`, 'utf16le'),
  });
  const store = new MemorySecretStore();
  await store.set('vts', VTS_TOKEN);
  for (const chunkSize of [1, 2, 5, 13, 23, 64, 1 << 20]) {
    const result = await auditDirect([dir], store, { chunkSize });
    assert.deepEqual(
      hitsIn(result.hits, 'utf8.log'),
      [{ label: 'vts', encoding: '原文', count: 4 }],
      `块大小 ${chunkSize}`,
    );
    assert.deepEqual(
      hitsIn(result.hits, 'utf16.log'),
      [{ label: 'vts', encoding: 'UTF-16LE 原文', count: 2 }],
      `块大小 ${chunkSize}`,
    );
  }
});

test('读取失败：打不开、读到一半出错、路径不存在、条目读不出；已读部分的命中照常报告', async () => {
  const dir = files('failures', {
    'locked.log': VTS_TOKEN,
    'flaky.log': `${VTS_TOKEN}${'.'.repeat(200)}${VTS_TOKEN}`,
    'fine.log': 'nothing here',
  });
  const failing = (code: string) => Object.assign(new Error('模拟失败'), { code });
  const fs: AuditFs = {
    lstat: (path) => fsp.lstat(path),
    readdir: (path) => fsp.readdir(path),
    async open(path, flags) {
      if (basename(path) === 'locked.log') throw failing('EBUSY');
      const handle = await fsp.open(path, flags);
      if (basename(path) !== 'flaky.log') return handle;
      let reads = 0;
      return {
        async read(buffer, offset, length, position) {
          reads++;
          if (reads > 1) throw failing('EIO');
          return handle.read(buffer, offset, length, position);
        },
        close: () => handle.close(),
      };
    },
  };
  const store = new MemorySecretStore();
  await store.set('vts', VTS_TOKEN);
  await store.set('broken', 'never-read-value');
  const brokenStore: SecretStore = {
    names: () => store.names(),
    get: async (name) => {
      if (name === 'broken') throw new Error('模拟失败');
      return store.get(name);
    },
    set: (name, value) => store.set(name, value),
    delete: (name) => store.delete(name),
  };
  const missing = join(root, 'no-such-dir');
  const result = await auditDirect([dir, missing], brokenStore, { fs, chunkSize: 64 });
  assert.equal(result.code, 1);
  assert.deepEqual(hitsIn(result.hits, 'flaky.log'), [
    { label: 'vts', encoding: '原文', count: 1 },
  ]);
  assert.ok(result.printed.includes(`读取失败：${join(dir, 'locked.log')}：EBUSY`));
  assert.ok(result.printed.includes(`读取失败：${join(dir, 'flaky.log')}：EIO`));
  assert.ok(result.printed.includes(`读取失败：${missing}：ENOENT`));
  assert.ok(result.printed.includes('跳过的条目：broken：读取失败（未知错误）'));
  assert.ok(result.printed.includes('扫描了 1 个文件，共 12 字节'));
  assert.equal(
    result.printed.at(-1),
    '结果：命中 1 项，共 1 次；3 个路径读取失败；1 个条目读取失败',
  );
});

test('跳过 node_modules、.git、.venv，不跟随链接；重叠的路径只扫一次', async () => {
  const dir = files('skip', {
    'ok.log': `one ${VTS_TOKEN}`,
    'node_modules/pkg/leak.log': VTS_TOKEN,
    '.git/leak': VTS_TOKEN,
    '.venv/lib/leak.py': VTS_TOKEN,
    'sub/Node_Modules/leak.log': VTS_TOKEN,
    'target/leak.log': VTS_TOKEN,
  });
  // 目录联接在 Windows 上不需要管理员权限；其他平台忽略类型，建的是符号链接。
  symlinkSync(join(dir, 'target'), join(dir, 'link'), 'junction');
  const store = new MemorySecretStore();
  await store.set('vts', VTS_TOKEN);
  const result = await auditDirect([dir, join(dir, 'ok.log'), join(dir, 'target')], store);
  assert.deepEqual(
    result.hits.map((hit) => hit.path),
    [join(dir, 'ok.log'), join(dir, 'target', 'leak.log')],
  );
  assert.ok(result.printed.includes(`未扫描：${join(dir, 'link')}：链接，未跟随`));
  assert.ok(result.printed.includes('扫描了 2 个文件，共 50 字节'));
});

test('输出的路径含值的片段时不显示路径', async () => {
  const dir = files('names', { [`cache-${VTS_TOKEN.slice(2, 12)}.log`]: VTS_TOKEN });
  const store = new MemorySecretStore();
  await store.set('vts', VTS_TOKEN);
  const result = await auditDirect([dir], store);
  assert.deepEqual(result.hits, [{ path: HIDDEN, label: 'vts', encoding: '原文', count: 1 }]);
});

test('缺省位置：reports、config、.bellis 与配置中状态存储的目录（含 -wal、-shm）', async () => {
  const repo = join(root, 'repo');
  const sim = JSON.parse(
    readFileSync(new URL('../../../config/sim.json', import.meta.url), 'utf8'),
  ) as Record<string, unknown>;
  files('repo', {
    'reports/drill.log': `token=${VTS_TOKEN}`,
    '.bellis/live.db-wal': Buffer.concat([
      Buffer.alloc(16),
      Buffer.from(CHANNEL_KEY),
      Buffer.alloc(4),
    ]),
    'config/live.json': JSON.stringify({ ...sim, storePath: '../state/live.db' }),
    // 指向 .bellis/，与固定的缺省位置重复，不再列一遍。
    'config/sim.json': JSON.stringify(sim),
    'config/broken.json': '{',
    'config/profiles/live.json': '{}',
    'state/live.db-shm': JSON.stringify({ password: OBS_PASSWORD }),
    'other/leak.log': VTS_TOKEN,
  });
  assert.deepEqual(defaultAuditLocations(repo), {
    paths: [
      join(repo, 'reports'),
      join(repo, 'config'),
      join(repo, '.bellis'),
      join(repo, 'state'),
    ],
    notes: [`配置无法读取，未据此确定状态存储位置：${join(repo, 'config', 'broken.json')}`],
  });
  const result = await audit([], await fakeStore(), repo);
  assert.equal(result.code, 1);
  assert.deepEqual(
    result.hits.map(({ path, label, encoding }) => [path, label, encoding]),
    [
      [join(repo, 'reports', 'drill.log'), 'vts', '原文'],
      [join(repo, '.bellis', 'live.db-wal'), SESSION_LABEL, '原文'],
      [join(repo, 'state', 'live.db-shm'), OBS_LABEL, 'JSON 转义'],
    ],
  );
  assert.equal(
    result.printed[0],
    `配置无法读取，未据此确定状态存储位置：${join(repo, 'config', 'broken.json')}`,
  );

  const empty = mkdtempSync(join(root, 'empty-'));
  const nothing = await audit([], await fakeStore(), empty);
  assert.equal(nothing.code, 0);
  for (const name of ['reports', 'config', '.bellis']) {
    assert.ok(nothing.printed.includes(`缺省位置不存在：${join(empty, name)}`));
  }
  assert.ok(nothing.printed.includes('扫描了 0 个文件，共 0 字节'));
});

test('相对路径按当前目录解析；不支持选项', async () => {
  files('relative', { 'a.log': VTS_TOKEN });
  const store = new MemorySecretStore();
  await store.set('vts', VTS_TOKEN);
  const result = await audit(['relative'], store);
  assert.deepEqual(
    result.hits.map((hit) => hit.path),
    [join(root, 'relative', 'a.log')],
  );
  for (const args of [['--all'], ['-h'], ['relative', '']]) {
    const usage = await audit(args, store);
    assert.equal(usage.code, 2);
    assert.deepEqual(usage.printed, [SECRET_USAGE]);
  }
});

test('base64 稳定段：值嵌在任意前后缀之间编码时，按前缀长度对 3 取余的那一段一定出现', () => {
  fc.assert(
    fc.property(
      fc.uint8Array({ minLength: 3, maxLength: 40 }),
      fc.uint8Array({ maxLength: 10 }),
      fc.uint8Array({ maxLength: 10 }),
      (value, prefix, suffix) => {
        const whole = Buffer.concat([prefix, value, suffix]);
        for (const alphabet of ['base64', 'base64url'] as const) {
          const parts = base64Stable(Buffer.from(value), alphabet);
          assert.equal(parts.length, 3);
          assert.ok(whole.toString(alphabet).includes(parts[prefix.length % 3] as string));
        }
      },
    ),
  );
});

test('\\u 形式的 JSON 转义与 Python json.dumps 一致：小写 hex，补码点写成两个代理项', () => {
  assert.equal(asciiJson('a😀é"'), 'a\\ud83d\\ude00\\u00e9"');
  assert.equal(asciiJson('plain'), 'plain');
});

test('全部输出里都没有任何值或值的片段', () => {
  assert.ok(everything.length > 0);
  assertNoSecrets(everything);
});
