import assert from 'node:assert/strict';
import { win32 } from 'node:path';
import { test } from 'node:test';
import fc from 'fast-check';
import {
  checkTask,
  currentUserId,
  decodeQueryOutput,
  encodeTaskXml,
  type FieldCheck,
  type LogonTask,
  quoteWindowsArg,
  readTaskXml,
  splitWindowsArgs,
  type TaskFiles,
  taskXml,
} from '../src/task-xml.ts';

const task: LogonTask = {
  userId: 'DESKTOP-1\\leaf',
  command: 'C:\\Program Files\\nodejs\\node.exe',
  args: ['C:\\src\\bellis\\packages\\launcher\\src\\main.ts', 'C:\\src\\bellis\\config\\live.json'],
  workingDirectory: 'C:\\src\\bellis',
  description: 'Bellis 启动器',
};
const expected = {
  userId: task.userId,
  command: task.command,
  entry: task.args[0] as string,
  workingDirectory: task.workingDirectory,
};
const files: TaskFiles = {
  exists: (path) => path === task.args[1],
  canonical: (path) => win32.normalize(path).toLowerCase(),
};

const verdicts = (checks: FieldCheck[]) =>
  new Map(checks.map((check) => [check.label, check.verdict]));

test('只针对当前用户的登录触发器、交互令牌、最低权限与各项设置', () => {
  const xml = taskXml(task);
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-16"?>\n'));
  assert.match(
    xml,
    /<Task version="1\.2" xmlns="http:\/\/schemas\.microsoft\.com\/windows\/2004\/02\/mit\/task">/,
  );
  for (const line of [
    '<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
    '<Priority>5</Priority>',
    '<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '<AllowStartOnDemand>true</AllowStartOnDemand>',
    '<Actions Context="Author">',
    '<Principal id="Author">',
  ]) {
    assert.ok(xml.includes(line), line);
  }
  assert.ok(!xml.includes('\r'));

  const read = readTaskXml(xml);
  assert.deepEqual(read.triggers, [{ type: 'LogonTrigger', enabled: 'true', userId: task.userId }]);
  assert.deepEqual(read.principal, {
    userId: task.userId,
    logonType: 'InteractiveToken',
    runLevel: 'LeastPrivilege',
  });
  assert.deepEqual(read.actions, [
    {
      type: 'Exec',
      command: '"C:\\Program Files\\nodejs\\node.exe"',
      arguments:
        '"C:\\src\\bellis\\packages\\launcher\\src\\main.ts" "C:\\src\\bellis\\config\\live.json"',
      workingDirectory: 'C:\\src\\bellis',
    },
  ]);
  assert.deepEqual(read.settings, {
    enabled: 'true',
    executionTimeLimit: 'PT0S',
    priority: '5',
    multipleInstancesPolicy: 'IgnoreNew',
  });

  const checks = checkTask(read, expected, files);
  assert.ok(
    checks.every((check) => check.verdict === 'ok'),
    JSON.stringify(checks),
  );
});

test('插值一律做 XML 转义，读回得到原值', () => {
  const odd: LogonTask = {
    ...task,
    userId: "R&D-PC\\o'neil",
    args: ["C:\\R&D <x>\\it's\\main.ts", 'C:\\R&D <x>\\配置.json'],
    workingDirectory: 'C:\\R&D <x>',
    description: 'a < b & "c"',
  };
  const xml = taskXml(odd);
  assert.ok(!xml.includes('R&D-'));
  assert.ok(!xml.includes('<x>'));
  assert.ok(xml.includes('R&amp;D-PC\\o&apos;neil'));
  assert.ok(xml.includes('a &lt; b &amp; &quot;c&quot;'));
  const read = readTaskXml(xml);
  assert.equal(read.triggers[0]?.userId, odd.userId);
  assert.equal(read.principal.userId, odd.userId);
  assert.deepEqual(splitWindowsArgs(read.actions[0]?.arguments ?? ''), odd.args);
  assert.equal(read.actions[0]?.workingDirectory, odd.workingDirectory);
});

test('当前用户取不到或不合规时报错，不放宽成任意用户', () => {
  assert.equal(currentUserId('leaf', 'DESKTOP-1'), 'DESKTOP-1\\leaf');
  assert.equal(currentUserId('小叶', 'WORKGROUP-PC'), 'WORKGROUP-PC\\小叶');
  for (const [username, domain] of [
    ['leaf', undefined],
    ['leaf', ''],
    ['leaf', '  '],
    [undefined, 'DESKTOP-1'],
    ['', 'DESKTOP-1'],
    ['a\\b', 'DESKTOP-1'],
    ['leaf', 'DOMAIN\\X'],
    ['leaf', 'D/X'],
    ['le\naf', 'DESKTOP-1'],
  ] as const) {
    assert.throws(() => currentUserId(username, domain), /取不到当前用户/);
  }
});

test('用户或动作里的路径不合规时报错', () => {
  const cases: Array<[Partial<LogonTask>, RegExp]> = [
    [{ userId: '' }, /不是“域\\用户名”的形式/],
    [{ userId: 'leaf' }, /不是“域\\用户名”的形式/],
    [{ userId: 'A\\B\\leaf' }, /不是“域\\用户名”的形式/],
    [{ command: 'node.exe' }, /可执行文件不是绝对路径/],
    [{ workingDirectory: 'bellis' }, /工作目录不是绝对路径/],
    [{ args: ['C:\\%USERPROFILE%\\main.ts'] }, /含 %/],
    [{ command: 'C:\\a"b\\node.exe' }, /含引号/],
    [{ args: ['C:\\a"b'] }, /含引号/],
    [{ args: [''] }, /参数为空/],
    [{ workingDirectory: 'C:\\a\tb' }, /控制字符/],
    [{ userId: 'PC\\a\u0000' }, /控制字符/],
    [{ description: '\ud800' }, /控制字符/],
  ];
  for (const [patch, error] of cases) assert.throws(() => taskXml({ ...task, ...patch }), error);
});

test('参数的 Windows 命令行写法可逆：空格、结尾反斜杠、中文', () => {
  assert.equal(quoteWindowsArg('C:\\Program Files\\x'), '"C:\\Program Files\\x"');
  assert.equal(quoteWindowsArg('C:\\dir\\'), '"C:\\dir\\\\"');
  assert.throws(() => quoteWindowsArg('a"b'), /引号/);
  assert.deepEqual(splitWindowsArgs('  a  "b c"\t"" d\\\\"e f"  '), ['a', 'b c', '', 'd\\e f']);
  assert.deepEqual(splitWindowsArgs('a\\"b "c\\\\\\"d"'), ['a"b', 'c\\"d']);
  fc.assert(
    fc.property(
      fc.array(fc.string({ unit: fc.constantFrom('a', ' ', '\\', '中', '\t', 'x') }), {
        maxLength: 6,
      }),
      (args) => {
        assert.deepEqual(splitWindowsArgs(args.map(quoteWindowsArg).join(' ')), args);
      },
    ),
  );
});

test('任务文件按 UTF-16 LE 带 BOM 编码；读回按 BOM、UTF-16、UTF-8 识别', () => {
  const xml = taskXml({ ...task, workingDirectory: 'C:\\用户\\bellis' });
  const encoded = encodeTaskXml(xml);
  assert.deepEqual([...encoded.subarray(0, 2)], [0xff, 0xfe]);
  assert.equal(encoded.length, 2 + xml.length * 2);
  assert.equal(decodeQueryOutput(encoded), xml);
  assert.equal(decodeQueryOutput(Buffer.from(xml, 'utf16le')), xml);
  assert.equal(decodeQueryOutput(Buffer.from(xml, 'utf8')), xml);
  assert.equal(
    decodeQueryOutput(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(xml)])),
    xml,
  );
  // 按本地代码页（例如 GBK）输出的非 ASCII 字节：不猜，报错。
  assert.throws(
    () => decodeQueryOutput(Buffer.from([0x3c, 0x54, 0xd3, 0xc3, 0xbb, 0xa7, 0x3e])),
    /既不是 UTF-16 也不是 UTF-8/,
  );
});

test('读回核对：任意用户、SID、多余的触发器、缺省设置与不存在的配置文件', () => {
  const xml = taskXml(task);
  const check = (edit: (xml: string) => string) =>
    verdicts(checkTask(readTaskXml(edit(xml)), expected, files));

  const anyone = check((x) =>
    x.replace(`<UserId>${task.userId}</UserId>\n    </LogonTrigger>`, '</LogonTrigger>'),
  );
  assert.equal(anyone.get('触发器用户'), 'mismatch');
  assert.equal(anyone.get('运行用户'), 'ok');

  const sid = check((x) => x.replaceAll(task.userId, 'S-1-5-21-1-2-3-1001'));
  assert.equal(sid.get('触发器用户'), 'unverified');
  assert.equal(sid.get('运行用户'), 'unverified');

  assert.equal(check((x) => x.replace(task.userId, 'desktop-1\\LEAF')).get('触发器用户'), 'ok');
  assert.equal(check((x) => x.replace(task.userId, 'OTHER\\leaf')).get('触发器用户'), 'mismatch');

  const extra = check((x) =>
    x.replace('</Triggers>', '  <TimeTrigger><Enabled>true</Enabled></TimeTrigger>\n  </Triggers>'),
  );
  assert.equal(extra.get('触发器'), 'mismatch');
  assert.equal(
    check((x) => x.replace('<Enabled>true</Enabled>', '<Enabled>false</Enabled>')).get('触发器'),
    'mismatch',
  );

  const defaults = check((x) =>
    x
      .replace(/ *<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>\n/, '')
      .replace(/ *<Priority>5<\/Priority>\n/, '')
      .replace(/ *<RunLevel>LeastPrivilege<\/RunLevel>\n/, ''),
  );
  assert.equal(defaults.get('执行时限'), 'mismatch');
  assert.equal(defaults.get('优先级'), 'mismatch');
  assert.equal(defaults.get('运行级别'), 'ok');
  assert.equal(check((x) => x.replace('<Priority>5', '<Priority>4')).get('优先级'), 'ok');
  assert.equal(check((x) => x.replace('InteractiveToken', 'Password')).get('登录类型'), 'mismatch');
  assert.equal(
    check((x) => x.replace('LeastPrivilege', 'HighestAvailable')).get('运行级别'),
    'mismatch',
  );
  assert.equal(check((x) => x.replace('IgnoreNew', 'Parallel')).get('多实例'), 'mismatch');

  const moved = check((x) => x.replaceAll('C:\\src\\bellis', 'D:\\bellis'));
  assert.equal(moved.get('启动器'), 'mismatch');
  assert.equal(moved.get('配置文件'), 'mismatch');
  assert.equal(moved.get('工作目录'), 'mismatch');
  assert.equal(moved.get('命令'), 'ok');
  assert.equal(check((x) => x.replace('C:\\Program Files', 'c:\\PROGRAM FILES')).get('命令'), 'ok');
  assert.equal(
    check((x) => x.replace('live.json&quot;', 'live.json&quot; &quot;x&quot;')).get('配置文件'),
    'mismatch',
  );

  assert.throws(() => readTaskXml('<Other/>'), /不是任务 XML/);
});
