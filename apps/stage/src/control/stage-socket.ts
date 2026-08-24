/**
 * Stage 侧 Socket Port（apps/stage 内部边界）。
 *
 * 核心逻辑（Control/Media 客户端、Scene 状态机、Timeline）只依赖本接口，
 * 不直接引用浏览器 WebSocket——生产装配注入 WebSocket 适配器
 * （src/control/browser-socket.ts），Node 测试注入 FakeSocket。
 * 一切 Listener、定时器与 socket 都有明确 close 路径（§7）。
 */
export interface StageSocket {
  /** 发送一条 UTF-8 文本（Control）或二进制（Media）消息。 */
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  set onopen(handler: (() => void) | null);
  set onmessage(handler: ((data: string | Uint8Array) => void) | null);
  set onclose(handler: ((code: number, reason: string) => void) | null);
  set onerror(handler: (() => void) | null);
}

export type SocketFactory = () => StageSocket;
