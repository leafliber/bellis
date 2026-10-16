/**
 * S-01 的 OBS 录制分析：OBS 输出端是否断流、出现异常峰值或音高漂移。
 *   node spikes/s01-stage/analyze-recording.ts <录制文件> [--tone 440]
 * 用 ffmpeg 把第一条音轨解码成单声道 48kHz 浮点流，逐段处理，不整段读入内存。
 * 测试音是 0.2 振幅的正弦（约 -14dBFS）；录到的其他声音（系统提示音等）也会算进去，
 * 判读时对照探针时间线与桌面音频的音量表。
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const SAMPLE_RATE = 48_000;
/** 低于这个振幅视为无声；正弦过零附近的无声段远短于 1ms。 */
const SILENCE = 0.005;
const GAP_MIN_SAMPLES = SAMPLE_RATE / 1000;
/** 测试音振幅 0.2，超过 0.5 视为异常峰值。 */
const SPIKE = 0.5;
const WINDOW_SECONDS = 10;
const MAX_LISTED = 200;

export interface RecordingAnalysis {
  file: string;
  seconds: number;
  gaps: { count: number; totalMs: number; listed: Array<{ atSeconds: number; ms: number }> };
  spikes: { count: number; listed: Array<{ atSeconds: number; value: number }> };
  /** 每个窗口的估计频率；窗口内有断流时仍会给出，判读时对照断流列表。 */
  windows: Array<{ atSeconds: number; hz: number | null; rms: number }>;
  hz: { min: number; max: number; maxCentsOff: number } | null;
}

export async function analyzeRecording(file: string, toneHz = 440): Promise<RecordingAnalysis> {
  const ffmpeg = spawn(
    'ffmpeg',
    ['-v', 'error', '-i', file, '-map', '0:a:0', '-ac', '1', '-ar', String(SAMPLE_RATE)].concat([
      '-f',
      'f32le',
      'pipe:1',
    ]),
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );
  let stderr = '';
  ffmpeg.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });

  let n = 0;
  let previous = 0;
  let silentRun = 0;
  const gaps: RecordingAnalysis['gaps'] = { count: 0, totalMs: 0, listed: [] };
  const spikes: RecordingAnalysis['spikes'] = { count: 0, listed: [] };
  const windows: RecordingAnalysis['windows'] = [];
  let windowStart = 0;
  let lastCrossing: number | undefined;
  /** 窗口内相邻上升过零点的间隔（样本数）；取中位数估计频率，不受断流影响。 */
  let intervals: number[] = [];
  let sumSquares = 0;
  let carry: Buffer = Buffer.alloc(0);

  const closeWindow = () => {
    const samples = n - windowStart;
    if (samples === 0) return;
    const sorted = intervals.sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const hz = median ? SAMPLE_RATE / median : null;
    windows.push({
      atSeconds: windowStart / SAMPLE_RATE,
      hz: hz === null ? null : Math.round(hz * 1000) / 1000,
      rms: Math.round(Math.sqrt(sumSquares / samples) * 10_000) / 10_000,
    });
    windowStart = n;
    intervals = [];
    sumSquares = 0;
  };
  const endGap = () => {
    if (silentRun >= GAP_MIN_SAMPLES) {
      gaps.count += 1;
      const ms = (silentRun * 1000) / SAMPLE_RATE;
      gaps.totalMs += ms;
      if (gaps.listed.length < MAX_LISTED)
        gaps.listed.push({ atSeconds: (n - silentRun) / SAMPLE_RATE, ms });
    }
    silentRun = 0;
  };

  for await (const chunk of ffmpeg.stdout as AsyncIterable<Buffer>) {
    const data = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
    const usable = data.length - (data.length % 4);
    for (let offset = 0; offset < usable; offset += 4) {
      const x = data.readFloatLE(offset);
      if (Math.abs(x) < SILENCE) silentRun += 1;
      else endGap();
      if (Math.abs(x) > SPIKE) {
        spikes.count += 1;
        if (spikes.listed.length < MAX_LISTED)
          spikes.listed.push({ atSeconds: n / SAMPLE_RATE, value: Math.round(x * 1000) / 1000 });
      }
      if (previous < 0 && x >= 0) {
        // 上升过零点，线性插值到样本之间。
        const at = n - 1 + previous / (previous - x);
        if (lastCrossing !== undefined) intervals.push(at - lastCrossing);
        lastCrossing = at;
      }
      sumSquares += x * x;
      previous = x;
      n += 1;
      if (n - windowStart >= WINDOW_SECONDS * SAMPLE_RATE) closeWindow();
    }
    carry = data.subarray(usable);
  }
  endGap();
  closeWindow();
  const code = await new Promise<number | null>((done) => ffmpeg.once('close', done));
  if (code !== 0) throw new Error(`ffmpeg 失败（${code}）：${stderr.trim()}`);

  // 只用基本是测试音的窗口估计音高：频率在 ±5% 内。
  const tonal = windows
    .map((w) => w.hz)
    .filter((hz): hz is number => hz !== null && Math.abs(hz / toneHz - 1) < 0.05);
  const cents = (hz: number) => 1200 * Math.log2(hz / toneHz);
  return {
    file,
    seconds: n / SAMPLE_RATE,
    gaps,
    spikes,
    windows,
    hz:
      tonal.length === 0
        ? null
        : {
            min: Math.min(...tonal),
            max: Math.max(...tonal),
            maxCentsOff:
              Math.round(Math.max(...tonal.map((hz) => Math.abs(cents(hz)))) * 1000) / 1000,
          },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { tone: { type: 'string', default: '440' } },
  });
  const file = positionals[0];
  if (!file) throw new Error('用法：analyze-recording.ts <录制文件> [--tone 440]');
  const result = await analyzeRecording(file, Number(values.tone));
  console.log(JSON.stringify({ ...result, windows: result.windows.length }, null, 2));
}
