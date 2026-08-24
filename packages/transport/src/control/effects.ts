import type { ServerControlEnvelope } from "@bellis/contracts";

/**
 * 框架无关的 Control Effect：核心不持有 Socket/Timer，网络写入由 P4
 * 适配器消费 Effect 完成（docs/phase-1-reference.md）。
 */

/** WebSocket 关闭码（IANA 私用区 4000–4999 留给 Bellis）。 */
export const CONTROL_CLOSE_CODES = {
  /** 正常关闭（优雅排空后）。 */
  normal: 1000,
  /** 心跳超时：超过配置的超时没有任何入站消息。 */
  heartbeat_timeout: 4001,
  /** 发送队列背压：高优先级消息无法入队，判定为慢消费者。 */
  send_queue_overflow: 4002,
  /** 协议错误：版本不匹配、ACK 超前等不可恢复的协议违例。 */
  protocol_error: 4003,
  /** Hello 超时：建连后未在期限内收到合法 client.hello。 */
  hello_timeout: 4004,
  /** 服务端主动关闭（Runtime 关闭序列）。 */
  server_shutdown: 4005,
} as const;

export type ControlCloseCode = (typeof CONTROL_CLOSE_CODES)[keyof typeof CONTROL_CLOSE_CODES];

export type ControlEffect =
  | {
      readonly kind: "send";
      /** 编码后的 JSON 文本；适配器原样写入 WebSocket。 */
      readonly text: string;
      readonly byteSize: number;
      readonly envelope: ServerControlEnvelope;
    }
  | {
      readonly kind: "close";
      readonly code: ControlCloseCode;
      readonly reason: string;
    }
  | {
      /** 重连 Replay Gap：P4 读取 Persistence 后发送 session.snapshot。 */
      readonly kind: "snapshot_required";
      readonly lastAck: bigint;
    }
  | {
      /**
       * 新 Seq 已分配（消息实际发送时）。P4 必须为**所有**推进持久化最新
       * 分配水位（含 persistable=false 的瞬时消息），否则进程重启后会复用
       * Seq；persistable=false 仅表示不持久化该消息的 Replay 内容。
       */
      readonly kind: "seq_advanced";
      readonly seq: bigint;
      readonly messageId: string;
      readonly persistable: boolean;
    }
  | {
      /** 背压淘汰/合并/过期丢弃的类别计数；不包含 Payload。 */
      readonly kind: "dropped";
      readonly category: string;
      readonly count: number;
      readonly reason: "capacity" | "merged" | "expired";
    };
