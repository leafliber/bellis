import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeAudio, Resampler } from '../page/audio.js';
import { encodeAudio } from '../src/index.ts';
import { WAKE_FRAMES, WAKE_PEAK, type Worklet, worklet } from './worklet-scope.ts';

const toArrayBuffer = (buffer: Buffer) => new Uint8Array(buffer).slice().buffer;

test('音频帧：编码后能原样解出头与 PCM；格式不对时返回 null', () => {
  const pcm = Int16Array.from([0, 1, -1, 32767, -32768]);
  const frame = decodeAudio(toArrayBuffer(encodeAudio({ sentenceId: '句-1', token: 7 }, pcm)));
  assert.deepEqual(frame?.header, { sentenceId: '句-1', token: 7 });
  assert.deepEqual([...(frame?.pcm ?? [])], [...pcm]);
  assert.equal(decodeAudio(new ArrayBuffer(1)), null);
  assert.equal(decodeAudio(toArrayBuffer(Buffer.from([0, 9, 1, 2]))), null);
  const odd = Buffer.concat([encodeAudio({ sentenceId: 'x', token: 1 }, pcm), Buffer.from([1])]);
  assert.equal(decodeAudio(toArrayBuffer(odd)), null);
});

test('重采样：跨块保持相位，与一次送入的结果一致；同采样率原样通过', () => {
  const input = Int16Array.from({ length: 240 }, (_, i) => Math.round(10_000 * Math.sin(i / 7)));
  const whole = new Resampler(24_000, 48_000).push(input);
  const split = new Resampler(24_000, 48_000);
  const parts = [split.push(input.subarray(0, 100)), split.push(input.subarray(100))];
  const joined = Float32Array.from([...(parts[0] ?? []), ...(parts[1] ?? [])]);
  assert.equal(whole.length, joined.length);
  assert.ok(whole.every((value, i) => Math.abs(value - (joined[i] as number)) < 1e-6));
  assert.ok(Math.abs(whole.length - 480) <= 2);
  const same = new Resampler(48_000, 48_000).push(input);
  assert.deepEqual(
    [...same],
    [...input].map((v) => v / 32768),
  );
});

const peak = (samples: number[]) => samples.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

test('AudioWorklet：有许可时按句播放，回报开始、游标与以原始采样数计的结束；补零不推进游标', async () => {
  const w = await worklet();
  w.send({ type: 'hb' });
  w.send({ type: 'lease', ttlMs: 2000 });
  w.send({ type: 'begin', id: 's1' });
  w.send({ type: 'pcm', id: 's1', data: new Float32Array(256).fill(0.5), src: 128 });
  // 页面刚加载视为已静默很久：先放 150ms 唤醒信号，再放正文。
  const out = w.render(60);
  assert.ok(peak(out.slice(0, WAKE_FRAMES)) <= WAKE_PEAK + 1e-9);
  const first = out.slice(WAKE_FRAMES, WAKE_FRAMES + 256);
  assert.ok(first.every((value) => value === 0.5));
  // 数据耗尽但还没收到 end：欠载，补零。
  const gap = out.slice(WAKE_FRAMES + 256);
  assert.ok(gap.length > 0 && gap.every((value) => value === 0));
  // 游标与字幕进度只在正文开始后回报，这里不核对；欠载回报的是正文已播出的原始采样数。
  assert.deepEqual(
    w.kinds().filter((kind) => kind !== 'cursor' && kind !== 'progress'),
    ['started', 'underrun'],
  );
  assert.equal(w.posted.find((m) => m.kind === 'underrun')?.played, 128);
  w.send({ type: 'pcm', id: 's1', data: new Float32Array(128).fill(0.25), src: 64 });
  w.send({ type: 'end', id: 's1', src: 192 });
  w.render(2);
  assert.deepEqual(w.posted.at(-1), { kind: 'ended', sentenceId: 's1', played: 192 });
});

test('AudioWorklet：按渲染帧计时，收不到心跳即自静音，许可过期即停止，令牌变化丢弃缓冲', async () => {
  const w = await worklet();
  w.send({ type: 'hb' });
  w.send({ type: 'lease', ttlMs: 10_000 });
  w.send({ type: 'begin', id: 'a' });
  w.send({ type: 'pcm', id: 'a', data: new Float32Array(48_000 * 2).fill(0.1), src: 48_000 });
  // 1 秒约 375 个渲染块；超过后自静音并截断当前句。
  w.render(380);
  const truncated = w.posted.find((m) => m.kind === 'truncated');
  assert.equal(truncated?.reason, '宿主心跳丢失');
  assert.ok((truncated?.played as number) > 0);
  assert.ok(w.kinds().includes('muted'));
  assert.ok(w.render(1).every((value) => value === 0));
  w.send({ type: 'begin', id: 'b' });
  assert.equal(w.posted.at(-1)?.reason, '页面已静音');

  // 恢复心跳；许可只剩 100ms 的渲染帧。
  w.send({ type: 'hb' });
  w.send({ type: 'lease', ttlMs: 100 });
  w.send({ type: 'begin', id: 'c' });
  w.send({ type: 'pcm', id: 'c', data: new Float32Array(48_000).fill(0.1), src: 24_000 });
  w.render(40);
  assert.equal(w.posted.at(-1)?.reason, '许可过期');
  w.send({ type: 'begin', id: 'd' });
  assert.equal(w.posted.at(-1)?.reason, '没有有效许可');

  w.send({ type: 'hb' });
  w.send({ type: 'lease', ttlMs: 10_000 });
  w.send({ type: 'begin', id: 'e' });
  w.send({ type: 'pcm', id: 'e', data: new Float32Array(1024).fill(0.1), src: 512 });
  w.send({ type: 'revoke' });
  assert.deepEqual(w.posted.at(-1), {
    kind: 'truncated',
    sentenceId: 'e',
    played: 0,
    reason: '令牌已变化',
  });
});

/** 渲染 seconds 秒（按 128 帧一块），约每 0.25 秒送一次心跳，除非 heartbeat 为 false。 */
function play(w: Worklet, seconds: number, heartbeat = true) {
  const out: number[] = [];
  const quanta = Math.ceil((seconds * 48_000) / 128);
  for (let q = 0; q < quanta; q++) {
    if (heartbeat && q % 93 === 0) w.send({ type: 'hb' });
    out.push(...w.render(1));
  }
  return out;
}

/** 一句 100ms、振幅 0.2 的音频（已在 AudioContext 采样率上），原始采样数记 2400。 */
function sentence(w: Worklet, id: string) {
  w.send({ type: 'begin', id });
  w.send({ type: 'pcm', id, data: new Float32Array(4800).fill(0.2), src: 2400 });
  w.send({ type: 'end', id, src: 2400 });
}

const firstLoud = (samples: number[]) => samples.findIndex((v) => Math.abs(v) >= 0.1);

test('AudioWorklet：静默超过 1.5 秒后的第一句先放唤醒信号，started 在正文开始时回报，游标只算正文', async () => {
  const w = await worklet();
  w.send({ type: 'hb' });
  w.send({ type: 'lease', ttlMs: 60_000 });
  sentence(w, 'a');
  const out = play(w, 0.5);
  const wake = out.slice(0, WAKE_FRAMES);
  assert.equal(firstLoud(out), WAKE_FRAMES, '正文在 150ms 唤醒信号之后开始');
  assert.ok(peak(wake) > 0.9 * WAKE_PEAK && peak(wake) <= WAKE_PEAK + 1e-9, '峰值 -50dBFS');
  assert.ok(Math.abs(wake[0] ?? 1) < 1e-6 && Math.abs(wake.at(-1) ?? 1) < 1e-4, '两端淡入淡出');
  assert.equal(w.kinds()[0], 'started', '唤醒期间没有游标');
  assert.deepEqual(
    w.posted.find((m) => m.kind === 'ended'),
    { kind: 'ended', sentenceId: 'a', played: 2400 },
  );
  assert.equal(peak(out.slice(WAKE_FRAMES + 4800 + 128)), 0, '播完之后是数字静音');

  // 静默不足 1.5 秒：下一句直接开始。
  play(w, 1.0);
  sentence(w, 'b');
  assert.ok(firstLoud(play(w, 0.3)) < 128, '静默约 1.2 秒后直接开始');
  // 超过 1.5 秒：再唤醒。
  play(w, 1.6);
  sentence(w, 'c');
  assert.ok(Math.abs(firstLoud(play(w, 0.3)) - WAKE_FRAMES) < 128, '静默约 1.8 秒后先唤醒');
});

test('AudioWorklet：空闲、没有许可与自静音时都是数字静音，不放唤醒信号', async () => {
  const w = await worklet();
  w.send({ type: 'hb' });
  assert.equal(peak(play(w, 2)), 0, '空闲');
  sentence(w, 'a');
  assert.equal(peak(play(w, 0.5)), 0, '没有许可');
  assert.equal(w.posted.find((m) => m.kind === 'truncated')?.reason, '没有有效许可');
  w.send({ type: 'lease', ttlMs: 60_000 });
  play(w, 1.2, false);
  assert.ok(w.kinds().includes('muted'));
  sentence(w, 'b');
  assert.equal(peak(play(w, 0.5, false)), 0, '自静音');
});

test('AudioWorklet：唤醒期间许可过期，句子被丢弃，之后仍是数字静音', async () => {
  const w = await worklet();
  w.send({ type: 'hb' });
  w.send({ type: 'lease', ttlMs: 50 });
  sentence(w, 'a');
  const out = play(w, 0.5);
  assert.equal(firstLoud(out), -1, '正文没有播出');
  assert.equal(peak(out.slice(2400)), 0, '许可过期后数字静音');
  assert.deepEqual(
    w.posted.find((m) => m.kind === 'truncated'),
    {
      kind: 'truncated',
      sentenceId: 'a',
      played: 0,
      reason: '许可过期',
    },
  );
});

test('AudioWorklet：句中欠载超过 1.5 秒后恢复时同样先放唤醒信号，唤醒期间游标不推进', async () => {
  const w = await worklet();
  w.send({ type: 'hb' });
  w.send({ type: 'lease', ttlMs: 60_000 });
  w.send({ type: 'begin', id: 'a' });
  w.send({ type: 'pcm', id: 'a', data: new Float32Array(4800).fill(0.2), src: 2400 });
  play(w, 0.4);
  assert.equal(w.posted.find((m) => m.kind === 'underrun')?.played, 2400);

  // 欠载约 0.6 秒后音频补上：直接恢复。
  play(w, 0.4);
  w.send({ type: 'pcm', id: 'a', data: new Float32Array(4800).fill(0.3), src: 2400 });
  assert.ok(firstLoud(play(w, 0.2)) < 128, '欠载不足 1.5 秒直接恢复');

  // 再欠载 1.6 秒（补零即数字静音）后补上：先放唤醒信号，再接着播。
  play(w, 1.6);
  const from = w.posted.length;
  w.send({ type: 'pcm', id: 'a', data: new Float32Array(4800).fill(0.4), src: 2400 });
  w.send({ type: 'end', id: 'a', src: 7200 });
  const later = play(w, 0.4);
  assert.ok(Math.abs(firstLoud(later) - WAKE_FRAMES) < 128, '欠载超过 1.5 秒后先唤醒');
  assert.ok(peak(later.slice(0, WAKE_FRAMES - 128)) <= WAKE_PEAK + 1e-9);
  const reports = w.posted.slice(from);
  // 唤醒期间的游标停在欠载时的位置，唤醒样本不计入已播出；开始只回报一次。
  const cursors = reports.filter((m) => m.kind === 'cursor').map((m) => m.played as number);
  assert.equal(cursors[0], 4800, '唤醒期间游标不推进');
  assert.ok(cursors.every((played) => played >= 4800 && played <= 7200));
  assert.equal(w.kinds().filter((kind) => kind === 'started').length, 1);
  assert.deepEqual(
    reports.find((m) => m.kind === 'ended'),
    { kind: 'ended', sentenceId: 'a', played: 7200 },
  );
});

test('AudioWorklet：字幕进度只在正文播出时回报，至少隔 10ms 的渲染帧，唤醒与欠载期间不推进', async () => {
  const w = await worklet();
  w.send({ type: 'hb' });
  w.send({ type: 'lease', ttlMs: 60_000 });
  w.send({ type: 'begin', id: 'a' });
  w.send({ type: 'pcm', id: 'a', data: new Float32Array(9600).fill(0.2), src: 4800 });
  /** 从第 from 条回报起的进度：发出时已渲染的帧数与已播采样数。 */
  const progress = (from = 0) =>
    w.posted.flatMap((m, i) =>
      i >= from && m.kind === 'progress'
        ? [{ at: w.postedAt[i] as number, played: m.played as number }]
        : [],
    );
  // 先放 150ms 唤醒信号，再放 200ms 正文，之后欠载。
  play(w, 0.6);
  const first = progress();
  assert.ok(first.length >= 15, `200ms 正文约 19 次，实际 ${first.length} 次`);
  assert.ok((first[0]?.at as number) >= WAKE_FRAMES - 128, '唤醒期间没有进度');
  for (let i = 1; i < first.length; i++) {
    assert.ok((first[i]?.at as number) - (first[i - 1]?.at as number) >= 480, '至少隔 10ms');
    assert.ok((first[i]?.played as number) > (first[i - 1]?.played as number), '每次都有推进');
  }
  assert.equal(first.at(-1)?.played, 4800, '停在已收到的全部正文');

  // 欠载共约 1.65 秒后补上：先放唤醒信号，期间没有进度；正文恢复后接着推进。
  play(w, 1.4);
  assert.equal(progress().length, first.length, '欠载期间没有新的进度');
  const from = w.posted.length;
  const sentAt = w.rendered();
  w.send({ type: 'pcm', id: 'a', data: new Float32Array(4800).fill(0.3), src: 2400 });
  w.send({ type: 'end', id: 'a', src: 7200 });
  play(w, 0.4);
  const later = progress(from);
  assert.ok(later.length > 0);
  assert.ok((later[0]?.at as number) - sentAt >= WAKE_FRAMES - 128, '唤醒期间没有进度');
  assert.ok(later.every((p) => p.played > 4800 && p.played <= 7200));
  assert.ok(w.posted.slice(from).some((m) => m.kind === 'ended'));
});
