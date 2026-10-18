interface Port {
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage(message: unknown): void;
}

/** worklet.js 里的处理器；`queue` 与 `played` 是内部状态，测试用来读出真实的游标。 */
export interface Processor {
  port: Port;
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
  queue: Array<{ id: string; started: boolean }>;
  played(sentence: unknown): number;
}

/**
 * 在 Node 里模拟 AudioWorkletGlobalScope（48kHz），加载 worklet.js，返回一个处理器实例与它的回报。
 * `postedAt[i]` 是第 i 条回报发出时已渲染的帧数。
 */
export async function worklet() {
  const posted: Array<Record<string, unknown>> = [];
  const postedAt: number[] = [];
  let rendered = 0;
  let registered: (new () => Processor) | undefined;
  const scope = globalThis as Record<string, unknown>;
  scope.sampleRate = 48_000;
  scope.AudioWorkletProcessor = class {
    port: Port = {
      onmessage: null,
      postMessage: (message: unknown) => {
        posted.push(message as Record<string, unknown>);
        postedAt.push(rendered);
      },
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
      rendered += 128;
      out.push(...(channels[0] as Float32Array));
    }
    return out;
  };
  const kinds = () => posted.map((message) => message.kind);
  /** 队首句子此刻真实的已播采样数；还没开始时为 0。 */
  const cursor = () => {
    const head = processor.queue[0];
    return head?.started ? processor.played(head) : 0;
  };
  return { processor, posted, postedAt, send, render, kinds, cursor, rendered: () => rendered };
}

export type Worklet = Awaited<ReturnType<typeof worklet>>;

/** 唤醒信号：48kHz 下 150ms 的帧数与峰值（见 worklet.js 文件头）。 */
export const WAKE_FRAMES = 7200;
export const WAKE_PEAK = 10 ** (-50 / 20);
