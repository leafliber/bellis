import type { StageSocket } from "./stage-socket.js";

/**
 * 浏览器 WebSocket 适配器：实现 StageSocket Port。
 * onmessage 收到的是 MessageEvent，这里解包为文本/二进制数据；
 * onclose/onerror 转发关闭码与原因。Socket 本身由 GC 与浏览器管理，
 * 所有 handler 在 close 时置空，避免残留监听。
 */
/* StageSocket Port 以 on* setter 为接口（自研 Port，非 DOM 事件）。 */
/* oxlint-disable unicorn/prefer-add-event-listener */
export function createBrowserSocket(url: string): StageSocket {
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  const adapter: StageSocket = {
    send(data) {
      // WebSocket.send 接受 string 与 ArrayBufferView；Uint8Array 泛型
      // 在 DOM lib 下要求 ArrayBuffer 支撑，运行时语义一致。
      socket.send(data as string | ArrayBufferView<ArrayBuffer>);
    },
    close(code, reason) {
      adapter.onopen = null;
      adapter.onmessage = null;
      adapter.onclose = null;
      adapter.onerror = null;
      socket.close(code ?? 1000, reason ?? "");
    },
    set onopen(handler: (() => void) | null) {
      socket.onopen = handler === null ? null : () => handler();
    },
    set onmessage(handler: ((data: string | Uint8Array) => void) | null) {
      socket.onmessage =
        handler === null
          ? null
          : (event: MessageEvent) => handler(event.data as string | Uint8Array);
    },
    set onclose(handler: ((code: number, reason: string) => void) | null) {
      socket.onclose =
        handler === null ? null : (event: CloseEvent) => handler(event.code, event.reason);
    },
    set onerror(handler: (() => void) | null) {
      socket.onerror = handler === null ? null : () => handler();
    },
  };
  return adapter;
}
