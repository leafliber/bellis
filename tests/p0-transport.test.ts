import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import { type FrameEvidence, JsonChannel } from "../packages/runtime/src/transport.ts";

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const hash = (frame: Buffer) => createHash("sha256").update(frame).digest("hex");
function harness(maxBytes = 1024, maxPending = 16) {
  const input = new PassThrough();
  const chunks: Buffer[] = [];
  const output = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  const channel = new JsonChannel(input, output, maxBytes, maxPending);
  return { input, output, chunks, channel };
}
const frames = (count: number) =>
  Buffer.from(Array.from({ length: count }, (_, n) => `${JSON.stringify({ n })}\n`).join(""));

test("p0.transport module: first batch is synchronous; one chunk yields after each eight frames", async (t) => {
  const h = harness();
  t.after(() => h.channel.close());
  const seen: number[] = [];
  let completed!: () => void;
  const done = new Promise<void>((resolve) => {
    completed = resolve;
  });
  h.channel.on("message", ({ n }: { n: number }) => {
    seen.push(n);
    if (seen.length === 25) completed();
  });
  h.input.emit("data", frames(25));
  assert.deepEqual(seen, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(h.input.isPaused(), true);
  await turn();
  assert.equal(seen.length, 16);
  await done;
  assert.deepEqual(
    seen,
    Array.from({ length: 25 }, (_, n) => n),
  );
});

test("p0.transport module: many same-turn data callbacks share one frame budget", async (t) => {
  const h = harness();
  t.after(() => h.channel.close());
  let seen = 0;
  h.channel.on("message", () => seen++);
  for (let n = 0; n < 20; n++) h.input.emit("data", Buffer.from("{}\n"));
  assert.equal(seen, 8);
  await turn();
  assert.equal(seen, 16);
  await turn();
  assert.equal(seen, 20);
});

test("p0.transport module: maximum frame spans byte batches and is parsed once with exact evidence", async (t) => {
  const max = 2 * 65536;
  const frame = Buffer.from(JSON.stringify("a".repeat(max - 2)));
  assert.equal(frame.length, max);
  const h = harness(max);
  t.after(() => h.channel.close());
  const received: Array<{ value: string; evidence: FrameEvidence }> = [];
  const done = once(h.channel, "message");
  h.channel.on("message", (value: string, evidence: FrameEvidence) =>
    received.push({ value, evidence }),
  );
  h.input.emit("data", Buffer.concat([frame, Buffer.from("\n")]));
  assert.equal(received.length, 0);
  await turn();
  assert.equal(received.length, 0); // LF itself needs the third byte batch.
  await done;
  assert.equal(received.length, 1);
  assert.equal(received[0]?.value.length, max - 2);
  assert.deepEqual(received[0]?.evidence, { frame_sha256: hash(frame), frame_bytes: max });
});

test("p0.transport module: byte budget spans small callbacks and split UTF8 retains actual bytes", async (t) => {
  const frame = Buffer.from(`  {"value":"${"x".repeat(65520)}🌼"}\r`);
  const h = harness(frame.length);
  t.after(() => h.channel.close());
  const event = once(h.channel, "message");
  let count = 0;
  h.channel.on("message", () => count++);
  // Deliberately split every UTF8 byte, including the four-byte character.
  for (let index = 0; index < frame.length; index++) {
    h.input.emit("data", frame.subarray(index, index + 1));
  }
  h.input.emit("data", Buffer.from("\n"));
  assert.equal(count, 0);
  const [value, evidence] = await event;
  assert.equal(value.value, `${"x".repeat(65520)}🌼`);
  assert.deepEqual(evidence, { frame_sha256: hash(frame), frame_bytes: frame.length });
});

test("p0.transport module: seal drops same-chunk work but preserves async response across EOF", async (t) => {
  const h = harness();
  t.after(() => h.channel.close());
  const seen: unknown[] = [];
  let ended = 0;
  h.channel.on("readEnded", () => ended++);
  h.channel.on("invalid", () => assert.fail("sealed input is not truncated"));
  const closed = once(h.channel, "closed");
  h.channel.on("message", (value: unknown) => {
    seen.push(value);
    h.channel.sealRead();
    h.channel.sealRead();
    setImmediate(() => {
      assert.equal(h.channel.closed, false);
      assert.equal(h.channel.send({ result: "later" }), true);
      h.channel.end();
      assert.equal(h.channel.send({ forbidden: true }), false);
    });
  });
  h.input.emit("data", Buffer.from('{"first":true}\n{"second":true}\npartial'));
  h.input.emit("end");
  assert.equal(ended, 1);
  assert.equal(h.channel.closed, false);
  assert.deepEqual(seen, [{ first: true }]);
  await closed;
  assert.equal(Buffer.concat(h.chunks).toString(), '{"result":"later"}\n');
});

test("p0.transport module: invalid bytes seal before callbacks, preserve complete raw hash, and drain error", async () => {
  for (const frame of [
    Buffer.from(' {"duplicate":1,"duplicate":2}\r'),
    Buffer.from([0xff]),
    Buffer.from("{bad"),
  ]) {
    const h = harness();
    const closed = once(h.channel, "closed");
    const invalid: unknown[][] = [];
    let seen = 0;
    h.channel.on("message", () => seen++);
    h.channel.on("invalid", (...args: unknown[]) => {
      invalid.push(args);
      h.input.emit("data", Buffer.from('{"reentrant":true}\n'));
      assert.equal(h.channel.send({ error: "invalid" }), true);
    });
    h.input.emit("data", Buffer.concat([frame, Buffer.from('\n{"must_not_run":true}\n')]));
    await closed;
    assert.equal(seen, 0);
    assert.deepEqual(invalid, [
      ["FRAME_INVALID", { frame_sha256: hash(frame), frame_bytes: frame.length }],
    ]);
    assert.equal(Buffer.concat(h.chunks).toString(), '{"error":"invalid"}\n');
  }
});

test("p0.transport module: huge chunks and overflow after pause reject without partial evidence", async () => {
  for (const paused of [false, true]) {
    const h = harness(65535);
    const closed = once(h.channel, "closed");
    const invalid: unknown[][] = [];
    h.channel.on("invalid", (...args: unknown[]) => invalid.push(args));
    if (paused) {
      h.input.emit("data", Buffer.concat([Buffer.from("{}\n".repeat(8)), Buffer.alloc(65512, 32)]));
      assert.equal(h.input.isPaused(), true);
    }
    h.input.emit("data", Buffer.alloc(paused ? 25 : 65537, 32));
    await closed;
    assert.deepEqual(invalid, [["BUFFER_LIMIT", undefined]]);
  }
});

test("p0.transport module: frame limit across chunks stays distinct from retained-chunk limit", async () => {
  const h = harness(32);
  const invalid = once(h.channel, "invalid");
  h.input.emit("data", Buffer.alloc(20, 32));
  h.input.emit("data", Buffer.alloc(13, 32));
  assert.deepEqual(await invalid, ["FRAME_LIMIT", undefined]);
});

test("p0.transport module: EOF is announced immediately; complete batches precede truncation and close", async () => {
  for (const tail of ["", '{"unfinished":']) {
    const h = harness();
    const seen: Array<number | string> = [];
    const closed = once(h.channel, "closed");
    h.channel.on("message", ({ n }: { n: number }) => seen.push(n));
    h.channel.on("readEnded", () => seen.push("EOF"));
    h.channel.on("invalid", (reason: string, evidence: unknown) => {
      assert.equal(evidence, undefined);
      seen.push(reason);
    });
    h.input.emit("data", Buffer.concat([frames(20), Buffer.from(tail)]));
    h.input.emit("end");
    assert.deepEqual(seen, [...Array.from({ length: 8 }, (_, n) => n), "EOF"]);
    // Simulate Readable autoDestroy after end, while our own bounded queue remains.
    h.input.emit("close");
    assert.equal(h.channel.closed, false);
    await closed;
    assert.deepEqual(seen, [
      ...Array.from({ length: 8 }, (_, n) => n),
      "EOF",
      ...Array.from({ length: 12 }, (_, n) => n + 8),
      ...(tail ? ["FRAME_TRUNCATED"] : []),
    ]);
  }
});

test("p0.transport module: close cancels continuation and retires working listeners after delayed destroy errors", async () => {
  const input = new PassThrough({
    destroy(_error, callback) {
      setImmediate(() => callback(new Error("controlled teardown error")));
    },
  });
  const output = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const channel = new JsonChannel(input, output, 1024, 16);
  let seen = 0;
  channel.on("message", () => seen++);
  input.emit("data", frames(20));
  channel.close();
  await turn();
  await turn();
  assert.equal(seen, 8);
  assert.equal(input.listenerCount("data"), 0);
  assert.equal(input.listenerCount("end"), 0);
  assert.equal(input.listenerCount("error"), 1); // Static terminal error sink; no channel capture.
  assert.equal(input.listenerCount("close"), 0);
});

test("p0.transport module: the closed flag does not discard a pending Node stream error", async () => {
  const h = harness();
  const seen: string[] = [];
  const finished = new Promise<void>((resolve) => h.output.once("close", resolve));
  h.output.on("close", () => seen.push("stream-close"));
  h.channel.on("transportError", () => seen.push("active-error"));
  h.channel.on("closed", () => seen.push("channel-close"));
  h.output.destroy(new Error("controlled pending destroy error"));
  assert.equal(h.output.closed, true);
  assert.deepEqual(seen, []);
  h.channel.close();
  await finished;
  assert.deepEqual(seen, ["channel-close", "stream-close"]);
  assert.equal(h.output.listenerCount("error"), 1);

  const active = harness();
  const observed = once(active.channel, "transportError");
  active.output.destroy(new Error("controlled active stream error"));
  const [stage, error] = await observed;
  assert.equal(stage, "write");
  assert.equal((error as Error).message, "controlled active stream error");
  assert.equal(active.channel.closed, true);
});

test("p0.transport module: actual child stdout PIPE EPIPE remains handled after stdio close", {
  timeout: 3000,
}, async () => {
  const code = `import { JsonChannel } from './packages/runtime/src/transport.ts';
const record = value => process.stderr.write(value + '\\n');
const channel = new JsonChannel(process.stdin, process.stdout, 65536, 16);
channel.on('transportError', (_stage, error) => record('transport:' + error.code));
channel.on('closed', () => record('channel-closed'));
channel.on('readEnded', () => channel.send({ fact: 'controlled-fence' }));
process.stdout.on('close', () => record('stdout-close'));
record('ready');
setTimeout(() => process.exit(0), 300);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const chunks: Buffer[] = [];
  let ended = false;
  child.stderr.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
    if (!ended && Buffer.concat(chunks).toString().includes("ready\n")) {
      ended = true;
      child.stdout.destroy();
      child.stdin.end();
    }
  });
  try {
    const [code, signal] = await once(child, "close");
    assert.equal(code, 0);
    assert.equal(signal, null);
    const actual = Buffer.concat(chunks).toString().trim().split("\n");
    assert.deepEqual(actual.slice(0, 3), ["ready", "transport:EPIPE", "channel-closed"]);
    assert.ok(actual.slice(3).length > 0);
    assert.ok(actual.slice(3).every((line) => line === "stdout-close"));
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
});

test("p0.transport module: shared duplex full close ends a sealed or EOF channel", async () => {
  for (const sealed of [false, true]) {
    const duplex = new PassThrough();
    const channel = new JsonChannel(duplex, duplex, 1024, 16);
    let seen = 0;
    channel.on("message", () => seen++);
    duplex.emit("data", frames(20));
    assert.equal(seen, 8);
    if (sealed) channel.sealRead();
    duplex.emit("end");
    const closed = once(channel, "closed");
    duplex.destroy();
    await closed;
    assert.equal(channel.closed, true);
    await turn();
    assert.equal(seen, 8);
    assert.equal(channel.send({ unreachable: true }), false);
  }
});

test("p0.transport module: nonbyte input is rejected before inspecting length", async () => {
  for (const raw of [
    "{}\n",
    42,
    {
      get length() {
        throw new Error("must not inspect");
      },
    },
  ]) {
    const h = harness();
    const invalid = once(h.channel, "invalid");
    assert.doesNotThrow(() => h.input.emit("data", raw));
    assert.deepEqual(await invalid, ["FRAME_INVALID", undefined]);
  }
});

test("p0.transport module: accepted backpressure is never resent; callback settlement is once-only", (t) => {
  const h = harness(1024, 1);
  t.after(() => h.channel.close());
  const callbacks: Array<(error?: Error | null) => void> = [];
  let calls = 0;
  Object.defineProperty(h.output, "write", {
    value: (_data: Buffer, callback: (error?: Error | null) => void) => {
      calls++;
      callbacks.push(callback);
      return false;
    },
  });
  assert.equal(h.channel.send({ n: 1 }), true);
  assert.equal(calls, 1);
  callbacks[0]?.();
  callbacks[0]?.(); // A faulty controlled sink must not create a negative quota.
  assert.equal(h.channel.send({ n: 2 }), true);
  assert.equal(h.channel.send({ overflow: true }), false);
  assert.equal(calls, 2);
});

test("p0.transport module: callback-then-throw and throwing observation listeners close safely", () => {
  for (const fault of ["write", "enqueue", "queued", "message"] as const) {
    const h = harness();
    const failures: string[] = [];
    h.channel.on("transportError", (stage: string) => failures.push(stage));
    h.channel.on("dispatchError", () => failures.push("dispatch"));
    h.channel.on("invalid", () => assert.fail("dispatch must not become invalid JSON"));
    let writes = 0;
    Object.defineProperty(h.output, "write", {
      value: (_data: Buffer, callback: (error?: Error | null) => void) => {
        writes++;
        callback();
        if (fault === "write") throw new Error("after callback");
        return true;
      },
    });
    if (fault !== "write")
      h.channel.on(fault, () => {
        throw new Error("observer/handler");
      });
    assert.doesNotThrow(() => {
      if (fault === "message") h.input.emit("data", Buffer.from("{}\n"));
      else assert.equal(h.channel.send({ n: 1 }), false);
    });
    assert.equal(h.channel.closed, true);
    assert.deepEqual(failures, [fault === "write" ? "write" : "dispatch"]);
    assert.equal(writes, fault === "enqueue" || fault === "message" ? 0 : 1);
  }
});

test("p0.transport module: end exceptions and synchronous end completion clear the drain timer", (t) => {
  const nativeSet = globalThis.setTimeout;
  const nativeClear = globalThis.clearTimeout;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  t.mock.method(globalThis, "setTimeout", (callback: () => void, milliseconds?: number) => {
    const timer = nativeSet(callback, milliseconds);
    timers.add(timer);
    return timer;
  });
  t.mock.method(globalThis, "clearTimeout", (timer: ReturnType<typeof setTimeout> | undefined) => {
    if (timer) timers.delete(timer);
    nativeClear(timer);
  });
  for (const throws of [false, true]) {
    const h = harness();
    Object.defineProperty(h.output, "end", {
      value: (callback: () => void) => {
        if (throws) throw new Error("end failed");
        callback();
      },
    });
    assert.doesNotThrow(() => h.channel.end());
    assert.equal(h.channel.closed, true);
    assert.equal(timers.size, 0);
  }
});
