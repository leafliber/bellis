import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeAudio, Resampler } from '../page/audio.js';
import { encodeAudio } from '../src/index.ts';

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

interface Port {
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage(message: unknown): void;
}
interface Processor {
  port: Port;
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}

/** 在 Node 里模拟 AudioWorkletGlobalScope，加载 worklet.js，返回一个处理器实例与它的回报。 */
async function worklet() {
  const posted: Array<Record<string, unknown>> = [];
  let registered: (new () => Processor) | undefined;
  const scope = globalThis as Record<string, unknown>;
  scope.sampleRate = 48_000;
  scope.AudioWorkletProcessor = class {
    port: Port = {
      onmessage: null,
      postMessage: (message: unknown) => posted.push(message as Record<string, unknown>),
    };
  };
  scope.registerProcessor = (_name: string, processor: new () => Processor) => {
    registered = processor;
  };
  await import(`../page/worklet.js?${Math.random()}`);
  if (!registered) throw new Error('worklet.js 没有注册处理器');
  const processor = new registered();
  const send = (data: unknown) => processor.port.onmessage?.({ data });
  const render = (quanta: number) => {
    const out: number[] = [];
    for (let q = 0; q < quanta; q++) {
      const channels = [new Float32Array(128), new Float32Array(128)];
      processor.process([], [channels]);
      out.push(...(channels[0] as Float32Array));
    }
    return out;
  };
  const kinds = () => posted.map((message) => message.kind);
  return { posted, send, render, kinds };
}

test('AudioWorklet：有许可时按句播放，回报开始、游标与以原始采样数计的结束；补零不推进游标', async () => {
  const w = await worklet();
  w.send({ type: 'hb' });
  w.send({ type: 'lease', ttlMs: 2000 });
  w.send({ type: 'begin', id: 's1' });
  w.send({ type: 'pcm', id: 's1', data: new Float32Array(256).fill(0.5), src: 128 });
  const first = w.render(2);
  assert.ok(first.every((value) => value === 0.5));
  // 数据耗尽但还没收到 end：欠载，补零。
  const gap = w.render(1);
  assert.ok(gap.every((value) => value === 0));
  assert.deepEqual(w.kinds(), ['started', 'underrun']);
  assert.equal(w.posted[1]?.played, 128);
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
