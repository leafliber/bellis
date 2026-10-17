import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  type AutostartContext,
  runAutostartCommand,
  type Schtasks,
  schtasksPath,
  spawnSchtasks,
} from '../src/autostart-command.ts';
import {
  decodeQueryOutput,
  encodeTaskXml,
  readTaskXml,
  splitWindowsArgs,
} from '../src/task-xml.ts';

const repoRoot = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const entry = fileURLToPath(new URL('../src/main.ts', import.meta.url));
const simConfig = realpathSync.native(join(repoRoot, 'config', 'sim.json'));
const USER = 'TESTPC\\tester';

interface Call {
  args: string[];
  capture: boolean;
  /** /Create 时任务文件的内容与路径（调用当时读取）。 */
  file?: { path: string; bytes: Buffer };
}

/** 假的计划任务程序：记下每次调用的参数，按 /Create、/Delete、/Query 维护一个任务。从不运行真实的 schtasks。 */
class FakeScheduler {
  readonly calls: Call[] = [];
  task: string | undefined;
  /** 让某个子命令以退出码 1 失败。 */
  readonly failing = new Set<string>();
  /** /Query /XML 的输出编码。 */
  encode: (xml: string) => Uint8Array = encodeTaskXml;

  readonly run: Schtasks = async (args, { capture }) => {
    const call: Call = { args: [...args], capture };
    this.calls.push(call);
    const [command] = args;
    const fail = { code: 1, stdout: new Uint8Array() };
    const ok = (stdout: Uint8Array = new Uint8Array()) => ({ code: 0, stdout });
    if (command && this.failing.has(command)) return fail;
    if (command === '/Create') {
      const path = args[args.indexOf('/XML') + 1] as string;
      call.file = { path, bytes: readFileSync(path) };
      this.task = decodeQueryOutput(call.file.bytes);
      return ok();
    }
    if (command === '/Delete') {
      if (this.task === undefined) return fail;
      this.task = undefined;
      return ok();
    }
    if (command === '/Query') return this.task === undefined ? fail : ok(this.encode(this.task));
    return fail;
  };
}

function setup(overrides: Partial<AutostartContext> = {}) {
  const scheduler = new FakeScheduler();
  const printed: string[] = [];
  const context: AutostartContext = {
    platform: 'win32',
    schtasks: scheduler.run,
    print: (line) => printed.push(line),
    currentUser: () => USER,
    launcher: { node: process.execPath, entry, root: repoRoot },
    cwd: repoRoot,
    defaultConfig: join(tmpdir(), 'bellis-autostart-test-missing', 'live.json'),
    ...overrides,
  };
  return {
    scheduler,
    printed,
    run: (...args: string[]) => runAutostartCommand(args, context),
  };
}

test('注册：任务文件 UTF-16 LE 带 BOM、用完即删，参数正确，随后读回核对', async () => {
  const { scheduler, printed, run } = setup();
  assert.equal(await run('register', 'config/sim.json'), 0);
  assert.equal(scheduler.calls.length, 2);
  const [create, query] = scheduler.calls as [Call, Call];
  assert.deepEqual(create.args, ['/Create', '/TN', 'Bellis', '/XML', create.file?.path, '/F']);
  assert.equal(create.capture, false);
  assert.deepEqual(query.args, ['/Query', '/TN', 'Bellis', '/XML']);
  assert.equal(query.capture, true);

  const file = create.file as { path: string; bytes: Buffer };
  assert.deepEqual([...file.bytes.subarray(0, 2)], [0xff, 0xfe]);
  assert.equal(realpathSync.native(dirname(dirname(file.path))), realpathSync.native(tmpdir()));
  assert.ok(!existsSync(file.path));
  assert.ok(!existsSync(dirname(file.path)));

  const task = readTaskXml(decodeQueryOutput(file.bytes));
  assert.deepEqual(
    task.triggers.map((trigger) => [trigger.type, trigger.userId]),
    [['LogonTrigger', USER]],
  );
  assert.equal(task.principal.userId, USER);
  const exec = task.actions[0];
  assert.equal(exec?.command, `"${process.execPath}"`);
  assert.deepEqual(splitWindowsArgs(exec?.arguments ?? ''), [entry, simConfig]);
  assert.equal(exec?.workingDirectory, repoRoot);

  assert.ok(printed[0]?.startsWith(`已注册计划任务 Bellis：${USER} 登录时运行启动器`));
  assert.ok(printed.includes(`  配置文件：${simConfig}`));
  assert.equal(printed.at(-1), '各项一致');
});

test('注册：配置文件缺失、不存在或不合法时报错，不调用 schtasks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bellis-autostart-test-'));
  try {
    const invalid = join(dir, 'invalid.json');
    const broken = join(dir, 'broken.json');
    writeFileSync(invalid, '{}');
    writeFileSync(broken, '{');
    for (const [args, message] of [
      [['register'], /配置文件不存在或无法访问：.*live\.json/],
      [['register', join(dir, 'nope.json')], /配置文件不存在或无法访问/],
      [['register', dir], /配置文件不是文件/],
      [['register', invalid], /不合法/],
      [['register', broken], /不是合法的 JSON/],
    ] as const) {
      const { scheduler, printed, run } = setup();
      assert.equal(await run(...args), 1);
      assert.match(printed.join('\n'), message);
      assert.equal(scheduler.calls.length, 0);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('注册：取不到当前用户时报错，不调用 schtasks', async () => {
  const { scheduler, printed, run } = setup({
    currentUser: () => {
      throw new Error('取不到当前用户');
    },
  });
  assert.equal(await run('register', simConfig), 1);
  assert.deepEqual(printed, ['取不到当前用户']);
  assert.equal(scheduler.calls.length, 0);
});

test('注册：schtasks 失败只看退出码；任务文件照样删除', async () => {
  const { scheduler, printed, run } = setup();
  scheduler.failing.add('/Create');
  assert.equal(await run('register', simConfig), 1);
  assert.deepEqual(printed, ['注册失败：schtasks 退出码 1']);
  assert.equal(scheduler.calls.length, 1);
  const path = scheduler.calls[0]?.args[4] as string;
  assert.ok(!existsSync(dirname(path)));
});

test('注册：读回与预期不一致时报告并返回失败', async () => {
  const { scheduler, printed, run } = setup();
  // 读回的登录触发器没有 UserId，即任意用户登录时都会运行。
  scheduler.encode = (xml) =>
    encodeTaskXml(xml.replace(/\s*<UserId>[^<]*<\/UserId>(\s*<\/LogonTrigger>)/, '$1'));
  assert.equal(await run('register', simConfig), 1);
  assert.ok(printed.includes(`  触发器用户：（任意用户）（不一致：应为 ${USER}）`));
  assert.equal(
    printed.at(-1),
    '已注册，但读回核对未通过，可用 pnpm autostart unregister 注销：1 项不一致',
  );
});

test('查看：读回的 XML 按 UTF-16 或 UTF-8 解码；读回为 SID 时记为未核对', async () => {
  const { scheduler, printed, run } = setup();
  assert.equal(await run('register', simConfig), 0);
  printed.length = 0;
  scheduler.encode = (xml) => Buffer.from(xml, 'utf8');
  assert.equal(await run('status'), 0);
  assert.equal(printed[0], '计划任务 Bellis：');
  assert.equal(printed.at(-1), '各项一致');

  printed.length = 0;
  scheduler.encode = (xml) =>
    encodeTaskXml(
      xml.replace(/(<Principal id="Author">\s*<UserId>)[^<]*/, '$1S-1-5-21-1-2-3-1001'),
    );
  assert.equal(await run('status'), 0);
  assert.ok(printed.includes('  运行用户：S-1-5-21-1-2-3-1001（未核对：读回为 SID）'));
  assert.equal(printed.at(-1), '其余各项一致，1 项未核对');

  printed.length = 0;
  scheduler.encode = () => Buffer.from([0x3c, 0xd3, 0xc3, 0x3e]);
  assert.equal(await run('status'), 1);
  assert.match(printed.join('\n'), /既不是 UTF-16 也不是 UTF-8/);
});

test('查看与注销：参数与退出码', async () => {
  const { scheduler, printed, run } = setup();
  assert.equal(await run('status'), 1);
  assert.deepEqual(printed, ['没有读到计划任务 Bellis：schtasks 退出码 1（任务可能未注册）']);
  assert.equal(await run('unregister'), 1);
  assert.equal(printed.at(-1), '注销失败：schtasks 退出码 1（任务可能不存在）');

  assert.equal(await run('register', simConfig), 0);
  scheduler.calls.length = 0;
  assert.equal(await run('unregister'), 0);
  assert.deepEqual(scheduler.calls, [{ args: ['/Delete', '/TN', 'Bellis', '/F'], capture: false }]);
  assert.equal(printed.at(-1), '已注销计划任务 Bellis');
  assert.equal(await run('status'), 1);
});

test('非 Windows 平台报告 unsupported；用法错误返回 2', async () => {
  for (const platform of ['darwin', 'linux'] as const) {
    const { scheduler, printed, run } = setup({ platform });
    for (const args of [['register', simConfig], ['unregister'], ['status']]) {
      assert.equal(await run(...args), 1);
    }
    assert.equal(scheduler.calls.length, 0);
    assert.deepEqual(
      new Set(printed),
      new Set([`计划任务只在 Windows 上可用，当前平台 ${platform} 不支持（unsupported）`]),
    );
  }
  const { scheduler, printed, run } = setup();
  for (const args of [
    [],
    ['start'],
    ['register', 'a', 'b'],
    ['status', 'x'],
    ['unregister', 'x'],
  ]) {
    assert.equal(await run(...args), 2);
  }
  assert.equal(scheduler.calls.length, 0);
  assert.ok(printed.every((line) => line.startsWith('用法：autostart')));
});

test('schtasks.exe 的路径取自 SystemRoot', () => {
  assert.equal(schtasksPath({ SystemRoot: 'C:\\Windows' }), 'C:\\Windows\\System32\\schtasks.exe');
  assert.equal(schtasksPath({ SYSTEMROOT: 'D:\\Win' }), 'D:\\Win\\System32\\schtasks.exe');
  assert.throws(() => schtasksPath({}), /SystemRoot/);
});

test('执行器：spawn 后只按退出码报告，按需收集标准输出（用 node 代替 schtasks）', async () => {
  const node = spawnSchtasks(() => process.execPath);
  assert.deepEqual(
    await node(['-e', "process.stdout.write('读回'); process.exitCode = 3"], { capture: true }),
    { code: 3, stdout: Buffer.from('读回') },
  );
  assert.deepEqual(await node(['-e', ''], { capture: false }), {
    code: 0,
    stdout: Buffer.alloc(0),
  });
  await assert.rejects(
    spawnSchtasks(() => join(tmpdir(), 'bellis-no-such-schtasks.exe'))([], { capture: true }),
    /ENOENT/,
  );
  await assert.rejects(spawnSchtasks(() => schtasksPath({}))([], { capture: true }), /SystemRoot/);
});
