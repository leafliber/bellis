/**
 * 探针 S-03：本机通道（命名管道）能否满足控制面需求，未认证者能否拿到数据（见 docs/plan/spikes.md）。
 *
 *   node spikes/s03-pipe.ts [--count N] [--warmup N] [--connects N] [--sizes 64,4096,65536] [--out 结果文件]
 *
 * 测量与核对：
 *   1. Node 宿主作服务端，Python 探针（spikes/python/s03_pipe.py）作 sidecar：握手耗时与 `spike.echo`
 *      往返时延，管道与 127.0.0.1 TCP 各测一遍；Node 客户端同样测一遍作基线。
 *   2. 抢注（仅 Windows）：Python 抢注者先占用管道名，宿主 `listen` 应以 address-in-use 失败，
 *      Node 与 Python 客户端连上抢注者应以 auth-failed 失败，且发出 hello 后不再发任何数据。
 *   3. 实例注入（仅 Windows）：宿主先监听，同一用户的抢注者能否再给同名管道加实例；
 *      若能，客户端落到它上面时同样只能拿到 auth-failed。
 *   4. 经 SMB 回环（`\\localhost\pipe\…`）连接，作为远程客户端可达性的本机近似，
 *      以带 PIPE_REJECT_REMOTE_CLIENTS 的管道作对照；管道的安全描述符。
 * 另一本地用户与真正跨机的访问需要另一个账户或另一台机器，不在本脚本内。
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { cpus, release, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  type ChannelError,
  type ChannelServer,
  Connection,
  connect,
  createChannelPath,
  createSessionKey,
  encodeSessionKey,
  listen,
  RpcPeer,
} from '@bellis/channel';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PYTHON_SCRIPT = join('spikes', 'python', 's03_pipe.py');
const ECHO = 'spike.echo';
const ROLE = 'spike.node';

interface Summary {
  count: number;
  p50Us: number;
  p90Us: number;
  p99Us: number;
  maxUs: number;
  meanUs: number;
}

/** 与 s03_pipe.py 的 summarize 取法一致。 */
function summarize(valuesUs: readonly number[]): Summary {
  const sorted = [...valuesUs].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  const round = (value: number) => Math.round(value * 10) / 10;
  return {
    count: sorted.length,
    p50Us: round(at(0.5)),
    p90Us: round(at(0.9)),
    p99Us: round(at(0.99)),
    maxUs: round(sorted[sorted.length - 1] ?? 0),
    meanUs: round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
  };
}

interface Options {
  sizes: number[];
  count: number;
  warmup: number;
  connects: number;
}

/** 宿主侧的回显服务；被拒绝的握手记下错误码，供抢注与可达性判读。 */
class EchoHost {
  readonly rejected: Array<{ code: string; message: string }> = [];
  readonly accepted: string[] = [];

  serve(connection: Connection): void {
    this.accepted.push(connection.role);
    const peer = new RpcPeer(connection, { timeoutMs: 10_000 });
    peer.handle(ECHO, (params) => params);
  }

  reject(error: ChannelError): void {
    this.rejected.push({ code: error.code, message: error.message });
  }
}

async function listenPipe(path: string, key: Uint8Array, host: EchoHost): Promise<ChannelServer> {
  return listen(path, {
    key,
    onConnection: (connection) => host.serve(connection),
    onRejected: (error) => host.reject(error),
    onError: (error) => console.error('管道服务端错误：', error),
  });
}

/** 只供对比的 TCP 服务端：同样先握手认证，关闭 Nagle。 */
async function listenTcp(
  key: Uint8Array,
  host: EchoHost,
): Promise<{ server: Server; port: number }> {
  const server = createServer({ noDelay: true }, (socket) => {
    Connection.accept(socket, { key }).then(
      (connection) => host.serve(connection),
      (error: ChannelError) => host.reject(error),
    );
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('TCP 地址异常');
  return { server, port: address.port };
}

function openTcp(port: number, key: Uint8Array): Promise<Connection> {
  return new Promise((done, fail) => {
    const socket: Socket = createConnection({ host: '127.0.0.1', port, noDelay: true }, () => {
      socket.off('error', fail);
      Connection.open(socket, ROLE, { key }).then(done, fail);
    });
    socket.once('error', fail);
  });
}

async function nodeRtt(open: () => Promise<Connection>, options: Options) {
  const handshakes: number[] = [];
  for (let i = 0; i < options.connects; i++) {
    const started = performance.now();
    const connection = await open();
    handshakes.push((performance.now() - started) * 1000);
    connection.close();
  }
  const peer = new RpcPeer(await open(), { timeoutMs: 10_000 });
  const sizes = [];
  for (const size of options.sizes) {
    const params = { data: 'x'.repeat(size) };
    for (let i = 0; i < options.warmup; i++) await peer.request(ECHO, params);
    const samples: number[] = [];
    for (let i = 0; i < options.count; i++) {
      const started = performance.now();
      const reply = (await peer.request(ECHO, params)) as { data: string };
      samples.push((performance.now() - started) * 1000);
      if (reply.data.length !== size) throw new Error('回显内容不一致');
    }
    sizes.push({ bytes: size, ...summarize(samples) });
  }
  peer.connection.close();
  return { handshake: summarize(handshakes), sizes };
}

/** 用 uv 管理的环境运行 Python 探针，收集它写到 stdout 的 JSON 行。 */
function python(
  args: string[],
  key: Uint8Array | undefined,
): {
  child: ChildProcess;
  records: Array<Record<string, unknown>>;
  next(event: string, timeoutMs: number): Promise<Record<string, unknown>>;
  exited: Promise<number | null>;
} {
  // stdout 按 UTF-8 输出；Windows 上 Python 默认用系统代码页。
  const env: NodeJS.ProcessEnv = { ...process.env, PYTHONUTF8: '1' };
  delete env.BELLIS_CHANNEL_KEY;
  if (key) env.BELLIS_CHANNEL_KEY = encodeSessionKey(key);
  const child = spawn('uv', ['run', '--locked', 'python', PYTHON_SCRIPT, ...args], {
    cwd: root,
    env,
    stdio: ['pipe', 'pipe', 'inherit'],
    windowsHide: true,
  });
  const records: Array<Record<string, unknown>> = [];
  const waiters: Array<{ event: string; done: (record: Record<string, unknown>) => void }> = [];
  createInterface({ input: child.stdout as NonNullable<typeof child.stdout> }).on(
    'line',
    (line) => {
      const record = JSON.parse(line) as Record<string, unknown>;
      records.push(record);
      for (const waiter of waiters.splice(0)) {
        if (waiter.event === record.event) waiter.done(record);
        else waiters.push(waiter);
      }
    },
  );
  const exited = new Promise<number | null>((done) => child.once('exit', done));
  return {
    child,
    records,
    exited,
    next(event, timeoutMs) {
      const seen = records.find((record) => record.event === event);
      if (seen) return Promise.resolve(seen);
      return new Promise((done, fail) => {
        const timer = setTimeout(() => fail(new Error(`等待 ${event} 超时`)), timeoutMs);
        waiters.push({
          event,
          done: (record) => {
            clearTimeout(timer);
            done(record);
          },
        });
      });
    },
  };
}

async function pythonOnce(args: string[], key: Uint8Array, event: string) {
  const run = python(args, key);
  run.child.stdin?.end();
  const code = await run.exited;
  const record = run.records.find((entry) => entry.event === event);
  if (code !== 0 || !record) throw new Error(`Python 探针失败（退出码 ${code}）`);
  return record;
}

async function nodeProbe(path: string, key: Uint8Array) {
  try {
    const connection = await connect(path, ROLE, { key });
    connection.close();
    return { ok: true };
  } catch (error) {
    const failure = error as ChannelError;
    return { ok: false, code: failure.code, message: failure.message };
  }
}

async function stopSquatter(run: ReturnType<typeof python>) {
  run.child.stdin?.end();
  const timer = setTimeout(() => run.child.kill(), 3000);
  await run.exited;
  clearTimeout(timer);
}

/** 抢注者先占用管道名：宿主监听与两种客户端各自的结果，以及抢注者在伪造 challenge 之后收到的字节数。 */
async function squatFirst(key: Uint8Array) {
  const path = createChannelPath('s03');
  const squatter = python(['squat', '--path', path], undefined);
  const created = await squatter.next('created', 30_000);
  let hostListen: Record<string, unknown>;
  try {
    const server = await listenPipe(path, key, new EchoHost());
    hostListen = { ok: true };
    await server.close();
  } catch (error) {
    const failure = error as ChannelError;
    hostListen = { ok: false, code: failure.code, message: failure.message };
  }
  const node = await nodeProbe(path, key);
  const pythonResult = await pythonOnce(['probe', '--path', path], key, 'probe');
  await new Promise((done) => setTimeout(done, 500));
  await stopSquatter(squatter);
  return {
    squatterCreated: created,
    hostListen,
    nodeClient: node,
    pythonClient: pythonResult,
    squatterSaw: squatter.records.filter((record) => record.event === 'client'),
  };
}

/** 宿主先监听，同一用户的抢注者再给同名管道加实例；之后的连接各落到哪一方。 */
async function injectAfter(key: Uint8Array, attempts: number) {
  const path = createChannelPath('s03');
  const host = new EchoHost();
  const server = await listenPipe(path, key, host);
  const squatter = python(['squat', '--path', path], undefined);
  const created = await squatter.next('created', 30_000);
  const node: Array<Record<string, unknown>> = [];
  const py: Array<Record<string, unknown>> = [];
  if (created.ok === true) {
    for (let i = 0; i < attempts; i++) node.push(await nodeProbe(path, key));
    for (let i = 0; i < Math.min(attempts, 10); i++) {
      py.push(await pythonOnce(['probe', '--path', path], key, 'probe'));
    }
  }
  await new Promise((done) => setTimeout(done, 500));
  await stopSquatter(squatter);
  await server.close();
  const tally = (results: Array<Record<string, unknown>>) => {
    const counts: Record<string, number> = {};
    for (const result of results) {
      const label = result.ok === true ? 'ok' : String(result.code);
      counts[label] = (counts[label] ?? 0) + 1;
    }
    return counts;
  };
  return {
    squatterCreated: created,
    nodeClients: tally(node),
    pythonClients: tally(py),
    hostAccepted: host.accepted.length,
    hostRejected: host.rejected,
    squatterSaw: squatter.records.filter((record) => record.event === 'client'),
  };
}

function viaLoopback(path: string): string {
  return path.replace('\\\\.\\pipe\\', '\\\\localhost\\pipe\\');
}

/** 经 SMB 回环连接宿主的管道（远程客户端的本机近似）。 */
async function loopbackRemote(path: string, key: Uint8Array) {
  const remotePath = viaLoopback(path);
  const started = performance.now();
  const result = await Promise.race([
    nodeProbe(remotePath, key),
    new Promise<Record<string, unknown>>((done) =>
      setTimeout(() => done({ ok: false, code: 'timeout', message: '10s 内未连上' }), 10_000),
    ),
  ]);
  return { path: remotePath, ms: Math.round(performance.now() - started), ...result };
}

/**
 * 对照：带 PIPE_REJECT_REMOTE_CLIENTS 的管道。本机路径应能连上（落到抢注者，auth-failed），
 * 经回环应被拒绝（connect-failed）；两者都如此，才说明回环路径确实按远程客户端处理。
 */
async function rejectRemoteControl(key: Uint8Array) {
  const path = createChannelPath('s03');
  const server = python(['squat', '--path', path, '--reject-remote'], undefined);
  const created = await server.next('created', 30_000);
  const local = await nodeProbe(path, key);
  const loopback = await nodeProbe(viaLoopback(path), key);
  await new Promise((done) => setTimeout(done, 500));
  await stopSquatter(server);
  return { created, local, loopback };
}

/** 读取管道安全描述符的 PowerShell 脚本；Get-Acl 不支持管道路径，改为以客户端打开一个实例读取。 */
const PIPE_SECURITY_SCRIPT = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$c = New-Object System.IO.Pipes.NamedPipeClientStream('.', $env:S03_PIPE, [System.IO.Pipes.PipeDirection]::InOut)
$c.Connect(5000)
$s = $c.GetAccessControl()
$c.Dispose()
$sections = [System.Security.AccessControl.AccessControlSections]'Access,Owner'
$access = @($s.Access | ForEach-Object { '{0} {1} {2}' -f $_.IdentityReference, $_.AccessControlType, $_.PipeAccessRights })
@{ sddl = $s.GetSecurityDescriptorSddlForm($sections); owner = $s.Owner; access = $access } | ConvertTo-Json -Compress
`;

/** 管道的安全描述符。读取本身会打开一个实例，宿主随后记一次握手前关闭。 */
function pipeSecurity(path: string) {
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', PIPE_SECURITY_SCRIPT],
    {
      encoding: 'utf8',
      env: { ...process.env, S03_PIPE: path.replace('\\\\.\\pipe\\', '') },
      windowsHide: true,
      timeout: 30_000,
    },
  );
  return result.status === 0
    ? { ok: true, ...(JSON.parse(result.stdout) as Record<string, unknown>) }
    : { ok: false, message: (result.stderr || result.error?.message || '').trim() };
}

function pythonVersion(): string {
  const result = spawnSync('uv', ['run', '--locked', 'python', '--version'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  return result.stdout.trim();
}

async function main() {
  const { values } = parseArgs({
    options: {
      count: { type: 'string', default: '2000' },
      warmup: { type: 'string', default: '200' },
      connects: { type: 'string', default: '50' },
      sizes: { type: 'string', default: '64,4096,65536' },
      attempts: { type: 'string', default: '20' },
      out: { type: 'string' },
    },
  });
  const options: Options = {
    sizes: values.sizes.split(',').map(Number),
    count: Number(values.count),
    warmup: Number(values.warmup),
    connects: Number(values.connects),
  };
  const started = new Date().toISOString();
  const key = createSessionKey();
  const path = createChannelPath('s03');
  const host = new EchoHost();
  const pipe = await listenPipe(path, key, host);
  const tcp = await listenTcp(key, host);
  const pyArgs = (target: string) => [
    'rtt',
    '--path',
    target,
    '--sizes',
    values.sizes,
    '--count',
    values.count,
    '--warmup',
    values.warmup,
    '--connects',
    values.connects,
  ];

  console.log('往返时延：Python ↔ 管道 / TCP，Node ↔ 管道 / TCP');
  const rtt = {
    pythonPipe: await pythonOnce(pyArgs(path), key, 'rtt'),
    pythonTcp: await pythonOnce(pyArgs(`tcp:127.0.0.1:${tcp.port}`), key, 'rtt'),
    nodePipe: await nodeRtt(() => connect(path, ROLE, { key }), options),
    nodeTcp: await nodeRtt(() => openTcp(tcp.port, key), options),
  };
  const rejectedDuringRtt = [...host.rejected];

  let windows: unknown = 'unsupported：抢注、实例注入与 SDDL 只在 Windows 上测';
  if (process.platform === 'win32') {
    console.log('抢注：抢注者先占用管道名');
    const first = await squatFirst(key);
    console.log('实例注入：宿主先监听');
    const inject = await injectAfter(key, Number(values.attempts));
    console.log('SMB 回环连接、对照与安全描述符');
    windows = {
      squatFirst: first,
      injectAfter: inject,
      loopbackRemote: await loopbackRemote(path, key),
      rejectRemoteControl: await rejectRemoteControl(key),
      security: pipeSecurity(path),
    };
  }
  await new Promise((done) => setTimeout(done, 2500));
  const rejectedAfter = host.rejected.slice(rejectedDuringRtt.length);
  await pipe.close();
  await new Promise<void>((done) => tcp.server.close(() => done()));

  const result = {
    spike: 'S-03',
    started,
    finished: new Date().toISOString(),
    machine: {
      os: `${process.platform} ${release()}`,
      cpu: cpus()[0]?.model,
      cores: cpus().length,
      memoryGiB: Math.round(totalmem() / 2 ** 30),
      node: process.version,
      python: pythonVersion(),
    },
    options,
    rtt,
    rejectedDuringRtt,
    windows,
    hostRejectedAfterRtt: rejectedAfter,
  };
  const out = resolve(values.out ?? join('reports', `S-03-${started.slice(0, 10)}.json`));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  const brief = (entry: { sizes: Array<{ bytes: number; p50Us: number; p99Us: number }> }) =>
    entry.sizes.map((size) => `${size.bytes}B p50 ${size.p50Us}µs p99 ${size.p99Us}µs`).join('；');
  for (const [name, entry] of Object.entries(rtt)) {
    console.log(`${name}：${brief(entry as Parameters<typeof brief>[0])}`);
  }
  console.log(JSON.stringify(windows, null, 2));
  console.log(`结果已写入 ${out}`);
}

await main();
