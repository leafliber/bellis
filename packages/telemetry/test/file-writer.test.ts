import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ManualClock, seededRandom } from '@bellis/kernel';
import { FileWriter, fileStamp, parseFileName, TelemetryCore } from '../src/index.ts';

const EPOCH = Date.UTC(2026, 9, 21, 10, 15, 0, 123);

function temp(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'bellis-telemetry-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('文件名：进程名、UTC 时刻与序号，可以按名字排序', () => {
  assert.equal(fileStamp(EPOCH), '20261021T101500123Z');
  assert.deepEqual(parseFileName('sidecar.tts-local-20261021T101500123Z-3.jsonl'), {
    role: 'sidecar.tts-local',
    stamp: '20261021T101500123Z',
    seq: 3,
  });
  assert.equal(parseFileName('notes.txt'), undefined);
  assert.throws(
    () =>
      new FileWriter({
        dir: '.',
        role: 'Host!',
        clock: new ManualClock(),
        maxFileBytes: 1,
        maxFileAgeMs: 1,
        maxFiles: 1,
      }),
  );
});

test('按大小与时间轮转；同一进程只留最新的 maxFiles 个，别的进程的文件不动', async (t) => {
  const dir = join(temp(t), 'nested', 'telemetry');
  const clock = new ManualClock(0, undefined, EPOCH);
  const writer = new FileWriter({
    dir,
    role: 'host',
    clock,
    maxFileBytes: 100,
    maxFileAgeMs: 60_000,
    maxFiles: 2,
  });
  const line = `${'x'.repeat(59)}\n`;
  await writer.write(line); // 第一个文件，目录在第一次写时创建
  writeFileSync(join(dir, 'sidecar.tts-local-20261021T000000000Z-0.jsonl'), 'other\n');
  clock.advance(1);
  await writer.write(line); // 60 + 60 > 100：换新文件
  clock.advance(60_000);
  await writer.write('y\n'); // 写满 60 秒：换新文件，最早的那个删除
  await writer.write('z\n');
  await writer.close();

  const files = readdirSync(dir).sort();
  assert.deepEqual(files, [
    'host-20261021T101500124Z-1.jsonl',
    'host-20261021T101600124Z-2.jsonl',
    'sidecar.tts-local-20261021T000000000Z-0.jsonl',
  ]);
  assert.equal(readFileSync(join(dir, files[0] as string), 'utf8'), line);
  assert.equal(readFileSync(join(dir, files[1] as string), 'utf8'), 'y\nz\n');
});

test('写不进时这一批以错误结束，调用方不受影响；目录恢复后接着写新文件', async (t) => {
  const base = temp(t);
  const blocked = join(base, 'telemetry');
  writeFileSync(blocked, '这里是个文件，不是目录');
  const clock = new ManualClock(0, undefined, EPOCH);
  const writer = new FileWriter({
    dir: blocked,
    role: 'host',
    clock,
    maxFileBytes: 1_000_000,
    maxFileAgeMs: 60_000,
    maxFiles: 5,
  });
  await assert.rejects(writer.write('a\n'));

  const logs: string[] = [];
  const telemetry = new TelemetryCore({
    clock,
    random: seededRandom(1),
    resource: {},
    writer,
    maxQueue: 10,
    batchSize: 10,
    flushIntervalMs: 0,
    log: (event) => logs.push(event),
  });
  telemetry.tracer('t').startSpan('lost').end();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(telemetry.stats().writeFailures, 1);
  assert.deepEqual(logs, ['telemetry.write-failed']);

  rmSync(blocked);
  telemetry.tracer('t').startSpan('kept').end();
  await telemetry.close();
  const [file] = readdirSync(blocked);
  assert.ok(file?.startsWith('host-'));
  assert.match(readFileSync(join(blocked, file as string), 'utf8'), /"name":"kept"/);
});
