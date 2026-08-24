import type { OutboxMessage } from "@bellis/contracts";
import type { OutboxPublishResult, OutboxPublisher } from "@bellis/persistence";
import type { LoggerPort } from "@bellis/observability";

/**
 * Phase 1 测试发布者（docs/phase-1-reference.md）：按 Topic 白名单分发，只记录已脱敏、
 * 可审计的内存结果，不访问公网、不产生外部副作用。
 *
 * - 白名单外 Topic 返回不可重试失败 → Dispatcher 进入 Dead 策略。
 * - 交付记录只含 outboxId/topic/partitionKey/时间/traceId，不含完整 Payload。
 * - 记录有界（默认 1024 条，FIFO 淘汰），重复交付按 at-least-once 语义
 *   原样保留（消费端以 outboxId 去重）。
 */

const ALLOWED_TOPICS: ReadonlySet<string> = new Set(["scene.committed"]);
const DEFAULT_MAX_RECORDS = 1024;

export interface OutboxDeliveryRecord {
  readonly outboxId: string;
  readonly topic: string;
  readonly partitionKey: string;
  readonly deliveredAtMs: number;
  readonly traceId: string | null;
}

export interface RecordingOutboxPublisher {
  readonly publish: OutboxPublisher;
  /** 已交付记录（含允许的重复交付），FIFO。 */
  records(): readonly OutboxDeliveryRecord[];
  readonly topicAllowlist: readonly string[];
}

export function createRecordingOutboxPublisher(options?: {
  logger?: LoggerPort;
  maxRecords?: number;
}): RecordingOutboxPublisher {
  const logger = options?.logger;
  const maxRecords = options?.maxRecords ?? DEFAULT_MAX_RECORDS;
  const records: OutboxDeliveryRecord[] = [];

  const publish: OutboxPublisher = async (message: OutboxMessage): Promise<OutboxPublishResult> => {
    if (!ALLOWED_TOPICS.has(message.topic)) {
      logger?.log("warn", "runtime_outbox_unknown_topic", {
        outboxId: message.outboxId,
        topic: message.topic,
      });
      return { ok: false, errorCode: "unknown_topic", retryable: false };
    }
    records.push({
      outboxId: message.outboxId,
      topic: message.topic,
      partitionKey: message.partitionKey,
      deliveredAtMs: Date.now(),
      traceId: readTraceId(message),
    });
    if (records.length > maxRecords) {
      records.splice(0, records.length - maxRecords);
    }
    logger?.log("info", "runtime_outbox_delivered", {
      outboxId: message.outboxId,
      topic: message.topic,
    });
    return { ok: true };
  };

  return { publish, records: () => [...records], topicAllowlist: [...ALLOWED_TOPICS] };
}

/** 从 Payload 提取 traceId（仅识别字符串字段；不解析其余内容）。 */
function readTraceId(message: OutboxMessage): string | null {
  const payload = message.payload;
  if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
    const traceId = (payload as Record<string, unknown>).traceId;
    if (typeof traceId === "string" && /^[0-9a-f]{32}$/.test(traceId)) {
      return traceId;
    }
  }
  return null;
}
