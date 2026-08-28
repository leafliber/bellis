/* StageSocket Port 以 on* setter 为接口（自研 Port，非 DOM 事件）。 */
/* oxlint-disable unicorn/prefer-add-event-listener */
import type { StageSocket } from "../src/control/stage-socket.js";

/**
 * 成对 FakeSocket：一端交给被测客户端，另一端由测试扮演 Runtime。
 * send 直接投递到对端 handler；close 触发双端 onclose。
 */
export class FakeSocketPair {
  readonly clientSocket: StageSocket;
  readonly serverSocket: StageSocket;

  constructor() {
    let clientOnOpen: (() => void) | null = null;
    let clientOnMessage: ((data: string | Uint8Array) => void) | null = null;
    let clientOnClose: ((code: number, reason: string) => void) | null = null;
    let serverOnMessage: ((data: string | Uint8Array) => void) | null = null;
    let serverOnClose: ((code: number, reason: string) => void) | null = null;
    let closed = false;

    const deliverClose = (): void => {
      if (closed) {
        return;
      }
      closed = true;
      clientOnClose?.(1000, "fake_close");
      serverOnClose?.(1000, "fake_close");
    };

    this.clientSocket = {
      send: (data: string | Uint8Array) => {
        if (!closed) {
          serverOnMessage?.(data);
        }
      },
      close: deliverClose,
      set onopen(handler: (() => void) | null) {
        clientOnOpen = handler;
      },
      set onmessage(handler: ((data: string | Uint8Array) => void) | null) {
        clientOnMessage = handler;
      },
      set onclose(handler: ((code: number, reason: string) => void) | null) {
        clientOnClose = handler;
      },
      set onerror(handler: (() => void) | null) {
        void handler;
      },
    };
    this.serverSocket = {
      // 服务端 onopen 由测试驱动（通常无需）；onerror 无意义。
      set onopen(handler: (() => void) | null) {
        void handler;
      },
      send: (data: string | Uint8Array) => {
        if (!closed) {
          clientOnMessage?.(data);
        }
      },
      close: deliverClose,
      set onmessage(handler: ((data: string | Uint8Array) => void) | null) {
        serverOnMessage = handler;
      },
      set onclose(handler: ((code: number, reason: string) => void) | null) {
        serverOnClose = handler;
      },
      set onerror(handler: (() => void) | null) {
        void handler;
      },
    };

    this.open = () => {
      clientOnOpen?.();
    };
    this.serverSend = (text: string) => {
      if (!closed) {
        clientOnMessage?.(text);
      }
    };
  }

  /** 测试驱动：模拟连接建立（客户端 socket onopen）。 */
  readonly open: () => void;
  /** 测试驱动：服务端发送文本到客户端。 */
  readonly serverSend: (text: string) => void;
}
