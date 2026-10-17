/**
 * 探针 S-05（宿主定时部分）：Node 定时器在 Windows 上的实际延迟分布（见 docs/plan/spikes.md）。
 * sidecar 推理在 EcoQoS 前后的时延见 spikes/s05-sidecar.ts。
 *
 *   node spikes/s05-timers.ts [--samples N] [--interval-seconds S] [--load N] [--spawned] [--out 结果文件]
 *     --samples           每个目标延迟的 setTimeout 样本数（缺省 200）
 *     --interval-seconds  按心跳周期 250ms 运行 setInterval 的时长（缺省 60）
 *     --load              同时运行 N 个忙等的工作线程，模拟 CPU 争用（缺省 0）
 *     --spawned           以启动器拉起宿主的方式（spawn、windowsHide、不用 shell）在子进程里测
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { isMainThread, Worker } from 'node:worker_threads';

const TARGETS_MS = [0, 1, 2, 5, 10, 15, 16, 20, 50, 100, 250];
const HEARTBEAT_MS = 250;
const script = fileURLToPath(import.meta.url);

interface Summary {
  n: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  min: number;
}

function summarize(values: readonly number[]): Summary {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  const round = (value: number) => Math.round(value * 1000) / 1000;
  return {
    n: sorted.length,
    min: round(sorted[0] ?? 0),
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    p99: round(at(0.99)),
    max: round(sorted[sorted.length - 1] ?? 0),
  };
}

async function measureTimeouts(samples: number) {
  const result: Record<string, Summary> = {};
  for (const target of TARGETS_MS) {
    const actual: number[] = [];
    for (let i = 0; i < samples; i++) {
      const start = performance.now();
      await new Promise<void>((done) => setTimeout(done, target));
      actual.push(performance.now() - start);
    }
    result[String(target)] = summarize(actual);
  }
  return result;
}

async function measureInterval(seconds: number) {
  const gaps: number[] = [];
  let last = performance.now();
  await new Promise<void>((done) => {
    const timer = setInterval(() => {
      const now = performance.now();
      gaps.push(now - last);
      last = now;
      if (gaps.length * HEARTBEAT_MS >= seconds * 1000) {
        clearInterval(timer);
        done();
      }
    }, HEARTBEAT_MS);
  });
  return { periodMs: HEARTBEAT_MS, gaps: summarize(gaps), overThreshold: countOver(gaps) };
}

/** 心跳间隔超过看门狗超时（缺省 1000ms）及其一半的次数。 */
function countOver(gaps: readonly number[]) {
  return {
    over500ms: gaps.filter((gap) => gap > 500).length,
    over1000ms: gaps.filter((gap) => gap > 1000).length,
  };
}

function startLoad(threads: number): Worker[] {
  const busy = 'for (;;) {}';
  return Array.from({ length: threads }, () => new Worker(busy, { eval: true }));
}

async function measure(samples: number, intervalSeconds: number, load: number) {
  const workers = startLoad(load);
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  try {
    const timeouts = await measureTimeouts(samples);
    const interval = await measureInterval(intervalSeconds);
    loop.disable();
    const ms = (ns: number) => Math.round(ns / 1e3) / 1e3;
    return {
      load,
      timeouts,
      interval,
      eventLoopDelayMs: {
        p50: ms(loop.percentile(50)),
        p99: ms(loop.percentile(99)),
        max: ms(loop.max),
      },
    };
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      samples: { type: 'string', default: '200' },
      'interval-seconds': { type: 'string', default: '60' },
      load: { type: 'string', default: '0' },
      spawned: { type: 'boolean', default: false },
      child: { type: 'boolean', default: false },
      out: { type: 'string' },
    },
  });
  const samples = Number(values.samples);
  const intervalSeconds = Number(values['interval-seconds']);
  const load = Number(values.load);
  if (values.child) {
    process.stdout.write(JSON.stringify(await measure(samples, intervalSeconds, load)));
    return;
  }
  const started = new Date().toISOString();
  let measured: unknown;
  if (values.spawned) {
    const child = spawnSync(
      process.execPath,
      [
        script,
        '--child',
        '--samples',
        String(samples),
        '--interval-seconds',
        String(intervalSeconds),
        '--load',
        String(load),
      ],
      { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
    );
    if (child.status !== 0) throw new Error(`子进程失败：${child.stderr}`);
    measured = JSON.parse(child.stdout);
  } else {
    measured = await measure(samples, intervalSeconds, load);
  }
  const result = {
    spike: 'S-05',
    part: 'host-timers',
    started,
    finished: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    spawned: values.spawned,
    measured,
  };
  const tag = `${values.spawned ? 'spawned' : 'direct'}-load${load}`;
  const out = resolve(values.out ?? join('reports', `S-05-${started.slice(0, 10)}-${tag}.json`));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`结果已写入 ${out}`);
}

if (isMainThread) await main();
