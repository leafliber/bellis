import type { AudienceMessage, AudienceTopic, IngestedSignal } from "@bellis/contracts";

/**
 * 确定性文本归一化与聚类（phase-3-development-guide.md §6.2）。
 *
 * - Phase 3 不引入 embedding 或第二个模型：分组键 = 归一化文本
 *   （NFKC → 小写 → 去标点 → 折叠空白）的精确匹配；
 * - 同一用户刷屏只影响权重：所有消息保留为 highlight 审计事实
 *   （按序号升序，超限截断最旧），topic 参与人数按去重用户计；
 * - tokenEstimate 使用确定性启发式（CJK 主导文本 len/2）。
 */

/** 归一化分组键：确定性、无 locale 依赖。 */
export function normalizeText(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** 确定性 token 估计：文本长度的一半向上取整（CJK 主导场景近似）。 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2);
}

interface ClusterGroup {
  readonly key: string;
  readonly label: string;
  count: number;
  readonly users: Set<string>;
  readonly examples: string[];
}

export interface ClusterResult {
  readonly highlights: readonly AudienceMessage[];
  readonly topics: readonly AudienceTopic[];
  readonly tokenEstimate: number;
  /** 高亮超过上限被截断的消息数（确定性：保留最早）。 */
  readonly truncatedHighlights: number;
}

/**
 * 弹幕消息文本提取：payload.text 为非空字符串才参与聚类；
 * 其它形态（礼物、进场等）不进入 highlights（仍是可审计 Signal）。
 */
export function readSignalText(signal: IngestedSignal["signal"]): string | null {
  const payload = signal.payload;
  if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
    const text = (payload as Record<string, unknown>).text;
    if (typeof text === "string" && text.length > 0) {
      return text;
    }
  }
  return null;
}

export function clusterSignals(
  signals: readonly IngestedSignal[],
  limits: {
    readonly maxHighlights: number;
    readonly maxTopics: number;
    readonly maxExamples: number;
  },
): ClusterResult {
  const groups = new Map<string, ClusterGroup>();
  const messages: { signal: IngestedSignal; text: string }[] = [];
  for (const ingested of signals) {
    const text = readSignalText(ingested.signal);
    if (text === null) {
      continue;
    }
    messages.push({ signal: ingested, text });
    const key = normalizeText(text);
    if (key.length === 0) {
      continue;
    }
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        key,
        label: text.length > 128 ? `${text.slice(0, 127)}…` : text,
        count: 1,
        users: new Set([userIdOf(ingested)]),
        examples: [text],
      });
    } else {
      existing.count += 1;
      existing.users.add(userIdOf(ingested));
      if (existing.examples.length < limits.maxExamples) {
        existing.examples.push(text);
      }
    }
  }
  const total = messages.length;
  const highlights: AudienceMessage[] = [];
  for (const message of messages) {
    if (highlights.length >= limits.maxHighlights) {
      break;
    }
    const group = groups.get(normalizeText(message.text));
    const weight = group !== undefined && total > 0 ? group.count / total : 0;
    highlights.push({
      schemaVersion: 1,
      signalId: message.signal.signalId,
      userId: userIdOf(message.signal),
      text: message.text,
      weight,
    });
  }
  const topics: AudienceTopic[] = [...groups.values()]
    .map((group) => ({
      schemaVersion: 1,
      label: group.label,
      count: group.count,
      participants: group.users.size,
      examples: group.examples,
    }))
    .sort((a, b) => b.count - a.count || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))
    .slice(0, limits.maxTopics);
  const tokenEstimate =
    highlights.reduce((sum, message) => sum + estimateTokens(message.text), 0) +
    topics.reduce((sum, topic) => sum + estimateTokens(topic.label), 0);
  return {
    highlights,
    topics,
    tokenEstimate,
    truncatedHighlights: Math.max(0, messages.length - highlights.length),
  };
}

function userIdOf(ingested: IngestedSignal): string {
  const payload = ingested.signal.payload;
  if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
    const userId = (payload as Record<string, unknown>).userId;
    if (typeof userId === "string" && userId.length > 0) {
      return userId.slice(0, 128);
    }
  }
  return "anonymous";
}
