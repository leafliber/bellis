import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AttributeValue } from './attributes.ts';

/**
 * 读遥测的 JSONL（宿主与 sidecar 的文件，或 Collector 的 file 导出）：直方图的样本数与分位数，
 * 按 trace 列出 span 树。只读 OTLP/JSON 里的结构与属性；写出时内容已被拒绝，这里也不打印别的。
 */

export interface ViewSpan {
  service: string;
  scope: string;
  traceId: string;
  spanId: string;
  parentSpanId: string | undefined;
  name: string;
  start: bigint;
  end: bigint;
  attributes: Record<string, AttributeValue>;
  events: Array<{ name: string; time: bigint }>;
  links: Array<{ traceId: string; spanId: string }>;
  error: boolean;
}

export interface ViewMetric {
  name: string;
  unit: string;
  /** exemplar 里的原值。 */
  values: number[];
  /** 数据点的 count 之和；比原值多时，多出的样本没有原值（例如别处聚合过的数据）。 */
  count: number;
}

export interface TelemetryView {
  spans: ViewSpan[];
  metrics: Map<string, ViewMetric>;
  lines: number;
  invalid: number;
  files: number;
}

export function emptyView(): TelemetryView {
  return { spans: [], metrics: new Map(), lines: 0, invalid: 0, files: 0 };
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** OTLP/JSON 的属性值（见 `OtlpAnyValue`）；64 位整数可能写成字符串。 */
function decodeValue(value: unknown): AttributeValue | undefined {
  if (!isObject(value)) return undefined;
  if (typeof value.stringValue === 'string') return value.stringValue;
  if (typeof value.boolValue === 'boolean') return value.boolValue;
  if (typeof value.doubleValue === 'number') return value.doubleValue;
  if (typeof value.intValue === 'string' || typeof value.intValue === 'number')
    return Number(value.intValue);
  return undefined;
}

function decodeAttributes(value: unknown): Record<string, AttributeValue> {
  const out: Record<string, AttributeValue> = {};
  for (const item of list(value)) {
    if (!isObject(item) || typeof item.key !== 'string') continue;
    const decoded = decodeValue(item.value);
    if (decoded !== undefined) out[item.key] = decoded;
  }
  return out;
}

function nanos(value: unknown): bigint {
  try {
    return typeof value === 'string' || typeof value === 'number' ? BigInt(value) : 0n;
  } catch {
    return 0n;
  }
}

/** 解析若干行 OTLP/JSON，累加到 view 里。不是 JSON 或不是导出请求的行计为不合格。 */
export function parseLines(lines: Iterable<string>, view = emptyView()): TelemetryView {
  for (const line of lines) {
    if (line.trim() === '') continue;
    view.lines += 1;
    let request: unknown;
    try {
      request = JSON.parse(line);
    } catch {
      view.invalid += 1;
      continue;
    }
    if (!isObject(request) || !('resourceSpans' in request || 'resourceMetrics' in request)) {
      view.invalid += 1;
      continue;
    }
    for (const resource of list(request.resourceSpans)) {
      if (!isObject(resource)) continue;
      const service = String(
        decodeAttributes(isObject(resource.resource) ? resource.resource.attributes : [])[
          'service.name'
        ] ?? '?',
      );
      for (const scoped of list(resource.scopeSpans)) {
        if (!isObject(scoped)) continue;
        const scope = isObject(scoped.scope) ? String(scoped.scope.name ?? '') : '';
        for (const span of list(scoped.spans)) {
          if (!isObject(span)) continue;
          view.spans.push({
            service,
            scope,
            traceId: String(span.traceId ?? ''),
            spanId: String(span.spanId ?? ''),
            parentSpanId:
              typeof span.parentSpanId === 'string' && span.parentSpanId !== ''
                ? span.parentSpanId
                : undefined,
            name: String(span.name ?? ''),
            start: nanos(span.startTimeUnixNano),
            end: nanos(span.endTimeUnixNano),
            attributes: decodeAttributes(span.attributes),
            events: list(span.events)
              .filter(isObject)
              .map((event) => ({
                name: String(event.name ?? ''),
                time: nanos(event.timeUnixNano),
              })),
            links: list(span.links)
              .filter(isObject)
              .map((link) => ({ traceId: String(link.traceId), spanId: String(link.spanId) })),
            error: isObject(span.status) && span.status.code === 2,
          });
        }
      }
    }
    for (const resource of list(request.resourceMetrics)) {
      if (!isObject(resource)) continue;
      for (const scoped of list(resource.scopeMetrics)) {
        if (!isObject(scoped)) continue;
        for (const metric of list(scoped.metrics)) {
          if (!isObject(metric) || !isObject(metric.histogram)) continue;
          const name = String(metric.name ?? '');
          const unit = String(metric.unit ?? '');
          const key = `${name} ${unit}`;
          const entry = view.metrics.get(key) ?? { name, unit, values: [], count: 0 };
          view.metrics.set(key, entry);
          for (const point of list(metric.histogram.dataPoints)) {
            if (!isObject(point)) continue;
            entry.count += Number(point.count ?? 0);
            for (const exemplar of list(point.exemplars)) {
              if (isObject(exemplar) && typeof exemplar.asDouble === 'number')
                entry.values.push(exemplar.asDouble);
            }
          }
        }
      }
    }
  }
  return view;
}

/** 读目录里全部 `.jsonl` 文件（按文件名排序）。 */
export async function loadDir(dir: string): Promise<TelemetryView> {
  const view = emptyView();
  const names = (await readdir(dir)).filter((name) => name.endsWith('.jsonl')).sort();
  for (const name of names) {
    view.files += 1;
    parseLines((await readFile(join(dir, name), 'utf8')).split('\n'), view);
  }
  return view;
}

/** 最近秩法的分位数：升序样本里第 ⌈q·n⌉ 个。 */
export function percentile(sorted: readonly number[], q: number): number | undefined {
  if (sorted.length === 0) return undefined;
  const rank = Math.max(1, Math.ceil(q * sorted.length));
  return sorted[Math.min(sorted.length, rank) - 1];
}

/** 时长（秒）换成毫秒打印，其余按原单位。 */
function show(value: number | undefined, unit: string): string {
  if (value === undefined) return '-';
  if (unit === 's') return `${(value * 1000).toFixed(1)}ms`;
  return `${Number.isInteger(value) ? value : value.toFixed(3)}${unit === '1' ? '' : unit}`;
}

function iso(ns: bigint): string {
  return new Date(Number(ns / 1_000_000n)).toISOString();
}

/** 各直方图的样本数与 p50/p95/p99，以及最近的弹幕链路。 */
export function formatSummary(view: TelemetryView): string {
  const traces = new Set(view.spans.map((span) => span.traceId));
  const out = [
    `遥测：${view.files} 个文件，${view.lines} 行（不合格 ${view.invalid} 行）；span ${view.spans.length} 个，trace ${traces.size} 条`,
    '直方图（样本数，p50 / p95 / p99，最近秩法；时长以毫秒显示，失败样本不剔除）：',
  ];
  const metrics = [...view.metrics.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
  if (metrics.length === 0) out.push('  （没有）');
  for (const metric of metrics) {
    const sorted = [...metric.values].sort((a, b) => a - b);
    const missing = metric.count - sorted.length;
    out.push(
      `  ${metric.name}  n=${sorted.length}  p50 ${show(percentile(sorted, 0.5), metric.unit)}  p95 ${show(percentile(sorted, 0.95), metric.unit)}  p99 ${show(percentile(sorted, 0.99), metric.unit)}${missing > 0 ? `（另有 ${missing} 个样本没有原值）` : ''}`,
    );
  }
  const roots = view.spans
    .filter((span) => span.name === 'danmaku.receive' && span.parentSpanId === undefined)
    .sort((a, b) => (a.start < b.start ? 1 : -1))
    .slice(0, 10);
  out.push('最近的弹幕链路（最多 10 条，用 trace 子命令查看）：');
  if (roots.length === 0) out.push('  （没有）');
  for (const root of roots) {
    const count = view.spans.filter((span) => span.traceId === root.traceId).length;
    out.push(`  ${root.traceId}  ${iso(root.start)}  span ${count} 个`);
  }
  return out.join('\n');
}

function formatAttributes(attributes: Record<string, AttributeValue>): string {
  return Object.entries(attributes)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ');
}

/** 按 trace（完整编号或至少 8 位的前缀）打印 span 树：名字、进程、相对开始、耗时、属性、事件与关联。 */
export function formatTrace(view: TelemetryView, id: string): string {
  if (!/^[0-9a-f]{8,32}$/.test(id))
    return `trace 编号不合格：${id}（32 位十六进制，或至少 8 位前缀）`;
  const ids = [...new Set(view.spans.map((s) => s.traceId))].filter((t) => t.startsWith(id));
  if (ids.length === 0) return `没有找到 trace ${id}`;
  if (ids.length > 1) return `前缀 ${id} 对应多条 trace：\n${ids.map((t) => `  ${t}`).join('\n')}`;
  const traceId = ids[0] as string;
  const spans = view.spans.filter((span) => span.traceId === traceId);
  const base = spans.reduce(
    (min, span) => (span.start < min ? span.start : min),
    spans[0]?.start ?? 0n,
  );
  const ms = (ns: bigint) => (Number(ns - base) / 1e6).toFixed(1);
  const ids16 = new Set(spans.map((span) => span.spanId));
  const children = new Map<string | undefined, ViewSpan[]>();
  for (const span of spans) {
    const parent =
      span.parentSpanId !== undefined && ids16.has(span.parentSpanId)
        ? span.parentSpanId
        : undefined;
    const siblings = children.get(parent) ?? [];
    siblings.push(span);
    children.set(parent, siblings);
  }
  for (const siblings of children.values()) siblings.sort((a, b) => (a.start < b.start ? -1 : 1));
  const out = [`trace ${traceId}（${spans.length} 个 span，从 ${iso(base)} 起）`];
  const walk = (span: ViewSpan, depth: number) => {
    const indent = '  '.repeat(depth);
    const orphan =
      span.parentSpanId !== undefined && !ids16.has(span.parentSpanId)
        ? '（父 span 不在文件里）'
        : '';
    out.push(
      `${indent}${span.name}  [${span.service}]  +${ms(span.start)}ms  ${(Number(span.end - span.start) / 1e6).toFixed(1)}ms${span.error ? '  ERROR' : ''}${orphan}  ${formatAttributes(span.attributes)}`.trimEnd(),
    );
    for (const event of span.events) out.push(`${indent}  · ${event.name} +${ms(event.time)}ms`);
    for (const link of span.links) {
      out.push(
        `${indent}  ↔ ${link.traceId === traceId ? '同一 trace' : link.traceId} 的 span ${link.spanId}`,
      );
    }
    for (const child of children.get(span.spanId) ?? []) walk(child, depth + 1);
  };
  for (const root of children.get(undefined) ?? []) walk(root, 0);
  return out.join('\n');
}
