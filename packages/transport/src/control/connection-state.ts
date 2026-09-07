/**
 * Control 连接状态机（docs/reference/phase-1.md）：
 *
 * ```text
 * awaiting_client_hello → active → draining → closed
 * ```
 *
 * - 建连后先发送 server.hello，只接受一次合法 client.hello。
 * - 协议主版本不匹配返回 unsupported_version 并关闭。
 * - Hello 前的业务消息、重复 Hello、关闭后的消息稳定拒绝。
 * - draining 不接受新的状态变更，但允许必要 ACK/关闭流程完成。
 */
export const CONTROL_CONNECTION_STATES = [
  "awaiting_client_hello",
  "active",
  "draining",
  "closed",
] as const;

export type ControlConnectionState = (typeof CONTROL_CONNECTION_STATES)[number];
