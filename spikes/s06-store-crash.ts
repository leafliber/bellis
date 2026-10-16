/**
 * 探针 S-06：SQLite 在 Windows NTFS 上的崩溃窗口是否符合状态存储的重启语义（见 docs/plan/spikes.md）。
 *
 *   node spikes/s06-store-crash.ts [--runs N] [--kills N] [--dir 目录] [--out 结果文件]
 *     先跑一遍工作负载记下经过的全部写入点；对每个点的每一次经过，各强制终止 N 次（缺省 5）；
 *     再在随机时刻从外部强制终止 N 次（缺省 200）。每次终止后重新打开、恢复并核对不变量。
 *   node spikes/s06-store-crash.ts --fill --dir <专用小卷上的目录> [--out 结果文件]
 *     磁盘写满注入：把所在卷写满后继续写入，核对存储进入不可用状态、数据不损坏，腾出空间后能恢复。
 *     只接受总容量不超过 4GiB 的卷，避免误把系统盘写满。
 *
 * 子进程模式（--child）由本脚本自己调起。强制终止在 Windows 上是 TerminateProcess，没有任何收尾。
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statfsSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  executeOnce,
  type IntentInput,
  type Projection,
  StateStore,
  type StoredEvent,
  StoreUnavailable,
} from '@bellis/store';

const script = fileURLToPath(import.meta.url);
const RESOURCE = 'stage.audio';
/** 第几个意图的副作用会失败，用来覆盖“执行后失败”的路径。 */
const FAILING_INDEX = 2;
const PER_ROUND = 4;

const counts: Projection<Record<string, number>> = {
  name: 'counts',
  initial: {},
  reduce: (state, event: StoredEvent) => ({ ...state, [event.type]: (state[event.type] ?? 0) + 1 }),
};

function input(key: string): Omit<IntentInput, 'payloadHash'> {
  return {
    key,
    type: 'speech.play',
    // 每个意图一个目标：结果未知的意图只隔离它自己的目标，不影响重跑时的其他意图。
    target: `stage-${key}`,
    source: { origin: 'spike', inputs: [], untrusted: false },
    capabilities: ['speech.output'],
    timeSensitive: true,
  };
}

interface Files {
  db: string;
  effects: string;
  tokens: string;
}

/** 一轮工作负载：每个意图之后授予一次许可令牌；第 FAILING_INDEX 个意图的副作用失败。 */
async function round(store: StateStore, prefix: string, files: Files): Promise<void> {
  for (let i = 0; i < PER_ROUND; i++) {
    const key = `${prefix}-${i}`;
    await executeOnce(store, input(key), { key }, async () => {
      appendFileSync(files.effects, `${key}\n`);
      if (i === FAILING_INDEX) throw new Error('副作用失败');
      return null;
    });
    const token = store.transaction((tx) => {
      tx.append('lease.granted', { key });
      return tx.nextToken(RESOURCE);
    }, 'grant');
    appendFileSync(files.tokens, `${token}\n`);
  }
}

/** 数据库放在 dir；副作用与令牌记录放在 logDir（写满注入时放到别的卷，免得记录本身写不进去）。 */
function filesIn(dir: string, logDir = dir): Files {
  const name = `bellis-s06-${randomBytes(6).toString('hex')}`;
  return {
    db: join(dir, `${name}.db`),
    effects: join(logDir, `${name}.effects`),
    tokens: join(logDir, `${name}.tokens`),
  };
}

function cleanup(files: Files): void {
  for (const path of [
    files.db,
    `${files.db}-wal`,
    `${files.db}-shm`,
    `${files.db}-journal`,
    files.effects,
    files.tokens,
  ]) {
    rmSync(path, { force: true });
  }
}

function lines(path: string): string[] {
  try {
    return readFileSync(path, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function fold<S>(projection: Projection<S>, events: readonly StoredEvent[]): S {
  return events.reduce((state, event) => projection.reduce(state, event), projection.initial);
}

/** 重新打开、恢复并核对不变量；返回违反的条目，空数组表示全部成立。 */
async function verify(files: Files, prefixes: readonly string[]): Promise<string[]> {
  const problems: string[] = [];
  const store = StateStore.open({ path: files.db, projections: [counts] });
  try {
    store.recover();
    for (const state of ['pending', 'executing'] as const) {
      const left = store.intentsIn(state);
      if (left.length > 0) problems.push(`恢复后仍有 ${left.length} 个意图处于 ${state}`);
    }
    const effects = new Map<string, number>();
    for (const key of lines(files.effects)) effects.set(key, (effects.get(key) ?? 0) + 1);
    for (const [key, times] of effects) {
      if (times > 1) problems.push(`${key} 的副作用执行了 ${times} 次`);
    }
    for (const prefix of prefixes) {
      for (let i = 0; i < PER_ROUND; i++) {
        const key = `${prefix}-${i}`;
        const ran = effects.get(key) ?? 0;
        const intent = store.intentByKey(key);
        if (!intent) {
          if (ran > 0) problems.push(`${key} 没有意图记录，副作用却执行过`);
          continue;
        }
        if (intent.state === 'succeeded' && ran !== 1)
          problems.push(`${key} 已成功，副作用执行了 ${ran} 次`);
        if (intent.state === 'failed' && i !== FAILING_INDEX && ran !== 0)
          problems.push(`${key} 被放弃，副作用却执行过`);
      }
    }
    const seen = Math.max(0, ...lines(files.tokens).map(Number));
    if (store.token(RESOURCE) < seen)
      problems.push(`令牌回退：存储中 ${store.token(RESOURCE)}，此前已提交 ${seen}`);
    if (JSON.stringify(store.view(counts)) !== JSON.stringify(fold(counts, store.events())))
      problems.push('投影与事件不一致');

    // 恢复后原样重跑：已有意图的不再执行，每个意图的副作用仍至多一次。
    for (const prefix of prefixes) await round(store, prefix, files);
    const again = new Map<string, number>();
    for (const key of lines(files.effects)) again.set(key, (again.get(key) ?? 0) + 1);
    for (const [key, times] of again) {
      if (times > 1) problems.push(`重跑后 ${key} 的副作用执行了 ${times} 次`);
    }
  } finally {
    store.close();
  }
  const db = new DatabaseSync(files.db, { readOnly: true });
  try {
    const result = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
    if (result.integrity_check !== 'ok')
      problems.push(`integrity_check：${result.integrity_check}`);
  } finally {
    db.close();
  }
  return problems;
}

// ---------- 子进程 ----------

async function child(mode: string, rest: string[]): Promise<void> {
  const [db, effects, tokens] = rest as [string, string, string];
  const files = { db, effects, tokens };
  if (mode === 'points') {
    const hits: string[] = [];
    const store = StateStore.open({ path: db, projections: [counts], fault: (p) => hits.push(p) });
    await round(store, 'r0', files);
    store.close();
    process.stdout.write(JSON.stringify(hits));
    return;
  }
  if (mode === 'crash') {
    const [point, occurrence] = rest.slice(3) as [string, string];
    let hits = 0;
    const store = StateStore.open({
      path: db,
      projections: [counts],
      fault: (p) => {
        if (p === point && ++hits === Number(occurrence)) process.kill(process.pid, 'SIGKILL');
      },
    });
    await round(store, 'r0', files);
    process.stdout.write('没有在预期的写入点终止');
    process.exit(0);
  }
  if (mode === 'loop') {
    const store = StateStore.open({ path: db, projections: [counts] });
    process.stdout.write('ready\n');
    for (let n = 0; ; n++) await round(store, `r${n}`, files);
  }
  throw new Error(`未知的子进程模式：${mode}`);
}

// ---------- 主进程 ----------

function exited(proc: ChildProcess): Promise<void> {
  return new Promise((done) => proc.once('exit', () => done()));
}

/** 证明核对会失败：终止后篡改记录（多一次副作用、多一个已提交的令牌），核对必须报出来。 */
async function selfCheck(dir: string): Promise<string[]> {
  const files = filesIn(dir);
  try {
    spawnSync(process.execPath, [
      script,
      '--child',
      'crash',
      files.db,
      files.effects,
      files.tokens,
      'complete:after-commit',
      '1',
    ]);
    appendFileSync(files.effects, 'r0-0\n');
    appendFileSync(files.tokens, '999999\n');
    const problems = await verify(files, ['r0']);
    if (problems.length < 2) throw new Error(`自检失败：篡改后核对只报出 ${problems.length} 项`);
    return problems;
  } finally {
    cleanup(files);
  }
}

async function crashAtPoints(dir: string, runs: number) {
  const probe = filesIn(dir);
  const discovered = spawnSync(
    process.execPath,
    [script, '--child', 'points', probe.db, probe.effects, probe.tokens],
    { encoding: 'utf8' },
  );
  cleanup(probe);
  if (discovered.status !== 0) throw new Error(`发现写入点失败：${discovered.stderr}`);
  const hits = JSON.parse(discovered.stdout) as string[];
  const occurrences = new Map<string, number>();
  for (const point of hits) occurrences.set(point, (occurrences.get(point) ?? 0) + 1);

  const results: Array<{ point: string; occurrence: number; runs: number; failures: string[] }> =
    [];
  for (const [point, total] of occurrences) {
    for (let occurrence = 1; occurrence <= total; occurrence++) {
      const failures: string[] = [];
      for (let run = 0; run < runs; run++) {
        const files = filesIn(dir);
        try {
          const proc = spawnSync(
            process.execPath,
            [
              script,
              '--child',
              'crash',
              files.db,
              files.effects,
              files.tokens,
              point,
              String(occurrence),
            ],
            { encoding: 'utf8' },
          );
          // 强制终止不留任何输出；有输出说明子进程是自己出错退出的，不算一次有效的终止。
          if (proc.status === 0 || proc.stdout || proc.stderr) {
            failures.push(`子进程没有在写入点被终止：${proc.stdout}${proc.stderr}`);
            continue;
          }
          failures.push(...(await verify(files, ['r0'])));
        } finally {
          cleanup(files);
        }
      }
      results.push({ point, occurrence, runs, failures });
      console.log(`${point} 第 ${occurrence} 次：${runs} 轮，违反 ${failures.length}`);
    }
  }
  return { hits: hits.length, results };
}

async function randomKills(dir: string, kills: number) {
  const failures: Array<{ delayMs: number; problems: string[] }> = [];
  const committedRounds: number[] = [];
  for (let n = 0; n < kills; n++) {
    const files = filesIn(dir);
    try {
      const proc = spawn(
        process.execPath,
        [script, '--child', 'loop', files.db, files.effects, files.tokens],
        { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true },
      );
      await new Promise<void>((ready) => proc.stdout?.once('data', () => ready()));
      const delayMs = 5 + Math.floor(Math.random() * 300);
      await new Promise((wait) => setTimeout(wait, delayMs));
      proc.kill();
      await exited(proc);
      const effects = lines(files.effects);
      const lastRound = Math.max(-1, ...effects.map((key) => Number(key.split('-')[0]?.slice(1))));
      committedRounds.push(lastRound + 1);
      const prefixes = Array.from({ length: lastRound + 2 }, (_, i) => `r${i}`);
      const problems = await verify(files, prefixes);
      if (problems.length > 0) failures.push({ delayMs, problems });
    } finally {
      cleanup(files);
    }
    if ((n + 1) % 50 === 0) console.log(`随机终止 ${n + 1}/${kills}，违反 ${failures.length}`);
  }
  const sorted = [...committedRounds].sort((a, b) => a - b);
  return {
    kills,
    failures,
    roundsBeforeKill: { min: sorted[0] ?? 0, max: sorted[sorted.length - 1] ?? 0 },
  };
}

const FILL_LIMIT = 4 * 1024 ** 3;

async function fill(dir: string) {
  const fs = statfsSync(dir);
  const total = fs.blocks * fs.bsize;
  if (total > FILL_LIMIT) {
    throw new Error(`拒绝写满：${dir} 所在卷总容量 ${total} 字节，超过 4GiB，可能不是专用的小卷`);
  }
  const files = filesIn(dir, tmpdir());
  const filler = join(dir, `bellis-s06-filler-${randomBytes(4).toString('hex')}`);
  const report: Record<string, unknown> = { volumeBytes: total };
  try {
    const store = StateStore.open({ path: files.db, projections: [counts] });
    await round(store, 'before', files);
    const fd = openSync(filler, 'w');
    const chunk = Buffer.alloc(1024 * 1024);
    let filled = 0;
    try {
      for (;;) filled += writeSync(fd, chunk);
    } catch (error) {
      report.fillStoppedBy = (error as NodeJS.ErrnoException).code;
    } finally {
      closeSync(fd);
    }
    report.filledBytes = filled;
    let unavailableAfter: number | undefined;
    for (let n = 0; n < 10_000; n++) {
      try {
        await round(store, `full${n}`, files);
      } catch (error) {
        if (error instanceof StoreUnavailable || !store.healthy) {
          unavailableAfter = n;
          break;
        }
        throw error;
      }
    }
    report.unavailableAfterRounds = unavailableAfter ?? null;
    report.healthyWhileFull = store.healthy;
    store.close();
    rmSync(filler, { force: true });
    const rounds = (unavailableAfter ?? 0) + 1;
    report.problemsAfterRecovery = await verify(files, [
      'before',
      ...Array.from({ length: rounds }, (_, i) => `full${i}`),
    ]);
  } finally {
    rmSync(filler, { force: true });
    cleanup(files);
  }
  return report;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      child: { type: 'string' },
      runs: { type: 'string', default: '5' },
      kills: { type: 'string', default: '200' },
      dir: { type: 'string' },
      out: { type: 'string' },
      fill: { type: 'boolean', default: false },
    },
  });
  if (values.child) return child(values.child, positionals);

  const dir = resolve(values.dir ?? join(tmpdir(), 'bellis-s06'));
  mkdirSync(dir, { recursive: true });
  const started = new Date().toISOString();
  const result: Record<string, unknown> = {
    spike: 'S-06',
    started,
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    dir,
  };
  if (values.fill) {
    result.fill = await fill(dir);
  } else {
    result.selfCheck = await selfCheck(dir);
    result.points = await crashAtPoints(dir, Number(values.runs));
    result.randomKills = await randomKills(dir, Number(values.kills));
  }
  result.finished = new Date().toISOString();
  const out = resolve(values.out ?? join('reports', `S-06-${started.slice(0, 10)}.json`));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`结果已写入 ${out}`);
}

await main();
