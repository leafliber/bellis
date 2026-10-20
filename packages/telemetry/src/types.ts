import { defineService, type PluginContext } from '@bellis/kernel';
import type { Attributes } from './attributes.ts';

/**
 * 遥测服务 `telemetry@1`（R-21）：span 与直方图，写成 OTLP/JSON 的 JSONL。其它插件以可选依赖使用
 * （inject 写 `telemetry@1?`，代码里用 {@link useTracer}），没有它时一切照常。
 * 事件日志是事实来源；遥测是可以丢失的派生数据，写不进就丢，不阻塞直播。
 */

/** OTLP 的 span 种类。 */
export type SpanKind = 'internal' | 'server' | 'client' | 'producer' | 'consumer';

/**
 * 随数据交给下游的链路上下文（`Danmaku`、分诊候选、发声请求上的可选字段）：只是数据，可以复制与序列化。
 * 没有遥测时不出现。
 */
export interface TraceRef {
  /** 上游 span 的 W3C traceparent，下游以它为父。 */
  readonly traceparent: string;
  /** 链路起点（宿主收到这条弹幕）在时钟上的时刻（毫秒），“弹幕到首音”从这里算起。 */
  readonly originAt?: number;
  /** 另外关联的上游 span（OTLP links），例如产生这段发言的模型调用。 */
  readonly links?: readonly string[];
}

/** 父上下文或关联对象：本进程的 span、W3C traceparent，或随数据传下来的 {@link TraceRef}。 */
export type SpanParent = Span | TraceRef | string;

export interface SpanOptions {
  /** 不给（或给了不合格的 traceparent）时开一条新的 trace，这个 span 是根。 */
  parent?: SpanParent | undefined;
  kind?: SpanKind;
  attributes?: Attributes;
  /** OTLP links：例如分诊合并的其余弹幕。 */
  links?: ReadonlyArray<SpanParent | undefined>;
}

export interface Span {
  /** 这个 span 的 W3C traceparent，交给下游作父；空实现为 undefined。 */
  readonly traceparent: string | undefined;
  setAttributes(attributes: Attributes): void;
  addEvent(name: string, attributes?: Attributes): void;
  addLink(link: SpanParent | undefined): void;
  /** 标为出错（OTLP status ERROR），`errorType` 写进 `error.type`：短的类别名，不含内容。 */
  fail(errorType: string): void;
  /** 结束并排队写出；重复调用无效。没有结束的 span 不写出。 */
  end(): void;
}

export interface Tracer {
  startSpan(name: string, options?: SpanOptions): Span;
  /**
   * 记录直方图的一个样本（单位按 UCUM：时长用 `s`）。给出 `context` 时样本作为 exemplar 关联到那个 span。
   */
  record(
    name: string,
    value: number,
    unit: string,
    attributes?: Attributes,
    context?: SpanParent,
  ): void;
}

export interface Telemetry {
  /** 一个插件的记录器：它的 span 与直方图写在以 `scope`（插件 id）命名的 instrumentation scope 下。 */
  tracer(scope: string): Tracer;
  /**
   * 拉起 sidecar 时加进它环境的变量（`BELLIS_TELEMETRY`）：sidecar 据此把自己的 span 写进同一目录。
   * 不写文件（例如仿真里写内存）时为空。
   */
  sidecarEnv(): Readonly<Record<string, string>>;
}

export const TelemetryService = defineService<Telemetry>('telemetry', 1);

/** 仿真与测试用：`telemetry-memory` 插件写出的 JSONL 行。 */
export interface TelemetryMemory {
  readonly lines: readonly string[];
}

export const TelemetryMemoryService = defineService<TelemetryMemory>('telemetry.memory', 1);

/** 空实现：不分配、不计时。 */
export const NOOP_SPAN: Span = Object.freeze({
  traceparent: undefined,
  setAttributes() {},
  addEvent() {},
  addLink() {},
  fail() {},
  end() {},
});

export const NOOP_TRACER: Tracer = Object.freeze({
  startSpan: () => NOOP_SPAN,
  record() {},
});

/** 取父上下文的 traceparent。 */
export function traceparentOf(parent: SpanParent | undefined): string | undefined {
  if (parent === undefined) return undefined;
  return typeof parent === 'string' ? parent : parent.traceparent;
}

/** 由 span 得到交给下游的链路上下文；空实现的 span 返回 undefined（下游据此不带这个字段）。 */
export function traceRef(
  span: Span,
  originAt?: number,
  links?: readonly (string | undefined)[],
): TraceRef | undefined {
  if (span.traceparent === undefined) return undefined;
  const linked = links?.filter((link): link is string => link !== undefined) ?? [];
  return {
    traceparent: span.traceparent,
    ...(originAt === undefined ? {} : { originAt }),
    ...(linked.length > 0 ? { links: linked } : {}),
  };
}

/**
 * 以可选依赖使用遥测：每次调用时现查 `telemetry@1`，遥测插件晚于使用方激活、热替换或停用都不影响使用方；
 * 不在时返回空实现。插件须在 inject 中声明 `telemetry@1?`；`scope` 用插件 id。
 * 已经开始的 span 在遥测插件停用后结束时直接丢弃。
 */
export function useTracer(ctx: Pick<PluginContext, 'optional'>, scope: string): Tracer {
  const current = (): Tracer | undefined => {
    try {
      return ctx.optional(TelemetryService)?.tracer(scope);
    } catch {
      // 使用方已卸载：不再记录。
      return undefined;
    }
  };
  return {
    startSpan: (name, options) => current()?.startSpan(name, options) ?? NOOP_SPAN,
    record: (name, value, unit, attributes, context) =>
      current()?.record(name, value, unit, attributes, context),
  };
}
