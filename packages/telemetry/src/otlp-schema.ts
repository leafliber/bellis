import Type, { type Static } from 'typebox';
import { Compile } from 'typebox/compile';

/**
 * 本项目写出的 OTLP/JSON 子集（宿主与 Python sidecar 相同）：每行一个 `ExportTraceServiceRequest`
 * 或 `ExportMetricsServiceRequest`。trace ID 与 span ID 是小写十六进制（OTLP/JSON 的约定），64 位整数与
 * 纳秒时刻按 protobuf 的 JSON 映射写成十进制字符串，枚举写整数值。对象都是封闭的：多写了字段也算不合格。
 * 测试与确定性仿真用它核对输出；Collector 能读的比这宽。
 */

const closed = { additionalProperties: false } as const;
const Hex32 = Type.String({ pattern: '^[0-9a-f]{32}$' });
const Hex16 = Type.String({ pattern: '^[0-9a-f]{16}$' });
const UInt64 = Type.String({ pattern: '^(0|[1-9][0-9]{0,19})$' });
const Count = Type.Integer({ minimum: 1 });

const AnyValue = Type.Union([
  Type.Object({ stringValue: Type.String() }, closed),
  Type.Object({ intValue: Type.String({ pattern: '^-?(0|[1-9][0-9]{0,18})$' }) }, closed),
  Type.Object({ doubleValue: Type.Number() }, closed),
  Type.Object({ boolValue: Type.Boolean() }, closed),
]);
const KeyValue = Type.Object({ key: Type.String({ minLength: 1 }), value: AnyValue }, closed);
const Attributes = Type.Array(KeyValue, { minItems: 1 });
const Resource = Type.Object({ attributes: Type.Optional(Attributes) }, closed);
const Scope = Type.Object({ name: Type.String({ minLength: 1 }) }, closed);

const OtlpEventSchema = Type.Object(
  {
    timeUnixNano: UInt64,
    name: Type.String({ minLength: 1 }),
    attributes: Type.Optional(Attributes),
    droppedAttributesCount: Type.Optional(Count),
  },
  closed,
);

export const OtlpSpanSchema = Type.Object(
  {
    traceId: Hex32,
    spanId: Hex16,
    parentSpanId: Type.Optional(Hex16),
    name: Type.String({ minLength: 1 }),
    /** 1 INTERNAL、2 SERVER、3 CLIENT、4 PRODUCER、5 CONSUMER。 */
    kind: Type.Integer({ minimum: 1, maximum: 5 }),
    startTimeUnixNano: UInt64,
    endTimeUnixNano: UInt64,
    attributes: Type.Optional(Attributes),
    droppedAttributesCount: Type.Optional(Count),
    events: Type.Optional(Type.Array(OtlpEventSchema, { minItems: 1 })),
    droppedEventsCount: Type.Optional(Count),
    links: Type.Optional(
      Type.Array(Type.Object({ traceId: Hex32, spanId: Hex16 }, closed), { minItems: 1 }),
    ),
    droppedLinksCount: Type.Optional(Count),
    /** 0 UNSET、2 ERROR；不写 message。 */
    status: Type.Object({ code: Type.Union([Type.Literal(0), Type.Literal(2)]) }, closed),
  },
  closed,
);

export const OtlpTracesSchema = Type.Object(
  {
    resourceSpans: Type.Array(
      Type.Object(
        {
          resource: Resource,
          scopeSpans: Type.Array(
            Type.Object(
              { scope: Scope, spans: Type.Array(OtlpSpanSchema, { minItems: 1 }) },
              closed,
            ),
            { minItems: 1 },
          ),
        },
        closed,
      ),
      { minItems: 1, maxItems: 1 },
    ),
  },
  closed,
);
export type OtlpTraces = Static<typeof OtlpTracesSchema>;

const Exemplar = Type.Object(
  {
    timeUnixNano: UInt64,
    asDouble: Type.Number(),
    traceId: Type.Optional(Hex32),
    spanId: Type.Optional(Hex16),
  },
  closed,
);

const HistogramPoint = Type.Object(
  {
    attributes: Type.Optional(Attributes),
    startTimeUnixNano: UInt64,
    timeUnixNano: UInt64,
    count: UInt64,
    sum: Type.Number(),
    min: Type.Number(),
    max: Type.Number(),
    bucketCounts: Type.Array(UInt64, { minItems: 1 }),
    explicitBounds: Type.Array(Type.Number()),
    exemplars: Type.Array(Exemplar, { minItems: 1 }),
  },
  closed,
);

export const OtlpMetricsSchema = Type.Object(
  {
    resourceMetrics: Type.Array(
      Type.Object(
        {
          resource: Resource,
          scopeMetrics: Type.Array(
            Type.Object(
              {
                scope: Scope,
                metrics: Type.Array(
                  Type.Object(
                    {
                      name: Type.String({ minLength: 1 }),
                      unit: Type.String(),
                      histogram: Type.Object(
                        {
                          /** 1 DELTA。 */
                          aggregationTemporality: Type.Literal(1),
                          dataPoints: Type.Array(HistogramPoint, { minItems: 1 }),
                        },
                        closed,
                      ),
                    },
                    closed,
                  ),
                  { minItems: 1 },
                ),
              },
              closed,
            ),
            { minItems: 1 },
          ),
        },
        closed,
      ),
      { minItems: 1, maxItems: 1 },
    ),
  },
  closed,
);
export type OtlpMetrics = Static<typeof OtlpMetricsSchema>;

const isTraces = Compile(OtlpTracesSchema);
const isMetrics = Compile(OtlpMetricsSchema);

/** 一行是否是本项目写出的 OTLP/JSON：返回不合格之处（空数组表示合格），另核对时刻与桶计数的一致性。 */
export function otlpLineProblems(line: string): string[] {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return ['不是 JSON'];
  }
  if (isTraces.Check(value)) {
    const problems: string[] = [];
    for (const resource of value.resourceSpans) {
      for (const scoped of resource.scopeSpans) {
        for (const span of scoped.spans) {
          if (BigInt(span.endTimeUnixNano) < BigInt(span.startTimeUnixNano))
            problems.push(`span ${span.spanId} 的结束早于开始`);
        }
      }
    }
    return problems;
  }
  if (isMetrics.Check(value)) {
    const problems: string[] = [];
    for (const resource of value.resourceMetrics) {
      for (const scoped of resource.scopeMetrics) {
        for (const metric of scoped.metrics) {
          for (const point of metric.histogram.dataPoints) {
            const count = BigInt(point.count);
            const buckets = point.bucketCounts.reduce((sum, n) => sum + BigInt(n), 0n);
            if (point.bucketCounts.length !== point.explicitBounds.length + 1)
              problems.push(`${metric.name} 的桶数与边界数不符`);
            if (buckets !== count) problems.push(`${metric.name} 的桶计数之和不等于 count`);
            if (BigInt(point.exemplars.length) !== count)
              problems.push(`${metric.name} 的 exemplar 数不等于 count`);
            if (BigInt(point.timeUnixNano) < BigInt(point.startTimeUnixNano))
              problems.push(`${metric.name} 的区间结束早于开始`);
          }
        }
      }
    }
    return problems;
  }
  const spans = typeof value === 'object' && value !== null && 'resourceSpans' in value;
  const check = spans ? isTraces : isMetrics;
  const first = [...check.Errors(value)][0];
  return [
    `不是 OTLP/JSON 导出请求：${first ? `${first.instancePath || '/'} ${first.message}` : ''}`,
  ];
}
