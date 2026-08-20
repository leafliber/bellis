/**
 * @bellis/transport — Gate 1 空壳。
 *
 * P1 将在此实现（phase-1-build-guide.md §13.2）：
 * - SystemMonotonicClock 与时钟同步算法。
 * - Control Envelope 编解码、连接状态、序号、ACK、Replay Window、心跳与背压。
 * - Media Frame 编解码、增量 Parser、Stream Registry 和大小限制。
 *
 * 空壳阶段只保证包可编译、依赖方向正确（contracts + observability，
 * 禁止访问数据库），不包含任何半成品业务框架。
 */
export type { MonotonicClock } from "@bellis/contracts";
