import { randomBytes } from "node:crypto";
import { TraceContextSchema } from "@bellis/contracts";
import type { TraceContext } from "@bellis/contracts";

/**
 * TraceContext 的创建与派生（docs/phase-1-reference.md）。
 *
 * - 业务上下文字段（sessionId/turnId/cycleId/sceneId/cueId/toolRunId）按需携带，
 *   通过显式参数传播，不以 Trace ID 替代业务 ID。
 * - 生成器默认使用加密安全随机源；测试注入确定性源（@bellis/testkit 的
 *   DeterministicIdSource 在结构上兼容 TraceRandomSource）。
 * - 最终对象一律经 Contracts 的 TraceContextSchema 校验，非法输入显式抛错，
 *   不做静默修正。
 */

/** Trace/Span ID 的随机源；注入方负责保证 ID 形态合法。 */
export interface TraceRandomSource {
  traceId(): string;
  spanId(): string;
}

/** 基于 node:crypto 的默认加密安全随机源。 */
export function createCryptoTraceRandomSource(): TraceRandomSource {
  return {
    traceId: () => randomHex(16),
    spanId: () => randomHex(8),
  };
}

function randomHex(bytes: number): string {
  for (;;) {
    const hex = randomBytes(bytes).toString("hex");
    // W3C 要求非全零；随机源产生全零的概率约为 2^-128，此处仅为严格性兜底。
    if (!/^[0]+$/.test(hex)) {
      return hex;
    }
  }
}

const cryptoTraceRandomSource = createCryptoTraceRandomSource();

/**
 * 创建新的 TraceContext。
 * - 未提供 traceId/spanId 时由随机源生成；
 * - 显式提供的字段（含扩展键）原样保留，整体经 TraceContextSchema 校验，
 *   非法输入抛 ZodError，而不是静默替换。
 */
export function createTraceContext(
  input?: Partial<TraceContext>,
  source?: TraceRandomSource,
): TraceContext {
  const effectiveSource = source ?? cryptoTraceRandomSource;
  const candidate: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input ?? {})) {
    if (value !== undefined) {
      candidate[key] = value;
    }
  }
  if (candidate.traceId === undefined) {
    candidate.traceId = effectiveSource.traceId();
  }
  if (candidate.spanId === undefined) {
    candidate.spanId = effectiveSource.spanId();
  }
  return TraceContextSchema.parse(candidate);
}

/**
 * 派生子上下文：保持 Trace ID 与业务字段，生成新的 Span ID。
 * 父对象中的旧 spanId 不向下传播（如需父 Span 链，由 Span 级实现负责，
 * TraceContext 不承载 parentSpanId）。
 */
export function childTraceContext(parent: TraceContext, source?: TraceRandomSource): TraceContext {
  const effectiveSource = source ?? cryptoTraceRandomSource;
  const child: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parent)) {
    if (key !== "spanId" && value !== undefined) {
      child[key] = value;
    }
  }
  child.spanId = effectiveSource.spanId();
  return TraceContextSchema.parse(child);
}
