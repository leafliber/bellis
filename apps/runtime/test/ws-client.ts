import { randomUUID } from "node:crypto";
import { formatDecimalString } from "@bellis/contracts";
import type { ClientControlEnvelope, ServerControlEnvelope } from "@bellis/contracts";
import { decodeControlMessage, encodeMediaFrame } from "@bellis/transport";
import WebSocket from "ws";

/** Control/Media WebSocket 测试客户端（ws + Cookie/Origin 头）。 */

export interface WsClientOptions {
  readonly port: number;
  readonly path: string;
  readonly cookie: string;
  readonly origin: string;
}

export class ControlWsClient {
  readonly socket: WebSocket;
  readonly #received: ServerControlEnvelope[] = [];
  readonly #waiters: Array<{
    predicate: (envelope: ServerControlEnvelope) => boolean;
    resolve: (envelope: ServerControlEnvelope) => void;
  }> = [];

  constructor(options: WsClientOptions) {
    this.socket = new WebSocket(`ws://127.0.0.1:${options.port}${options.path}`, {
      headers: { cookie: options.cookie, origin: options.origin },
    });
    this.socket.on("message", (data: unknown, isBinary: boolean) => {
      if (isBinary) {
        return;
      }
      const text =
        typeof data === "string" ? data : Buffer.from(data as ArrayBufferLike).toString("utf8");
      const decoded = decodeControlMessage(text);
      if (!decoded.ok || decoded.value.direction !== "server") {
        return;
      }
      this.#received.push(decoded.value);
      for (let index = this.#waiters.length - 1; index >= 0; index -= 1) {
        const waiter = this.#waiters[index];
        if (waiter === undefined) {
          continue;
        }
        if (waiter.predicate(decoded.value)) {
          this.#waiters.splice(index, 1);
          waiter.resolve(decoded.value);
        }
      }
    });
  }

  opened(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.once("open", () => resolve());
      this.socket.once("error", (error: Error) => reject(error));
    });
  }

  closed(): Promise<number> {
    return new Promise((resolve) => {
      if (this.socket.readyState === 3) {
        resolve(-1);
        return;
      }
      this.socket.once("close", (closeCode: number) => resolve(closeCode));
    });
  }

  get received(): readonly ServerControlEnvelope[] {
    return this.#received;
  }

  waitFor(
    predicate: (envelope: ServerControlEnvelope) => boolean,
    timeoutMs = 5_000,
  ): Promise<ServerControlEnvelope> {
    const existing = this.#received.find(predicate);
    if (existing !== undefined) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.#waiters.findIndex((waiter) => waiter.resolve === resolve);
        if (index >= 0) {
          this.#waiters.splice(index, 1);
        }
        reject(new Error("timed out waiting for control message"));
      }, timeoutMs);
      const waiter = {
        predicate,
        resolve: (envelope: ServerControlEnvelope) => {
          clearTimeout(timer);
          resolve(envelope);
        },
      };
      this.#waiters.push(waiter);
    });
  }

  waitForType(type: string, timeoutMs?: number): Promise<ServerControlEnvelope> {
    return this.waitFor((envelope) => envelope.type === type, timeoutMs);
  }

  send(envelope: ClientControlEnvelope): void {
    this.socket.send(JSON.stringify(envelope));
  }

  sendText(text: string): void {
    this.socket.send(text);
  }

  close(): void {
    this.socket.close(1000, "test done");
  }

  terminate(): void {
    this.socket.terminate();
  }
}

export function clientEnvelope(input: {
  readonly sessionId: string;
  readonly type: string;
  readonly payload: unknown;
  readonly ack?: bigint;
  readonly idempotencyKey?: string;
  readonly deadlineUs?: bigint;
}): ClientControlEnvelope {
  return {
    version: 1,
    direction: "client",
    type: input.type,
    messageId: randomUUID(),
    sessionId: input.sessionId,
    trace: { traceId: randomUUID().replaceAll("-", "") },
    sentAtUs: formatDecimalString(BigInt(Date.now()) * 1000n),
    ...(input.ack === undefined ? {} : { ack: formatDecimalString(input.ack) }),
    ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
    ...(input.deadlineUs === undefined
      ? {}
      : { deadlineUs: formatDecimalString(input.deadlineUs) }),
    payload: input.payload as ClientControlEnvelope["payload"],
  };
}

export function buildMediaFrame(input: {
  readonly streamId: string;
  readonly frameId: string;
  readonly sessionId: string;
  readonly sequence: number;
  readonly traceId: string;
  readonly contentType?: string;
  readonly mediaKind?: "audio" | "viseme" | "binary-test";
  readonly payload?: Uint8Array;
}): Uint8Array {
  return encodeMediaFrame({
    header: {
      schemaVersion: 1,
      streamId: input.streamId,
      frameId: input.frameId,
      sessionId: input.sessionId,
      sequence: String(input.sequence),
      contentType: input.contentType ?? "application/octet-stream",
      traceId: input.traceId,
    },
    payload: input.payload ?? new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
    mediaKind: input.mediaKind ?? "binary-test",
  });
}

export function mediaSocket(options: WsClientOptions): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${options.port}${options.path}`, {
    headers: { cookie: options.cookie, origin: options.origin },
  });
}
