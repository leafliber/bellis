import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import { parseJson } from "../../contract-sdk/src/index.ts";

export type FrameEvidence = { frame_sha256: string; frame_bytes: number };

/** Bounded bytes and pending writes; the same framing serves sockets and child stdio. */
export class JsonChannel extends EventEmitter {
  readonly input: Readable;
  readonly output: Writable;
  readonly maxBytes: number;
  readonly maxPending: number;
  #buffer = Buffer.alloc(0);
  #writes = 0;
  #closed = false;
  #ending = false;
  #decoder = new TextDecoder("utf-8", { fatal: true });
  constructor(input: Readable, output: Writable, maxBytes: number, maxPending: number) {
    super();
    this.input = input;
    this.output = output;
    this.maxBytes = maxBytes;
    this.maxPending = maxPending;
    input.on("data", this.#data);
    input.on("end", this.#end);
    input.on("error", (error) => this.#failed("read", error));
    output.on("error", (error) => this.#failed("write", error));
    input.on("close", this.#close);
  }
  get closed(): boolean {
    return this.#closed;
  }
  #data = (chunk: Buffer): void => {
    if (this.#closed || this.#ending) return;
    // Avoid allocating an unbounded accumulated buffer even when a peer never sends a newline.
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf(10, start);
      const end = newline < 0 ? chunk.length : newline;
      if (this.#buffer.length + end - start > this.maxBytes) {
        this.emit("invalid", "FRAME_LIMIT");
        this.close();
        return;
      }
      const part = chunk.subarray(start, end);
      this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, part]) : Buffer.from(part);
      if (newline < 0) break;
      const frame = this.#buffer;
      this.#buffer = Buffer.alloc(0);
      const evidence = {
        frame_sha256: createHash("sha256").update(frame).digest("hex"),
        frame_bytes: frame.length,
      };
      let parsed: unknown;
      let valid = false;
      try {
        parsed = parseJson(this.#decoder.decode(frame));
        valid = true;
      } catch {
        this.emit("invalid", "FRAME_INVALID", evidence);
      }
      if (valid) {
        try {
          this.emit("message", parsed, evidence);
        } catch (error) {
          this.emit("dispatchError", error);
          this.close();
        }
      }
      if (this.#closed || this.#ending) return;
      start = newline + 1;
      if (start === chunk.length) break;
    }
  };
  #end = (): void => {
    if (this.#buffer.length) this.emit("invalid", "FRAME_TRUNCATED");
    this.close();
  };
  #failed = (stage: "read" | "write" | "encode", error: unknown): void => {
    this.emit("transportError", stage, error);
    this.close();
  };
  #close = (): void => {
    this.close();
  };
  send(value: unknown): boolean {
    if (this.#closed || this.#ending) return false;
    let data: Buffer;
    try {
      data = Buffer.from(`${JSON.stringify(value)}\n`);
    } catch (error) {
      this.#failed("encode", error);
      return false;
    }
    if (data.length - 1 > this.maxBytes || this.#writes >= this.maxPending) {
      this.close();
      return false;
    }
    this.#writes++;
    this.emit("enqueue", value);
    try {
      this.output.write(data, (error) => {
        this.#writes--;
        if (error) this.#failed("write", error);
      });
      this.emit("queued", value);
    } catch (error) {
      this.#writes--;
      this.#failed("write", error);
      return false;
    }
    return true;
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#buffer = Buffer.alloc(0);
    this.input.off("data", this.#data);
    this.input.off("end", this.#end);
    this.input.destroy();
    if ((this.output as unknown) !== this.input) this.output.destroy();
    this.emit("closed");
  }
  end(): void {
    if (this.#closed || this.#ending) return;
    this.#ending = true;
    this.input.pause();
    const timer = setTimeout(() => this.close(), 100);
    this.output.end(() => {
      clearTimeout(timer);
      this.close();
    });
  }
}
