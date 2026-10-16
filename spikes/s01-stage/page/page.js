// 探针 S-01 的页面：自检、用 AudioWorklet 播放宿主送来的 PCM、回报游标与心跳应答。
// 令牌在 URL 片段里，读出后立即从地址中去掉（R-08）。

const token = new URLSearchParams(location.hash.slice(1)).get('t');
history.replaceState(null, '', location.pathname);

const status = document.getElementById('status');
const show = (text) => {
  status.textContent = text;
};

const selfCheck = {
  isSecureContext: globalThis.isSecureContext,
  crossOriginIsolated: globalThis.crossOriginIsolated,
  audioWorklet: typeof AudioWorkletNode === 'function',
  subtle: Boolean(globalThis.crypto?.subtle),
  randomUUID: typeof globalThis.crypto?.randomUUID === 'function',
  sharedArrayBuffer: typeof SharedArrayBuffer === 'function',
  userAgent: navigator.userAgent,
  obsPluginVersion: globalThis.obsstudio?.pluginVersion ?? null,
};

async function start() {
  const ctx = new AudioContext({ latencyHint: 'playback' });
  if (ctx.state !== 'running') await ctx.resume().catch(() => {});
  // OBS 浏览器源允许自动播放；普通浏览器里要点一下页面才能开始出声。
  document.addEventListener('click', () => ctx.resume());
  await ctx.audioWorklet.addModule('/worklet.js');
  const node = new AudioWorkletNode(ctx, 'bellis-s01', { outputChannelCount: [2] });
  node.connect(ctx.destination);

  const ws = new WebSocket(`ws://${location.host}/stage`);
  ws.binaryType = 'arraybuffer';
  const send = (message) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  };
  ws.onopen = () => {
    send({
      type: 'hello',
      token,
      selfCheck: {
        ...selfCheck,
        sampleRate: ctx.sampleRate,
        baseLatency: ctx.baseLatency,
        outputLatency: ctx.outputLatency ?? null,
        contextState: ctx.state,
      },
    });
    show('已连接');
  };
  ws.onmessage = (event) => {
    if (typeof event.data !== 'string') {
      node.port.postMessage({ type: 'pcm', data: event.data }, [event.data]);
      return;
    }
    const message = JSON.parse(event.data);
    if (message.type === 'hb') {
      node.port.postMessage({ type: 'hb' });
      send({ type: 'hb-ack', seq: message.seq });
    }
  };
  ws.onclose = (event) => show(`连接关闭 ${event.code} ${event.reason}`);
  node.port.onmessage = (event) => {
    const stamp = ctx.getOutputTimestamp();
    send({
      ...event.data,
      perf: performance.now(),
      contextTime: ctx.currentTime,
      outputContextTime: stamp.contextTime ?? null,
      outputPerformanceTime: stamp.performanceTime ?? null,
      visibility: document.visibilityState,
    });
  };
}

start().catch((error) => show(`启动失败：${error}`));
