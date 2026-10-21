import { defineService } from '@bellis/kernel';

/** 召回给决策模型的一条记忆：编号只在这次召回里有效（`m1`、`m2`…），正文已过隐私网关与墓碑过滤。 */
export interface RecalledMemory {
  id: string;
  text: string;
  /** Iris 的记忆类别（事件、事实、偏好……）与立场（亲历、转述、推断……）；Iris 没给时为 null。 */
  kind: string | null;
  stance: string | null;
}

export interface MemoryRecall {
  /** Iris 的召回标识：使用反馈用。 */
  recallId: string;
  memories: RecalledMemory[];
}

export interface RecallRequest {
  /** 查询提示（候选弹幕的净化文本等）；省略时由 Iris 用本入口的近期消息自己构造。 */
  text?: string;
  /** 调用方的 span（W3C traceparent），召回的 span 以它为父；没有遥测时不给。 */
  traceparent?: string;
}

/**
 * 召回的结果。没有成功时决策照常进行，只是不带记忆：`timeout` 是调用方的截止时间到了（中止原因为
 * `DeadlineError`），`aborted` 是调用方取消，`unavailable` 是记忆插件停用中，`error` 是 Iris 出错
 * （说明只含类别、HTTP 状态与错误码）。
 */
export type RecallResult =
  | { ok: true; recall: MemoryRecall }
  | { ok: false; kind: 'timeout' | 'aborted' | 'unavailable' | 'error'; detail: string };

/** 给操作员看的记忆状态。 */
export interface MemoryReport {
  /** Iris 就绪（最近的请求没有处在连续失败中、也没有鉴权失败），且记忆插件在运行。 */
  ready: boolean;
  /** Iris 的状态说明，后面加上写入此刻为什么暂停（安全停止、等待重试）。 */
  status: string;
  /** 待发队列的条数。 */
  pending: number;
  /** 累计写入与丢弃的条数（本状态存储里）。 */
  written: number;
  dropped: number;
  /** 登记了墓碑的观众数。 */
  tombstones: number;
}

export interface Memory {
  /** 召回直播间入口内的公开事实；`signal` 由调用方给截止时间，中止即断开请求。 */
  recall(request: RecallRequest, signal: AbortSignal): Promise<RecallResult>;
  /**
   * 使用反馈：这次召回里实际用到的记忆编号，没有用到就是空数组。只回报这次召回给出的编号，
   * 其余忽略；同一次召回只回报一次。不等结果，失败只记日志。
   */
  feedback(recallId: string, used: readonly string[]): void;
  /** 开播预检：以宿主令牌访问 Iris（`GET /status`）；不通时以说明原因的错误结束。 */
  check(): Promise<void>;
  readonly report: MemoryReport;
}

export const MemoryService = defineService<Memory>('memory', 1);
