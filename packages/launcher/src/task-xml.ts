/**
 * “登录时运行”计划任务的 XML（R-23、R-26）：生成、编码与读回核对，全是纯函数，不调用 schtasks。
 * 用 Task Scheduler 1.2 的 schema；读回只认 schtasks 导出的任务 XML，不是通用的 XML 解析器。
 */
import { win32 } from 'node:path';

const TASK_NAMESPACE = 'http://schemas.microsoft.com/windows/2004/02/mit/task';
/** 普通优先级（4–6）；缺省的 7 低于普通，启动器拉起的宿主与看门狗会继承。 */
export const TASK_PRIORITY = 5;

export interface LogonTask {
  /** 登录触发器与运行身份的用户，形如 `域\用户名`（见 `currentUserId`）。 */
  userId: string;
  /** 可执行文件的绝对路径。 */
  command: string;
  /** 参数，逐个按 Windows 命令行规则加引号。 */
  args: readonly string[];
  /** 工作目录的绝对路径。 */
  workingDirectory: string;
  description: string;
}

/**
 * 当前用户，形如 `域\用户名`：登录触发器只针对这个用户（R-26）。
 * 本地账户的域是计算机名。取不到时报错，不放宽成“任意用户登录时”。
 */
export function currentUserId(username: string | undefined, domain: string | undefined): string {
  const usable = (part: string | undefined): part is string =>
    part !== undefined && part.trim() !== '' && !/[\\/]|\p{Cc}/u.test(part);
  if (!usable(domain) || !usable(username))
    throw new Error('取不到当前用户（USERDOMAIN 与用户名），无法把登录触发器限定为当前用户');
  return `${domain}\\${username}`;
}

/** 生成任务 XML。路径不合规（相对路径、含 `%` `"` 或控制字符）时报错。 */
export function taskXml(task: LogonTask): string {
  checkText('用户', task.userId);
  // 空的或不带域的用户会让触发器的含义变得不确定；只接受 `域\用户名`。
  if (!/^[^\\]+\\[^\\]+$/.test(task.userId))
    throw new Error(`用户不是“域\\用户名”的形式：${task.userId}`);
  checkText('任务说明', task.description);
  for (const [label, path] of [
    ['可执行文件', task.command],
    ['工作目录', task.workingDirectory],
  ] as const) {
    checkExecField(label, path);
    if (!win32.isAbsolute(path)) throw new Error(`${label}不是绝对路径：${path}`);
  }
  for (const arg of task.args) checkExecField('参数', arg);
  const exec = {
    command: quoteWindowsArg(task.command),
    args: task.args.map(quoteWindowsArg).join(' '),
  };
  return `${[
    '<?xml version="1.0" encoding="UTF-16"?>',
    `<Task version="1.2" xmlns="${TASK_NAMESPACE}">`,
    '  <RegistrationInfo>',
    `    <Description>${escapeXml(task.description)}</Description>`,
    '  </RegistrationInfo>',
    '  <Triggers>',
    '    <LogonTrigger>',
    '      <Enabled>true</Enabled>',
    `      <UserId>${escapeXml(task.userId)}</UserId>`,
    '    </LogonTrigger>',
    '  </Triggers>',
    '  <Principals>',
    '    <Principal id="Author">',
    `      <UserId>${escapeXml(task.userId)}</UserId>`,
    '      <LogonType>InteractiveToken</LogonType>',
    '      <RunLevel>LeastPrivilege</RunLevel>',
    '    </Principal>',
    '  </Principals>',
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <StartWhenAvailable>false</StartWhenAvailable>',
    '    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>',
    '    <AllowStartOnDemand>true</AllowStartOnDemand>',
    '    <Enabled>true</Enabled>',
    '    <Hidden>false</Hidden>',
    '    <RunOnlyIfIdle>false</RunOnlyIfIdle>',
    '    <WakeToRun>false</WakeToRun>',
    '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
    `    <Priority>${TASK_PRIORITY}</Priority>`,
    '  </Settings>',
    '  <Actions Context="Author">',
    '    <Exec>',
    `      <Command>${escapeXml(exec.command)}</Command>`,
    `      <Arguments>${escapeXml(exec.args)}</Arguments>`,
    `      <WorkingDirectory>${escapeXml(task.workingDirectory)}</WorkingDirectory>`,
    '    </Exec>',
    '  </Actions>',
    '</Task>',
  ].join('\n')}\n`;
}

/**
 * 交给 `schtasks /Create /XML` 的文件内容：UTF-16 LE 带 BOM，与 XML 声明一致。
 * 按社区经验选的编码，真机能否被接受为 PENDING（R-26）。
 */
export function encodeTaskXml(xml: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]);
}

/**
 * 解码 `schtasks /Query /XML` 的标准输出。输出编码未经真机确认（PENDING）：
 * 按 BOM、UTF-16 LE 的零字节特征、UTF-8 依次识别，都不是时报错，不猜代码页。
 */
export function decodeQueryOutput(bytes: Uint8Array): string {
  const starts = (...prefix: number[]) => prefix.every((byte, i) => bytes[i] === byte);
  if (starts(0xff, 0xfe)) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (starts(0xfe, 0xff)) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  if (starts(0xef, 0xbb, 0xbf)) return decodeUtf8(bytes.subarray(3));
  if (bytes.length >= 2 && bytes[0] !== 0 && bytes[1] === 0)
    return new TextDecoder('utf-16le').decode(bytes);
  return decodeUtf8(bytes);
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('读回的任务 XML 既不是 UTF-16 也不是 UTF-8，无法核对');
  }
}

/** 一个参数的 Windows 命令行写法（与 Node 解析 argv 的规则一致）：总加引号，结尾的反斜杠加倍。 */
export function quoteWindowsArg(arg: string): string {
  if (arg.includes('"')) throw new Error(`参数含引号：${arg}`);
  const trailing = /\\*$/.exec(arg)?.[0].length ?? 0;
  return `"${arg}${'\\'.repeat(trailing)}"`;
}

/** 按 Windows 命令行规则拆分参数，是 `quoteWindowsArg` 的逆运算。 */
export function splitWindowsArgs(line: string): string[] {
  const args: string[] = [];
  let current = '';
  let quoted = false;
  let started = false;
  let i = 0;
  while (i < line.length) {
    const char = line[i] as string;
    if (char === '\\') {
      let count = 0;
      while (line[i] === '\\') {
        count++;
        i++;
      }
      if (line[i] === '"') {
        // 2n 个反斜杠加引号：n 个反斜杠，引号照常处理；2n+1 个：n 个反斜杠加一个字面引号。
        current += '\\'.repeat(count >> 1);
        if (count % 2 === 1) {
          current += '"';
          i++;
        }
      } else {
        current += '\\'.repeat(count);
      }
      started = true;
    } else if (char === '"') {
      quoted = !quoted;
      started = true;
      i++;
    } else if (!quoted && (char === ' ' || char === '\t')) {
      if (started) args.push(current);
      current = '';
      started = false;
      i++;
    } else {
      current += char;
      started = true;
      i++;
    }
  }
  if (started) args.push(current);
  return args;
}

export function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function unescapeXml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (entity, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      return String.fromCodePoint(code);
    }
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    return named[body] ?? entity;
  });
}

/** XML 里放不下的字符（控制字符、孤立代理项）直接报错，不静默替换。 */
function checkText(label: string, text: string): void {
  if (/\p{Cc}/u.test(text) || !text.isWellFormed())
    throw new Error(`${label}含有控制字符或无效字符：${text}`);
}

/** 计划任务会展开动作里的 `%变量%`；引号会破坏命令行。这两种字符一律拒绝。 */
function checkExecField(label: string, text: string): void {
  checkText(label, text);
  if (text === '') throw new Error(`${label}为空`);
  if (text.includes('%')) throw new Error(`${label}含 %，计划任务会把它当作环境变量展开：${text}`);
  if (text.includes('"')) throw new Error(`${label}含引号：${text}`);
}

/** 读回的任务中与核对有关的字段；元素缺失时为 undefined。 */
export interface TaskReadback {
  triggers: Array<{ type: string; enabled: string | undefined; userId: string | undefined }>;
  principal: {
    userId: string | undefined;
    logonType: string | undefined;
    runLevel: string | undefined;
  };
  actions: Array<{
    type: string;
    command: string | undefined;
    arguments: string | undefined;
    workingDirectory: string | undefined;
  }>;
  settings: {
    enabled: string | undefined;
    executionTimeLimit: string | undefined;
    priority: string | undefined;
    multipleInstancesPolicy: string | undefined;
  };
}

const ELEMENT = /<([A-Za-z][\w.-]*)(?:\s[^>]*?)?(?:\/>|>([\s\S]*?)<\/\1\s*>)/g;

interface Element {
  name: string;
  inner: string;
}

/** 依次列出顶层元素；同名元素不嵌套，足以读 schtasks 导出的任务 XML。 */
function children(xml: string | undefined): Element[] {
  if (xml === undefined) return [];
  return Array.from(xml.matchAll(ELEMENT), (match) => ({
    name: match[1] as string,
    inner: match[2] ?? '',
  }));
}

function child(xml: string | undefined, name: string): string | undefined {
  return children(xml).find((element) => element.name === name)?.inner;
}

function text(xml: string | undefined, name: string): string | undefined {
  const inner = child(xml, name);
  return inner === undefined ? undefined : unescapeXml(inner.trim());
}

export function readTaskXml(xml: string): TaskReadback {
  const task = child(xml, 'Task');
  if (task === undefined) throw new Error('读回的内容不是任务 XML');
  const principal = child(child(task, 'Principals'), 'Principal');
  const settings = child(task, 'Settings');
  return {
    triggers: children(child(task, 'Triggers')).map((trigger) => ({
      type: trigger.name,
      enabled: text(trigger.inner, 'Enabled'),
      userId: text(trigger.inner, 'UserId'),
    })),
    principal: {
      userId: text(principal, 'UserId'),
      logonType: text(principal, 'LogonType'),
      runLevel: text(principal, 'RunLevel'),
    },
    actions: children(child(task, 'Actions')).map((action) => ({
      type: action.name,
      command: text(action.inner, 'Command'),
      arguments: text(action.inner, 'Arguments'),
      workingDirectory: text(action.inner, 'WorkingDirectory'),
    })),
    settings: {
      enabled: text(settings, 'Enabled'),
      executionTimeLimit: text(settings, 'ExecutionTimeLimit'),
      priority: text(settings, 'Priority'),
      multipleInstancesPolicy: text(settings, 'MultipleInstancesPolicy'),
    },
  };
}

export interface ExpectedTask {
  userId: string;
  command: string;
  /** 启动器入口，即第一个参数。 */
  entry: string;
  workingDirectory: string;
}

export interface TaskFiles {
  exists(path: string): boolean;
  /** 比较用的规范形式；Windows 路径不区分大小写。 */
  canonical(path: string): string;
}

export type Verdict = 'ok' | 'mismatch' | 'unverified';

export interface FieldCheck {
  label: string;
  actual: string;
  expected: string;
  verdict: Verdict;
  note?: string | undefined;
}

const MISSING = '（缺失）';
const SID = /^S-1-\d+(-\d+)+$/i;

/**
 * 逐项核对读回的任务。缺失的设置按 schema 的缺省值计（例如 Priority 缺省 7、ExecutionTimeLimit 缺省 PT72H）。
 * 读回的用户是 SID 时无法与 `域\用户名` 比较，记为未核对。
 */
export function checkTask(
  task: TaskReadback,
  expected: ExpectedTask,
  files: TaskFiles,
): FieldCheck[] {
  const checks: FieldCheck[] = [];
  const add = (label: string, actual: string, wanted: string, verdict: Verdict, note?: string) =>
    checks.push({ label, actual, expected: wanted, verdict, note });
  const equal = (label: string, actual: string | undefined, wanted: string) =>
    add(label, actual ?? MISSING, wanted, actual === wanted ? 'ok' : 'mismatch');
  const user = (label: string, actual: string | undefined, missing: string) => {
    if (actual !== undefined && SID.test(actual))
      add(label, actual, expected.userId, 'unverified', '读回为 SID');
    else
      add(
        label,
        actual ?? missing,
        expected.userId,
        actual?.toLowerCase() === expected.userId.toLowerCase() ? 'ok' : 'mismatch',
      );
  };
  const samePath = (actual: string | undefined, wanted: string) =>
    actual !== undefined && files.canonical(actual) === files.canonical(wanted);
  const path = (label: string, actual: string | undefined, wanted: string) =>
    add(label, actual ?? MISSING, wanted, samePath(actual, wanted) ? 'ok' : 'mismatch');

  const logon = task.triggers.find((trigger) => trigger.type === 'LogonTrigger');
  const triggerList = task.triggers
    .map((trigger) => (trigger.enabled === 'false' ? `${trigger.type}（已停用）` : trigger.type))
    .join('、');
  add(
    '触发器',
    triggerList || '（无）',
    'LogonTrigger',
    task.triggers.length === 1 && logon !== undefined && logon.enabled !== 'false'
      ? 'ok'
      : 'mismatch',
  );
  user('触发器用户', logon?.userId, '（任意用户）');
  user('运行用户', task.principal.userId, MISSING);
  equal('登录类型', task.principal.logonType, 'InteractiveToken');
  equal('运行级别', task.principal.runLevel ?? 'LeastPrivilege', 'LeastPrivilege');

  const exec = task.actions.find((action) => action.type === 'Exec');
  add(
    '动作',
    task.actions.map((action) => action.type).join('、') || '（无）',
    'Exec',
    task.actions.length === 1 && exec !== undefined ? 'ok' : 'mismatch',
  );
  path('命令', exec?.command === undefined ? undefined : unquote(exec.command), expected.command);
  const args = splitWindowsArgs(exec?.arguments ?? '');
  path('启动器', args[0], expected.entry);
  const config = args[1];
  if (config === undefined || args.length !== 2) {
    add('配置文件', config ?? MISSING, '一个配置文件', 'mismatch', `参数共 ${args.length} 个`);
  } else if (!files.exists(config)) {
    add('配置文件', config, '存在的配置文件', 'mismatch', '文件不存在');
  } else {
    add('配置文件', config, '存在的配置文件', 'ok');
  }
  path('工作目录', exec?.workingDirectory, expected.workingDirectory);

  equal('执行时限', task.settings.executionTimeLimit ?? 'PT72H', 'PT0S');
  const priority = task.settings.priority ?? '7';
  add('优先级', priority, '4–6', /^[4-6]$/.test(priority) ? 'ok' : 'mismatch');
  equal('多实例', task.settings.multipleInstancesPolicy ?? 'IgnoreNew', 'IgnoreNew');
  equal('任务已启用', task.settings.enabled ?? 'true', 'true');
  return checks;
}

function unquote(command: string): string {
  return command.length >= 2 && command.startsWith('"') && command.endsWith('"')
    ? command.slice(1, -1)
    : command;
}
