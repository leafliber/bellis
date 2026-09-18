import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import { parseJson } from "../../contract-sdk/src/index.ts";

export type FrameEvidence = { frame_sha256: string; frame_bytes: number };

const BATCH_FRAMES = 8;
const BATCH_BYTES = 64 * 1024;

// Node stdio can emit close before a pending write error, and close again later.
// A terminal stream retains only this static listener: no channel, timer or I/O.
function ignoreTerminalError(): void {}
function destroyStream(stream: Readable | Writable): void {
  stream.on("error", ignoreTerminalError);
  try {
    stream.destroy();
  } catch {}
}

/** Shared socket/stdio framing. Parser batches bound work, not elapsed-time SLOs.
 * Parser-owned input Buffers total at most M + R bytes, M=maxBytes,
 * R=max(64KiB, M+1). Copying an accepted chunk is bounded by R; scanning/appending
 * per batch is 64KiB. A complete JSON frame is decoded/parsed once (up to M).
 * Decoded strings/objects and maxPending accepted output frames are separate.
 */
export class JsonChannel extends EventEmitter {
  readonly input: Readable;
  readonly output: Writable;
  readonly maxBytes: number;
  readonly maxPending: number;
  readonly #retainedLimit: number;
  #frame: Buffer | undefined;
  #used = 0;
  #retained: Buffer | undefined;
  #start = 0;
  #endOffset = 0;
  #batchFrames = 0;
  #batchBytes = 0;
  #continuation: ReturnType<typeof setImmediate> | undefined;
  #endTimer: ReturnType<typeof setTimeout> | undefined;
  #pumping = false;
  #eof = false;
  #readSealed = false;
  #writes = new Set<symbol>();
  #closed = false;
  #ending = false;
  #decoder = new TextDecoder("utf-8", { fatal: true });
  constructor(input: Readable, output: Writable, maxBytes: number, maxPending: number) {
    super();
    this.input = input;
    this.output = output;
    this.maxBytes = maxBytes;
    this.maxPending = maxPending;
    this.#retainedLimit = Math.max(BATCH_BYTES, maxBytes + 1);
    input.on("data", this.#data);
    input.on("end", this.#end);
    input.on("error", this.#readError);
    input.on("close", this.#inputClosed);
    if ((output as unknown) !== input) {
      output.on("error", this.#writeError);
      output.on("close", this.#outputClosed);
    }
  }
  get closed(): boolean {
    return this.#closed;
  }
  #data = (chunk: Buffer): void => {
    if (this.#closed || this.#readSealed || this.#eof) return;
    if (!Buffer.isBuffer(chunk)) {
      this.#invalid("FRAME_INVALID");
      return;
    }
    const remaining = this.#endOffset - this.#start;
    // Check before copying/scanning, including hostile emissions after pause().
    if (chunk.length > this.#retainedLimit - remaining) {
      this.#invalid("BUFFER_LIMIT");
      return;
    }
    if (!chunk.length) return;
    this.#retained ??= Buffer.allocUnsafeSlow(this.#retainedLimit);
    if (this.#start) this.#retained.copyWithin(0, this.#start, this.#endOffset);
    chunk.copy(this.#retained, remaining);
    this.#start = 0;
    this.#endOffset = remaining + chunk.length;
    this.#schedule();
    this.#pump();
  };
  #schedule(): void {
    if (this.#continuation || this.#closed || this.#readSealed) return;
    this.#continuation = setImmediate(() => {
      this.#continuation = undefined;
      if (this.#closed || this.#readSealed) return;
      // Data callbacks before this continuation share one budget.
      this.#batchFrames = 0;
      this.#batchBytes = 0;
      this.#pump();
      if (this.#closed || this.#readSealed) return;
      if (this.#batchBytes || this.#start < this.#endOffset) this.#schedule();
      if (!this.#eof && !this.#spent()) this.input.resume();
    });
  }
  #spent(): boolean {
    return this.#batchFrames >= BATCH_FRAMES || this.#batchBytes >= BATCH_BYTES;
  }
  #pump(): void {
    if (this.#pumping || this.#closed || this.#readSealed) return;
    this.#pumping = true;
    try {
      while (this.#start < this.#endOffset && !this.#spent()) {
        const retained = this.#retained;
        if (!retained) return;
        const stop = Math.min(this.#endOffset, this.#start + BATCH_BYTES - this.#batchBytes);
        const offset = retained.subarray(this.#start, stop).indexOf(10);
        const newline = offset < 0 ? -1 : this.#start + offset;
        const end = newline < 0 ? stop : newline;
        const bytes = end - this.#start;
        if (this.#used + bytes > this.maxBytes) {
          this.#invalid("FRAME_LIMIT");
          return;
        }
        if (bytes) {
          // Allocate once, then append. Only the written prefix is ever read.
          this.#frame ??= Buffer.allocUnsafeSlow(this.maxBytes);
          retained.copy(this.#frame, this.#used, this.#start, end);
          this.#used += bytes;
        }
        const consumed = bytes + (newline < 0 ? 0 : 1);
        this.#start += consumed;
        this.#batchBytes += consumed;
        if (newline < 0) continue;
        this.#batchFrames++;
        const frame = this.#frame?.subarray(0, this.#used) ?? Buffer.alloc(0);
        const evidence = {
          frame_sha256: createHash("sha256").update(frame).digest("hex"),
          frame_bytes: this.#used,
        };
        this.#used = 0;
        let parsed: unknown;
        try {
          parsed = parseJson(this.#decoder.decode(frame));
        } catch {
          this.#invalid("FRAME_INVALID", evidence);
          return;
        }
        try {
          this.emit("message", parsed, evidence);
        } catch (error) {
          this.#dispatchFailed(error);
        }
        // off(data) cannot stop this already-entered chunk by itself.
        if (this.#closed || this.#readSealed) return;
      }
      if (this.#start === this.#endOffset) {
        this.#start = 0;
        this.#endOffset = 0;
        if (this.#eof) {
          if (this.#used) this.#invalid("FRAME_TRUNCATED");
          else this.end();
          return;
        }
      }
      if (this.#spent()) this.input.pause();
    } finally {
      this.#pumping = false;
    }
  }
  #invalid(reason: string, evidence?: FrameEvidence): void {
    this.sealRead();
    try {
      this.emit("invalid", reason, evidence);
    } catch (error) {
      this.#dispatchFailed(error);
    }
    this.end();
  }
  #end = (): void => {
    if (this.#closed || this.#eof) return;
    this.#eof = true;
    try {
      // Immediate transport fact; queued parsing must not defer a safety fence.
      this.emit("readEnded");
    } catch (error) {
      this.#dispatchFailed(error);
    }
    if (this.#closed || this.#readSealed) return;
    this.input.pause();
    this.input.off("data", this.#data);
    this.#pump();
  };
  #readError = (error: unknown): void => this.#failed("read", error);
  #writeError = (error: unknown): void => this.#failed("write", error);
  #failed = (stage: "read" | "write" | "encode", error: unknown): void => {
    if (this.#closed) return;
    try {
      this.emit("transportError", stage, error);
    } catch {
      // Diagnostic failure must not escape cleanup.
    } finally {
      this.close();
    }
  };
  #dispatchFailed(error: unknown): void {
    try {
      this.emit("dispatchError", error);
    } catch {
      // Preserve shutdown even if the observer failed.
    } finally {
      this.close();
    }
  }
  #inputClosed = (): void => {
    // autoDestroy after EOF must not discard retained frames or a sealed handler's response.
    // A shared duplex close is full transport loss, not merely read EOF.
    if ((this.output as unknown) === this.input || (!this.#eof && !this.#readSealed)) this.close();
  };
  #outputClosed = (): void => {
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
    if (data.length - 1 > this.maxBytes || this.#writes.size >= this.maxPending) {
      this.close();
      return false;
    }
    const token = Symbol();
    this.#writes.add(token);
    const settle = (error?: Error | null) => {
      if (!this.#writes.delete(token)) return;
      if (error) this.#failed("write", error);
    };
    try {
      this.emit("enqueue", value);
    } catch (error) {
      settle();
      this.#dispatchFailed(error);
      return false;
    }
    if (this.#closed || this.#ending) {
      settle();
      return false;
    }
    try {
      // false means accepted backpressure, never a retry instruction.
      this.output.write(data, settle);
    } catch (error) {
      settle();
      this.#failed("write", error);
      return false;
    }
    if (this.#closed) return false;
    try {
      this.emit("queued", value);
    } catch (error) {
      settle();
      this.#dispatchFailed(error);
      return false;
    }
    return true;
  }
  /** Seal only input; a handler may still send its later async result. */
  sealRead(): void {
    if (this.#readSealed) return;
    this.#readSealed = true;
    this.input.pause();
    this.input.off("data", this.#data);
    clearImmediate(this.#continuation);
    this.#continuation = undefined;
    this.#frame = undefined;
    this.#retained = undefined;
    this.#used = 0;
    this.#start = 0;
    this.#endOffset = 0;
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.sealRead();
    clearTimeout(this.#endTimer);
    this.#endTimer = undefined;
    this.#writes.clear();
    this.input.off("end", this.#end);
    this.input.off("error", this.#readError);
    this.input.off("close", this.#inputClosed);
    if ((this.output as unknown) !== this.input) {
      this.output.off("error", this.#writeError);
      this.output.off("close", this.#outputClosed);
    }
    destroyStream(this.input);
    if ((this.output as unknown) !== this.input) destroyStream(this.output);
    this.emit("closed");
  }
  end(): void {
    if (this.#closed || this.#ending) return;
    this.#ending = true;
    this.sealRead();
    this.#endTimer = setTimeout(() => this.close(), 100);
    try {
      this.output.end(() => this.close());
    } catch (error) {
      this.#failed("write", error);
    }
  }
}
