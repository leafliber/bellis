import type { Random } from '@bellis/kernel';

/**
 * W3C Trace Context 的 `traceparent`（Level 1）：`版本-trace-id-parent-id-flags`，小写十六进制。
 * 本项目只生成版本 00；解析按规范接受更高的版本（只读前四段，其后须以 `-` 隔开），拒绝版本 ff、
 * 全零的 trace-id 与 parent-id、大写与其它不合格的写法。
 */
export interface TraceContext {
  /** 32 个十六进制字符。 */
  readonly traceId: string;
  /** 16 个十六进制字符。 */
  readonly spanId: string;
  /** flags 的最低位（sampled）。本项目记录全部 span，生成的总是 true。 */
  readonly sampled: boolean;
}

const HEAD = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})/;
const ZERO_TRACE = '0'.repeat(32);
const ZERO_SPAN = '0'.repeat(16);
const LENGTH_V00 = 55;

export function parseTraceparent(value: unknown): TraceContext | undefined {
  if (typeof value !== 'string' || value.length < LENGTH_V00) return undefined;
  const match = HEAD.exec(value);
  if (!match) return undefined;
  const [, version, traceId, spanId, flags] = match as unknown as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (version === 'ff') return undefined;
  if (version === '00' && value.length !== LENGTH_V00) return undefined;
  if (value.length > LENGTH_V00 && value[LENGTH_V00] !== '-') return undefined;
  if (traceId === ZERO_TRACE || spanId === ZERO_SPAN) return undefined;
  return { traceId, spanId, sampled: (Number.parseInt(flags, 16) & 1) === 1 };
}

export function formatTraceparent(context: TraceContext): string {
  return `00-${context.traceId}-${context.spanId}-${context.sampled ? '01' : '00'}`;
}

/** 由随机数服务生成若干个十六进制字符（每次取 16 位）；全零时重取。 */
function hex(random: Random, chars: number): string {
  for (;;) {
    let out = '';
    while (out.length < chars) out += random.int(0, 0xffff).toString(16).padStart(4, '0');
    if (!/^0+$/.test(out)) return out;
  }
}

export function newTraceId(random: Random): string {
  return hex(random, 32);
}

export function newSpanId(random: Random): string {
  return hex(random, 16);
}
