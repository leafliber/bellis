import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OperatorMethod } from '@bellis/protocol';
import {
  browserCommand,
  OPERATOR_USAGE,
  openBrowser,
  parseOperatorArgs,
  runOperatorCommand,
} from '../src/operator-command.ts';

const TOKEN = 'Abc_def-0123456789abcdefghijklmnopqrstuvwxy';
const LOGIN = { url: 'http://127.0.0.1:54321/', token: TOKEN, expiresInMs: 60_000 };

function fake(options: { reply?: unknown; openFails?: boolean } = {}) {
  const requests: Array<[string, Record<string, unknown>]> = [];
  const opened: string[] = [];
  const printed: string[] = [];
  return {
    requests,
    opened,
    printed,
    io: {
      async request(method: string, params: Record<string, unknown>) {
        requests.push([method, params]);
        return options.reply ?? { ok: true };
      },
      async open(url: string) {
        opened.push(url);
        if (options.openFails) throw new Error('spawn xdg-open ENOENT');
      },
      print: (line: string) => printed.push(line),
    },
  };
}

test('参数：release 与 veto 可带一个句键；console 不带参数；用法不对时为 undefined', () => {
  assert.deepEqual(parseOperatorArgs(['release']), {
    kind: 'call',
    method: OperatorMethod.Release,
    params: {},
  });
  assert.deepEqual(parseOperatorArgs(['release', 'u1#0']), {
    kind: 'call',
    method: OperatorMethod.Release,
    params: { key: 'u1#0' },
  });
  assert.deepEqual(parseOperatorArgs(['veto', 'u1#0']), {
    kind: 'call',
    method: OperatorMethod.Veto,
    params: { key: 'u1#0' },
  });
  assert.deepEqual(parseOperatorArgs(['console']), { kind: 'console' });
  assert.deepEqual(parseOperatorArgs(['preflight', 'M2']), {
    kind: 'call',
    method: OperatorMethod.Preflight,
    params: { target: 'M2' },
  });
  assert.deepEqual(parseOperatorArgs(['mode', 'M1']), {
    kind: 'call',
    method: OperatorMethod.Mode,
    params: { target: 'M1' },
  });
  assert.deepEqual(parseOperatorArgs(['estop']), {
    kind: 'call',
    method: OperatorMethod.EmergencyStop,
    params: { reason: '操作员急停' },
  });
  assert.deepEqual(parseOperatorArgs(['estop', '画面', '不对']), {
    kind: 'call',
    method: OperatorMethod.EmergencyStop,
    params: { reason: '画面 不对' },
  });
  for (const args of [
    [],
    ['nope'],
    ['release', 'a#0', 'b#0'],
    ['veto', 'a#0', 'b#0'],
    ['console', 'x'],
    ['mode'],
    ['mode', 'M1', 'M2'],
    ['status', 'x'],
  ]) {
    assert.equal(parseOperatorArgs(args), undefined, JSON.stringify(args));
  }
  assert.match(OPERATOR_USAGE, /release \[句键\]/);
  assert.match(OPERATOR_USAGE, /console/);
});

test('release：经本机通道调 operator.release，把结果原样打印成 JSON', async () => {
  const f = fake({ reply: { ok: true, released: ['u1#0'] } });
  assert.equal(await runOperatorCommand(['release', 'u1#0'], f.io), 0);
  assert.deepEqual(f.requests, [[OperatorMethod.Release, { key: 'u1#0' }]]);
  assert.deepEqual(JSON.parse(f.printed.join('\n')), { ok: true, released: ['u1#0'] });
});

test('用法不对时打印用法，退出码 2，不连宿主', async () => {
  const f = fake();
  assert.equal(await runOperatorCommand(['release', 'a', 'b'], f.io), 2);
  assert.deepEqual(f.printed, [OPERATOR_USAGE]);
  assert.deepEqual(f.requests, []);
});

test('console：取一次性令牌，用浏览器打开 地址#令牌；成功时输出里没有令牌', async () => {
  const f = fake({ reply: LOGIN });
  assert.equal(await runOperatorCommand(['console'], f.io), 0);
  assert.deepEqual(f.requests, [[OperatorMethod.ConsoleLogin, {}]]);
  assert.deepEqual(f.opened, [`http://127.0.0.1:54321/#${TOKEN}`]);
  const output = f.printed.join('\n');
  assert.ok(!output.includes(TOKEN));
  assert.match(output, /http:\/\/127\.0\.0\.1:54321\//);
  assert.match(output, /60 秒内有效、只能用一次/);
});

test('console：打不开浏览器时打印带令牌的地址，并提示只能用一次、很快过期', async () => {
  const f = fake({ reply: LOGIN, openFails: true });
  assert.equal(await runOperatorCommand(['console'], f.io), 0);
  assert.equal(f.printed[1], `http://127.0.0.1:54321/#${TOKEN}`);
  assert.match(f.printed[0] ?? '', /没能打开浏览器（spawn xdg-open ENOENT）/);
  assert.match(f.printed[2] ?? '', /只能用一次，60 秒内有效/);
});

test('console：宿主给的不是合法的登录令牌时不打开浏览器，打印结果并以 1 退出', async () => {
  for (const reply of [
    { ok: false, reason: '操作台没有启动' },
    { ...LOGIN, url: 'http://localhost:54321/' },
    { ...LOGIN, url: 'http://127.0.0.1:54321/x' },
    { ...LOGIN, token: 'short' },
    { ...LOGIN, token: `${TOKEN}" & calc` },
  ]) {
    const f = fake({ reply });
    assert.equal(await runOperatorCommand(['console'], f.io), 1, JSON.stringify(reply));
    assert.deepEqual(f.opened, []);
  }
});

test('打开命令不存在或以非零退出码结束时算打不开', async () => {
  const url = 'http://127.0.0.1:1/#x';
  await assert.rejects(openBrowser(url, 10_000, ['bellis-no-such-browser-command', [url]]));
  await assert.rejects(
    openBrowser(url, 10_000, [process.execPath, ['-e', 'process.exit(3)']]),
    /退出码 3/,
  );
  await openBrowser(url, 10_000, [process.execPath, ['-e', '']]);
});

test('各平台自带的打开方式，都不经 shell', () => {
  const url = `http://127.0.0.1:1/#${TOKEN}`;
  assert.deepEqual(browserCommand(url, 'win32'), [
    'rundll32.exe',
    ['url.dll,FileProtocolHandler', url],
  ]);
  assert.deepEqual(browserCommand(url, 'darwin'), ['open', [url]]);
  assert.deepEqual(browserCommand(url, 'linux'), ['xdg-open', [url]]);
});
