/**
 * 弹幕接入、决策模型与记忆的状态：开播预检与操作员状态（命令行与操作台）共用同一份。判定不发请求，只读接入插件、
 * 模型客户端与记忆插件报告的就绪状态（见观众接入“就绪”、决策模型“就绪”、运维“开播预检”）。
 */
import type { DanmakuSource } from '@bellis/audience';
import { choosePersona, type Llm, LlmError } from '@bellis/director';
import { IrisError, irisFailureText, type Memory, type MemoryLedger } from '@bellis/memory';

/** 弹幕接入（`danmaku@1`）的状态。 */
export interface DanmakuReport {
  ready: boolean;
  /** 状态说明：在做什么、在等什么及原因；不在场时为“不在场”。 */
  status: string;
  /** 此刻的缺口：原因、开始时刻（墙钟，ISO 8601）与已持续多久；来源不记开始时刻时后两者为 null。 */
  gap: { reason: string; startedAt: string | null; durationMs: number | null } | null;
}

/** 决策模型（`llm@1`）的状态。 */
export interface LlmReport {
  ready: boolean;
  /** 状态说明：只含失败的类别、HTTP 状态与错误码，不含服务端的说明。 */
  status: string;
  /** 连续失败的次数（成功清零，取消不计）。 */
  consecutiveFailures: number;
  /** 最近一次失败的类别与时刻（ISO 8601）；还没失败过、或客户端不跟踪时为 null。 */
  lastFailure: { kind: string; at: string } | null;
}

/** `now` 为墙钟（毫秒），算缺口持续了多久。 */
export function danmakuReport(source: DanmakuSource | undefined, now: number): DanmakuReport {
  if (!source) return { ready: false, status: '不在场', gap: null };
  const gap = source.gap?.();
  const startedAt = gap?.startedAt;
  return {
    ready: source.ready === true,
    status: source.status ?? (source.ready === undefined ? '没有就绪报告' : '未说明'),
    gap: gap
      ? {
          reason: gap.reason,
          startedAt: startedAt === undefined ? null : new Date(startedAt).toISOString(),
          durationMs: startedAt === undefined ? null : Math.max(0, now - startedAt),
        }
      : null,
  };
}

export function llmReport(llm: Llm | undefined): LlmReport {
  if (!llm) {
    return { ready: false, status: 'llm@1 不在场', consecutiveFailures: 0, lastFailure: null };
  }
  const failures = llm.failures;
  const last = failures?.last;
  return {
    ready: llm.ready === true,
    status: llm.status ?? (llm.ready === undefined ? '没有就绪报告' : '未说明'),
    consecutiveFailures: failures?.consecutive ?? 0,
    lastFailure: last ? { kind: last.kind, at: new Date(last.at).toISOString() } : null,
  };
}

/** 时长的读法：`45 秒`、`3 分 05 秒`、`2 小时 03 分`。 */
export function spoken(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${String(seconds % 60).padStart(2, '0')} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${String(minutes % 60).padStart(2, '0')} 分`;
}

/** 弹幕接入未就绪时开播预检的说明：状态说明，在缺口中时加上缺口已持续多久。 */
export function danmakuFailure(report: DanmakuReport): string | undefined {
  if (report.ready) return undefined;
  const lasted = report.gap?.durationMs;
  return `弹幕接入未就绪：${report.status}${typeof lasted === 'number' ? `；缺口已持续 ${spoken(lasted)}` : ''}`;
}

/**
 * 探测失败的说明：类别、HTTP 状态与错误码，不含服务端的说明（`LlmError` 的说明里可能有截短的服务端摘录）。
 */
export function probeFailure(error: unknown): string {
  if (!(error instanceof LlmError)) return '决策模型的探测请求失败';
  const parts = [
    error.kind,
    error.status === undefined ? undefined : `HTTP ${error.status}`,
    error.code,
  ].filter((part) => part !== undefined);
  return `决策模型的探测请求失败（${parts.join('，')}）`;
}

/** 记忆（`memory@1` 与 Iris）的状态。 */
export interface MemoryStatusReport {
  /** Iris 就绪（最近的请求没有处在连续失败中、也没有鉴权失败），且记忆插件在运行。 */
  ready: boolean;
  /** 状态说明：只含失败的类别、HTTP 状态与错误码；写入在等重试时说明约多久后重试。不在场时为“memory@1 不在场”。 */
  status: string;
  /** 待发队列、累计写入与丢弃的条数、登记了墓碑的观众数：来自状态存储的记忆账本，记忆插件不在场时照样有。 */
  pending: number;
  written: number;
  dropped: number;
  tombstones: number;
}

export function memoryReport(memory: Memory | undefined, ledger: MemoryLedger): MemoryStatusReport {
  const counts = {
    pending: ledger.outbox.length,
    written: ledger.written,
    dropped: ledger.dropped,
    tombstones: ledger.tombstones.length,
  };
  if (!memory) return { ready: false, status: 'memory@1 不在场', ...counts };
  const report = memory.report;
  return { ready: report.ready === true, status: report.status, ...counts };
}

/** 决策插件此刻用的人设的来源与版本（见决策模型“人设”）；不含正文。 */
export interface PersonaReport {
  source: 'iris' | 'profile';
  /** Iris 人设的版本号；profile 的人设、或 Iris 没给版本时为 null。 */
  version: number | null;
}

export function personaReport(memory: Memory | undefined): PersonaReport {
  const { source, version } = choosePersona(memory, '');
  return { source, version };
}

/** 开播预检中 Iris 一项的说明：取当前人设失败（请求出错）时，只含类别、HTTP 状态与错误码。 */
export function personaFailure(error: unknown): string {
  if (error instanceof IrisError) return `Iris 没有当前人设（${irisFailureText(error)}）`;
  return `Iris 没有当前人设（${error instanceof Error ? error.message : String(error)}）`;
}

/** 开播预检中 Iris 一项的说明：以宿主令牌访问 Iris（`GET /status`）失败时，只含类别、HTTP 状态与错误码。 */
export function memoryCheckFailure(error: unknown): string {
  if (error instanceof IrisError) return `Iris 不能以宿主令牌访问（${irisFailureText(error)}）`;
  return `Iris 不能以宿主令牌访问：${error instanceof Error ? error.message : String(error)}`;
}
