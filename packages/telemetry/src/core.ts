import type { Clock, Random } from '@bellis/kernel';
import {
  type Attributes,
  type AttributeValue,
  filterAttributes,
  nameAllowed,
} from './attributes.ts';
import { formatTraceparent, newSpanId, newTraceId, parseTraceparent } from './traceparent.ts';
import {
  type Span,
  type SpanKind,
  type SpanOptions,
  type SpanParent,
  type Telemetry,
  type Tracer,
  traceparentOf,
} from './types.ts';

/**
 * 自写的最小遥测实现（R-21，不引入 OpenTelemetry SDK）：生成 span 与直方图样本，按 OTLP/JSON 的结构
 * 分批写成 JSONL。每批至多两行：一行 `ExportTraceServiceRequest`（`resourceSpans`），
 * 一行 `ExportMetricsServiceRequest`（`resourceMetrics`）。
 *
 * - trace ID 与 span ID 取自随机数服务，时间取自时钟服务：确定性仿真里同一种子两次运行的输出完全相同。
 *   时间戳是 Unix 纳秒（时钟零点的 Unix 毫秒加单调时钟），按 protobuf 的 JSON 映射写成十进制字符串。
 * - 有界队列：等待写出的记录满了丢弃最旧的并计数；同时只有一批在写，写的时候新记录留在队列里。
 * - 写失败：这一批丢弃，计数，只在第一次记日志；从不抛给调用方，也不阻塞。
 * - 直方图：每批里同一指标、同一组属性的样本合成一个增量（DELTA）数据点，区间从上一批写出到这一批；
 *   每个样本另作一个 exemplar（原值与时刻，关联的 span），查看工具据此算精确的分位数。
 */

/** OTLP/JSON 的属性值。64 位整数按 protobuf 的 JSON 映射写成字符串。 */
export type OtlpAnyValue =
  | { stringValue: string }
  | { intValue: string }
  | { doubleValue: number }
  | { boolValue: boolean };

export interface OtlpKeyValue {
  key: string;
  value: OtlpAnyValue;
}

export interface OtlpEvent {
  timeUnixNano: string;
  name: string;
  attributes?: OtlpKeyValue[];
  droppedAttributesCount?: number;
}

export interface OtlpLink {
  traceId: string;
  spanId: string;
}

export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes?: OtlpKeyValue[];
  droppedAttributesCount?: number;
  events?: OtlpEvent[];
  droppedEventsCount?: number;
  links?: OtlpLink[];
  droppedLinksCount?: number;
  /** 0 UNSET，2 ERROR；不写 message（可能带内容）。 */
  status: { code: 0 | 2 };
}

export interface OtlpExemplar {
  timeUnixNano: string;
  asDouble: number;
  traceId?: string;
  spanId?: string;
}

export interface OtlpHistogramPoint {
  attributes?: OtlpKeyValue[];
  startTimeUnixNano: string;
  timeUnixNano: string;
  count: string;
  sum: number;
  min: number;
  max: number;
  bucketCounts: string[];
  explicitBounds: number[];
  exemplars: OtlpExemplar[];
}

/** OTLP 的 SpanKind 与 AggregationTemporality 按枚举的整数值写。 */
const KIND: Readonly<Record<SpanKind, number>> = {
  internal: 1,
  server: 2,
  client: 3,
  producer: 4,
  consumer: 5,
};
const DELTA = 1;

/** 每个 span 的属性、事件、关联上限（与 OpenTelemetry SDK 的缺省一致），超出的计入 dropped。 */
const MAX_ATTRIBUTES = 128;
const MAX_EVENTS = 128;
const MAX_LINKS = 128;

const METRIC_NAME = /^[A-Za-z][A-Za-z0-9_./-]{0,254}$/;
const UNIT = /^[\x21-\x7e]{0,63}$/;

/** 直方图的桶边界：时长（秒）按 OpenTelemetry 语义约定建议的边界，其余用 SDK 缺省。 */
const BOUNDS: Readonly<Record<string, readonly number[]>> = {
  s: [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10],
};
const DEFAULT_BOUNDS = [0, 5, 10, 25, 50, 75, 100, 250, 500, 750, 1000, 2500, 5000, 7500, 10000];

export interface TelemetryWriter {
  /** 写一批：若干行，每行一个 OTLP/JSON 导出请求，以换行结尾。出错时抛出或以拒绝告知。 */
  write(chunk: string): void | Promise<void>;
  close(): void | Promise<void>;
}

export interface TelemetryCoreOptions {
  clock: Clock;
  random: Random;
  /** 资源属性（进程级，由本模块填写，不经准入规则）。 */
  resource: Readonly<Record<string, string | number | boolean>>;
  writer: TelemetryWriter;
  /** 等待写出的记录（span 与样本）上限。 */
  maxQueue: number;
  /** 一批至多写多少条记录；攒够即写。 */
  batchSize: number;
  /** 分批写出的间隔（时钟上的毫秒）；0 表示本轮同步代码结束后（微任务）就写，不设定时器。 */
  flushIntervalMs: number;
  sidecarEnv?: Readonly<Record<string, string>>;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

export interface TelemetryStats {
  /** 已结束并排队的 span。 */
  spans: number;
  /** 已排队的直方图样本。 */
  samples: number;
  /** 队列满时丢弃的最旧记录。 */
  dropped: number;
  /** 写失败的批次与其中丢失的记录。 */
  writeFailures: number;
  lost: number;
  /** 已写出的行。 */
  lines: number;
  /** 被准入规则拒绝的属性，与名字、单位或数值不合格而丢弃的样本。 */
  droppedAttributes: number;
  rejectedSamples: number;
}

type QueuedRecord =
  | { kind: 'span'; scope: string; span: OtlpSpan }
  | {
      kind: 'sample';
      scope: string;
      name: string;
      unit: string;
      value: number;
      attributes: OtlpKeyValue[];
      at: string;
      traceId: string | undefined;
      spanId: string | undefined;
    };

export function encodeValue(value: AttributeValue): OtlpAnyValue {
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { boolValue: value };
  return Number.isSafeInteger(value) ? { intValue: String(value) } : { doubleValue: value };
}

function encodeAttributes(pairs: Iterable<[string, AttributeValue]>): OtlpKeyValue[] {
  return [...pairs].map(([key, value]) => ({ key, value: encodeValue(value) }));
}

function message(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return error instanceof Error ? error.name : 'unknown';
}

export class TelemetryCore implements Telemetry {
  readonly #options: TelemetryCoreOptions;
  readonly #tracers = new Map<string, Tracer>();
  readonly #queue: QueuedRecord[] = [];
  readonly #resource: OtlpKeyValue[];
  readonly #stats: TelemetryStats = {
    spans: 0,
    samples: 0,
    dropped: 0,
    writeFailures: 0,
    lost: 0,
    lines: 0,
    droppedAttributes: 0,
    rejectedSamples: 0,
  };
  #windowStart: string;
  #timer: ReturnType<Clock['setTimeout']> | undefined;
  #microtask = false;
  #writing: Promise<void> | undefined;
  #closed = false;
  #warnedFull = false;
  #warnedWrite = false;

  constructor(options: TelemetryCoreOptions) {
    this.#options = options;
    this.#resource = encodeAttributes(Object.entries(options.resource));
    this.#windowStart = this.unixNano(options.clock.now());
  }

  /** 时钟上的毫秒换算成 Unix 纳秒（十进制字符串）。 */
  unixNano(ms: number): string {
    const unixMs = (this.#options.clock.epochMs ?? 0) + ms;
    const whole = Math.floor(unixMs);
    const fraction = Math.round((unixMs - whole) * 1e6);
    return (BigInt(whole) * 1_000_000n + BigInt(fraction)).toString();
  }

  tracer(scope: string): Tracer {
    let tracer = this.#tracers.get(scope);
    if (!tracer) {
      tracer = {
        startSpan: (name, options) => this.#startSpan(scope, name, options),
        record: (name, value, unit, attributes, context) =>
          this.#record(scope, name, value, unit, attributes, context),
      };
      this.#tracers.set(scope, tracer);
    }
    return tracer;
  }

  sidecarEnv(): Readonly<Record<string, string>> {
    return this.#options.sidecarEnv ?? {};
  }

  stats(): TelemetryStats {
    return { ...this.#stats };
  }

  /** 若没有在写，立即写出一批。 */
  flush(): void {
    if (this.#writing || this.#queue.length === 0) return;
    this.#cancelTimer();
    const batch = this.#queue.splice(0, this.#options.batchSize);
    let written: { lines: number; result: void | Promise<void> };
    try {
      const chunk = this.#encode(batch);
      written = { lines: chunk.split('\n').length - 1, result: this.#options.writer.write(chunk) };
    } catch (error) {
      this.#failed(error, batch.length);
      this.#continue();
      return;
    }
    const { lines, result } = written;
    if (!(result instanceof Promise)) {
      this.#stats.lines += lines;
      this.#continue();
      return;
    }
    this.#writing = result
      .then(
        () => {
          this.#stats.lines += lines;
        },
        (error: unknown) => this.#failed(error, batch.length),
      )
      .then(() => {
        this.#writing = undefined;
        this.#continue();
      });
  }

  /** 停止：不再接收新记录，写完队列里剩下的，关闭输出。 */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#cancelTimer();
    for (let guard = 0; guard < 1_000_000; guard += 1) {
      if (this.#writing) await this.#writing;
      else if (this.#queue.length > 0) this.flush();
      else break;
    }
    try {
      await this.#options.writer.close();
    } catch (error) {
      this.#options.log?.('telemetry.close-failed', { error: message(error) });
    }
    this.#options.log?.('telemetry.stopped', { ...this.#stats });
  }

  /** 一批写完（或失败）之后：停止中或又攒够一批就接着写，否则等下一次定时。 */
  #continue(): void {
    if (this.#queue.length === 0) return;
    if (this.#closed || this.#queue.length >= this.#options.batchSize) this.flush();
    else this.#schedule();
  }

  #failed(error: unknown, records: number): void {
    this.#stats.writeFailures += 1;
    this.#stats.lost += records;
    if (this.#warnedWrite) return;
    this.#warnedWrite = true;
    this.#options.log?.('telemetry.write-failed', { error: message(error), records });
  }

  #cancelTimer(): void {
    if (this.#timer) this.#options.clock.clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #enqueue(record: QueuedRecord): void {
    if (this.#closed) return;
    if (this.#queue.length >= this.#options.maxQueue) {
      this.#queue.shift();
      this.#stats.dropped += 1;
      if (!this.#warnedFull) {
        this.#warnedFull = true;
        this.#options.log?.('telemetry.queue-full', { maxQueue: this.#options.maxQueue });
      }
    }
    this.#queue.push(record);
    if (record.kind === 'span') this.#stats.spans += 1;
    else this.#stats.samples += 1;
    if (!this.#writing) this.#schedule();
  }

  #schedule(): void {
    if (this.#queue.length >= this.#options.batchSize) {
      this.flush();
      return;
    }
    if (this.#options.flushIntervalMs === 0) {
      if (this.#microtask) return;
      this.#microtask = true;
      queueMicrotask(() => {
        this.#microtask = false;
        this.flush();
      });
      return;
    }
    this.#timer ??= this.#options.clock.setTimeout(() => {
      this.#timer = undefined;
      this.flush();
    }, this.#options.flushIntervalMs);
  }

  #startSpan(scope: string, name: string, options: SpanOptions = {}): Span {
    const { clock, random } = this.#options;
    const parent = parseTraceparent(traceparentOf(options.parent));
    const traceId = parent?.traceId ?? newTraceId(random);
    const spanId = newSpanId(random);
    const start = this.unixNano(clock.now());
    const attributes = new Map<string, AttributeValue>();
    const events: OtlpEvent[] = [];
    const links: OtlpLink[] = [];
    let droppedAttributes = 0;
    let droppedEvents = 0;
    let droppedLinks = 0;
    let status: 0 | 2 = 0;
    let ended = false;

    const set = (input: Attributes | undefined) => {
      const { accepted, dropped } = filterAttributes(input);
      droppedAttributes += dropped;
      for (const [key, value] of accepted) {
        if (!attributes.has(key) && attributes.size >= MAX_ATTRIBUTES) droppedAttributes += 1;
        else attributes.set(key, value);
      }
    };
    const link = (target: SpanParent | undefined) => {
      const context = parseTraceparent(traceparentOf(target));
      if (!context) return;
      if (links.length >= MAX_LINKS) droppedLinks += 1;
      else links.push({ traceId: context.traceId, spanId: context.spanId });
    };
    set(options.attributes);
    for (const target of options.links ?? []) link(target);

    const span: Span = {
      traceparent: formatTraceparent({ traceId, spanId, sampled: true }),
      setAttributes: (input) => {
        if (!ended) set(input);
      },
      addEvent: (eventName, input) => {
        if (ended) return;
        if (events.length >= MAX_EVENTS || !nameAllowed(eventName)) {
          droppedEvents += 1;
          return;
        }
        const filtered = filterAttributes(input);
        events.push({
          timeUnixNano: this.unixNano(clock.now()),
          name: eventName,
          ...(filtered.accepted.length > 0
            ? { attributes: encodeAttributes(filtered.accepted) }
            : {}),
          ...(filtered.dropped > 0 ? { droppedAttributesCount: filtered.dropped } : {}),
        });
      },
      addLink: (target) => {
        if (!ended) link(target);
      },
      fail: (errorType) => {
        if (ended) return;
        status = 2;
        set({ 'error.type': errorType });
      },
      end: () => {
        if (ended) return;
        ended = true;
        this.#stats.droppedAttributes += droppedAttributes;
        this.#enqueue({
          kind: 'span',
          scope,
          span: {
            traceId,
            spanId,
            ...(parent ? { parentSpanId: parent.spanId } : {}),
            name: nameAllowed(name) ? name : 'bellis.unnamed',
            kind: KIND[options.kind ?? 'internal'],
            startTimeUnixNano: start,
            endTimeUnixNano: this.unixNano(clock.now()),
            ...(attributes.size > 0 ? { attributes: encodeAttributes(attributes) } : {}),
            ...(droppedAttributes > 0 ? { droppedAttributesCount: droppedAttributes } : {}),
            ...(events.length > 0 ? { events } : {}),
            ...(droppedEvents > 0 ? { droppedEventsCount: droppedEvents } : {}),
            ...(links.length > 0 ? { links } : {}),
            ...(droppedLinks > 0 ? { droppedLinksCount: droppedLinks } : {}),
            status: { code: status },
          },
        });
      },
    };
    return span;
  }

  #record(
    scope: string,
    name: string,
    value: number,
    unit: string,
    attributes: Attributes | undefined,
    context: SpanParent | undefined,
  ): void {
    if (this.#closed) return;
    if (!METRIC_NAME.test(name) || !UNIT.test(unit) || !Number.isFinite(value)) {
      this.#stats.rejectedSamples += 1;
      return;
    }
    const filtered = filterAttributes(attributes);
    this.#stats.droppedAttributes += filtered.dropped;
    const linked = parseTraceparent(traceparentOf(context));
    this.#enqueue({
      kind: 'sample',
      scope,
      name,
      unit,
      value,
      attributes: encodeAttributes(filtered.accepted),
      at: this.unixNano(this.#options.clock.now()),
      traceId: linked?.traceId,
      spanId: linked?.spanId,
    });
  }

  #encode(batch: readonly QueuedRecord[]): string {
    const spans = new Map<string, OtlpSpan[]>();
    const metrics = new Map<
      string,
      Map<string, { name: string; unit: string; points: Map<string, Sample[]> }>
    >();
    for (const record of batch) {
      if (record.kind === 'span') {
        const list = spans.get(record.scope) ?? [];
        list.push(record.span);
        spans.set(record.scope, list);
        continue;
      }
      const byName = metrics.get(record.scope) ?? new Map();
      metrics.set(record.scope, byName);
      const key = `${record.name}\u0000${record.unit}`;
      const metric = byName.get(key) ?? {
        name: record.name,
        unit: record.unit,
        points: new Map(),
      };
      byName.set(key, metric);
      const attributesKey = JSON.stringify(record.attributes);
      const samples = metric.points.get(attributesKey) ?? [];
      samples.push(record);
      metric.points.set(attributesKey, samples);
    }

    const resource = this.#resource.length > 0 ? { attributes: this.#resource } : {};
    let out = '';
    if (spans.size > 0) {
      out += `${JSON.stringify({
        resourceSpans: [
          {
            resource,
            scopeSpans: [...spans].map(([scope, list]) => ({
              scope: { name: scope },
              spans: list,
            })),
          },
        ],
      })}\n`;
    }
    if (metrics.size > 0) {
      const now = this.unixNano(this.#options.clock.now());
      const start = this.#windowStart;
      this.#windowStart = now;
      out += `${JSON.stringify({
        resourceMetrics: [
          {
            resource,
            scopeMetrics: [...metrics].map(([scope, byName]) => ({
              scope: { name: scope },
              metrics: [...byName.values()].map((metric) => ({
                name: metric.name,
                unit: metric.unit,
                histogram: {
                  aggregationTemporality: DELTA,
                  dataPoints: [...metric.points.values()].map((samples) =>
                    point(samples, metric.unit, start, now),
                  ),
                },
              })),
            })),
          },
        ],
      })}\n`;
    }
    return out;
  }
}

type Sample = Extract<QueuedRecord, { kind: 'sample' }>;

function point(
  samples: readonly Sample[],
  unit: string,
  start: string,
  time: string,
): OtlpHistogramPoint {
  const bounds = BOUNDS[unit] ?? DEFAULT_BOUNDS;
  const counts = new Array<number>(bounds.length + 1).fill(0);
  let sum = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const { value } of samples) {
    sum += value;
    min = Math.min(min, value);
    max = Math.max(max, value);
    const index = bounds.findIndex((bound) => value <= bound);
    const bucket = index < 0 ? bounds.length : index;
    counts[bucket] = (counts[bucket] ?? 0) + 1;
  }
  const first = samples[0];
  return {
    ...(first && first.attributes.length > 0 ? { attributes: first.attributes } : {}),
    startTimeUnixNano: start,
    timeUnixNano: time,
    count: String(samples.length),
    sum,
    min,
    max,
    bucketCounts: counts.map(String),
    explicitBounds: [...bounds],
    exemplars: samples.map((sample) => ({
      timeUnixNano: sample.at,
      asDouble: sample.value,
      ...(sample.traceId && sample.spanId
        ? { traceId: sample.traceId, spanId: sample.spanId }
        : {}),
    })),
  };
}
