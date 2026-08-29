import { z } from "zod";
import { DecimalStringSchema } from "../common/decimal-string.js";
import { UuidSchema } from "../common/ids.js";
import { extensibleJsonObject } from "../common/json-value.js";
import { SignalSchema } from "./signal.js";

/**
 * Ingested Signal：Signal 通过 SignalSchema 与来源策略校验后的持久化投影
 * （phase-3-development-guide.md §6.1）。
 *
 * - sequence：入库事务内分配的 Session 内单调序号（1 起、无缺口），
 *   只用于顺序、Batch 区间与恢复；持久化为十进制字符串。
 * - signalId：来源去重键——重复事件返回幂等结果并回显原 sequence，
 *   不分配第二个水位。
 * - 优先级分类是确定性策略的结果：urgent 信号不等待普通封窗，
 *   进入保留容量或产生可观测的过载失败（不变量 10）。
 */
export const SignalPriorityClassSchema = z.enum(["normal", "urgent"]);

export const IngestedSignalSchema = extensibleJsonObject({
  schemaVersion: z.literal(1),
  signalId: UuidSchema,
  /** Session 内单调入库序号（十进制字符串，bigint 域比较）。 */
  sequence: DecimalStringSchema,
  priorityClass: SignalPriorityClassSchema,
  /** 入库墙钟（Unix epoch ms），仅审计与展示；窗口/Deadline 用单调时钟。 */
  receivedAtMs: z.number().int().nonnegative(),
  /** 原始 Signal 全文：重启后未消费信号据此重建 Batch。 */
  signal: SignalSchema,
});

export type SignalPriorityClass = z.infer<typeof SignalPriorityClassSchema>;
export type IngestedSignal = z.infer<typeof IngestedSignalSchema>;
