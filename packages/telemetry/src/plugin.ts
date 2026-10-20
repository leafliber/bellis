import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import {
  ClockService,
  DataDirService,
  definePlugin,
  type PluginContext,
  RandomService,
  type TimerHandle,
} from '@bellis/kernel';
import { ChildEnv, type SidecarTelemetry } from '@bellis/protocol';
import Type, { type Static } from 'typebox';
import { TelemetryCore, type TelemetryCoreOptions, type TelemetryWriter } from './core.ts';
import { FileWriter, MemoryWriter } from './file-writer.ts';
import { GENAI_SEMCONV_COMMIT, Metric } from './semconv.ts';
import { TelemetryMemoryService, TelemetryService } from './types.ts';

const VERSION = '0.1.0';

const Queue = {
  /** 等待写出的记录（span 与样本）上限，满了丢弃最旧的。 */
  maxQueue: Type.Integer({ minimum: 1, default: 4096 }),
  /** 一批至多写多少条记录。 */
  batchSize: Type.Integer({ minimum: 1, default: 512 }),
};

export const TelemetryConfig = Type.Object({
  /** 状态存储所在目录下的子目录（相对路径，各段只含字母、数字、`_` 与 `-`，不能跳出数据目录）。 */
  dir: Type.String({ pattern: '^[A-Za-z0-9_-]+(/[A-Za-z0-9_-]+)*$', default: 'telemetry' }),
  maxFileBytes: Type.Integer({ minimum: 65_536, default: 8 * 1024 * 1024 }),
  maxFileAgeMs: Type.Integer({ minimum: 1000, default: 3_600_000 }),
  /** 每个进程（宿主、各个 sidecar）各自最多保留的文件数。 */
  maxFiles: Type.Integer({ minimum: 1, maximum: 1000, default: 24 }),
  ...Queue,
  flushIntervalMs: Type.Integer({ minimum: 1, default: 2000 }),
  /** 事件循环延迟的采样周期（比分辨率 20ms 长得多）；0 表示不采样。 */
  eventLoopIntervalMs: Type.Union([Type.Literal(0), Type.Integer({ minimum: 100 })], {
    default: 10_000,
  }),
});
export type TelemetryConfig = Static<typeof TelemetryConfig>;

/** 事件循环延迟的分辨率（monitorEventLoopDelay 的采样间隔）。 */
const EVENT_LOOP_RESOLUTION_MS = 20;

/** 宿主进程的资源属性。仿真里不写 pid，同一种子两次运行的输出才相同。 */
function resource(ctx: PluginContext, pid: number | undefined): TelemetryCoreOptions['resource'] {
  return {
    'service.name': 'bellis.host',
    'service.instance.id': ctx.instanceId,
    ...(pid === undefined ? {} : { 'process.pid': pid }),
    'telemetry.sdk.name': 'bellis',
    'telemetry.sdk.language': 'nodejs',
    'telemetry.sdk.version': VERSION,
    'bellis.semconv.gen_ai': GENAI_SEMCONV_COMMIT,
  };
}

function start(
  ctx: PluginContext,
  writer: TelemetryWriter,
  options: Pick<TelemetryCoreOptions, 'maxQueue' | 'batchSize' | 'flushIntervalMs'> & {
    pid?: number;
    sidecarEnv?: Record<string, string>;
  },
): TelemetryCore {
  const core = new TelemetryCore({
    clock: ctx.service(ClockService),
    random: ctx.service(RandomService),
    resource: resource(ctx, options.pid),
    writer,
    maxQueue: options.maxQueue,
    batchSize: options.batchSize,
    flushIntervalMs: options.flushIntervalMs,
    ...(options.sidecarEnv ? { sidecarEnv: options.sidecarEnv } : {}),
    log: (event, fields) => ctx.log(event, fields),
  });
  // 停用时写完队列里剩下的再关闭文件；截止时间由内核控制，超时的那部分丢弃。
  ctx.register(() => core.close());
  return core;
}

/**
 * 遥测（普通插件，R-21）：提供 `telemetry@1`，把 span 与直方图按 OTLP/JSON 写成 JSONL，
 * 放在状态存储所在目录下的 `dir` 子目录里，按大小与时间轮转、每个进程保留有限个文件（见 `FileWriter`）。
 * 写不进时丢弃并计数，不阻塞直播。另按 `eventLoopIntervalMs` 采样宿主的事件循环延迟。
 * 拉起 sidecar 的代理插件把 {@link Telemetry.sidecarEnv} 加进子进程环境，sidecar 写进同一目录。
 */
export const telemetry = definePlugin({
  manifest: {
    id: 'telemetry',
    version: VERSION,
    tier: 'ordinary',
    provides: [TelemetryService.ref],
    inject: [ClockService.ref, RandomService.ref, DataDirService.ref],
    permissions: [],
    process: 'in-process',
    config: TelemetryConfig,
  },
  activate(ctx) {
    const config = ctx.config;
    const clock = ctx.service(ClockService);
    const dir = join(ctx.service(DataDirService).path, config.dir);
    const sidecar: SidecarTelemetry = {
      v: 1,
      dir,
      maxFileBytes: config.maxFileBytes,
      maxFileAgeMs: config.maxFileAgeMs,
      maxFiles: config.maxFiles,
      maxQueue: config.maxQueue,
      flushIntervalMs: config.flushIntervalMs,
    };
    const writer = new FileWriter({
      dir,
      role: 'host',
      clock,
      maxFileBytes: config.maxFileBytes,
      maxFileAgeMs: config.maxFileAgeMs,
      maxFiles: config.maxFiles,
    });
    const core = start(ctx, writer, {
      maxQueue: config.maxQueue,
      batchSize: config.batchSize,
      flushIntervalMs: config.flushIntervalMs,
      pid: process.pid,
      sidecarEnv: { [ChildEnv.Telemetry]: JSON.stringify(sidecar) },
    });

    if (config.eventLoopIntervalMs > 0) {
      // 每个周期取这段时间里最大的事件循环延迟作一个样本，然后清零重新统计。monitorEventLoopDelay 记的是
      // 两次采样定时器回调之间的间隔，减去分辨率才是延迟（Windows 的定时器粒度也算在里面）。
      const histogram = monitorEventLoopDelay({ resolution: EVENT_LOOP_RESOLUTION_MS });
      histogram.enable();
      const tracer = core.tracer('telemetry');
      let timer: TimerHandle | undefined;
      const sample = () => {
        timer = clock.setTimeout(sample, config.eventLoopIntervalMs);
        if (histogram.count > 0) {
          const delayMs = Math.max(0, histogram.max / 1e6 - EVENT_LOOP_RESOLUTION_MS);
          tracer.record(Metric.EventLoopDelay, delayMs / 1000, 's');
        }
        histogram.reset();
      };
      timer = clock.setTimeout(sample, config.eventLoopIntervalMs);
      ctx.register(() => {
        if (timer) clock.clearTimeout(timer);
        histogram.disable();
      });
    }
    ctx.log('telemetry.started', { dir: config.dir });
    ctx.provide(TelemetryService, core);
  },
});

/**
 * 写到内存的遥测：确定性仿真与测试用。另提供 `telemetry.memory@1` 读出写出的行。不写文件、不采样事件循环，
 * 也不给 sidecar 环境变量。`flushIntervalMs` 缺省为 0：不设定时器，不改变仿真里定时器的交错。
 */
export const memoryTelemetry = definePlugin({
  manifest: {
    id: 'telemetry-memory',
    version: VERSION,
    tier: 'ordinary',
    provides: [TelemetryService.ref, TelemetryMemoryService.ref],
    inject: [ClockService.ref, RandomService.ref],
    permissions: [],
    process: 'in-process',
    config: Type.Object({
      ...Queue,
      flushIntervalMs: Type.Integer({ minimum: 0, default: 0 }),
    }),
  },
  activate(ctx) {
    const writer = new MemoryWriter();
    const core = start(ctx, writer, ctx.config);
    ctx.provide(TelemetryService, core);
    ctx.provide(TelemetryMemoryService, { lines: writer.lines });
  },
});
