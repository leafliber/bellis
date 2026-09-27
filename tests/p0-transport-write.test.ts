import assert from "node:assert/strict";
import { once } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import { JsonChannel, type WriteCompletion } from "../packages/runtime/src/transport.ts";

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const failed = (reason: "closed" | "encode" | "limit" | "write" | "dispatch"): WriteCompletion => ({
  status: "failed",
  reason,
});
const written: WriteCompletion = { status: "written" };

// Real Node Writable buffering/callbacks; only the underlying device completion
// is controlled. This is transport module coverage, not a device/SUT receipt.
function slow(maxPending = 2, maxBytes = 1024) {
  const callbacks: Array<(error?: Error | null) => void> = [];
  const chunks: Buffer[] = [];
  const output = new Writable({
    highWaterMark: 1,
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callbacks.push(callback);
    },
  });
  const channel = new JsonChannel(new PassThrough(), output, maxBytes, maxPending);
  return { channel, output, callbacks, chunks };
}

test("p0.transport write: real Writable backpressure waits for local completion and never resends", async (t) => {
  const h = slow();
  t.after(() => h.channel.close());
  const results: Array<[number, WriteCompletion]> = [];
  const queued: number[] = [];
  h.channel.on("queued", (value: { n: number }) => queued.push(value.n));
  const send = (n: number) => h.channel.send({ n }, (result) => results.push([n, result]));
  assert.equal(send(1), true);
  assert.equal(send(2), true);
  assert.equal(h.output.writableNeedDrain, true);
  assert.equal(h.chunks.length, 1);
  assert.deepEqual(results, []);
  assert.deepEqual(queued, [1, 2]);
  h.callbacks[0]?.();
  await turn();
  assert.deepEqual(results, [[1, written]]);
  assert.equal(send(3), true); // Exactly one completed write released a slot.
  h.callbacks[1]?.();
  await turn();
  h.callbacks[2]?.();
  await turn();
  assert.deepEqual(results, [
    [1, written],
    [2, written],
    [3, written],
  ]);
  assert.equal(Buffer.concat(h.chunks).toString(), '{"n":1}\n{"n":2}\n{"n":3}\n');
});

test("p0.transport write: real pending limit rejects new work and settles every retained callback", async () => {
  const h = slow();
  const results: Array<[number, WriteCompletion]> = [];
  for (const n of [1, 2])
    assert.equal(
      h.channel.send({ n }, (result) => results.push([n, result])),
      true,
    );
  assert.equal(
    h.channel.send({ n: 3 }, (result) => results.push([3, result])),
    false,
  );
  assert.equal(h.channel.closed, true);
  assert.deepEqual(results, [
    [1, failed("limit")],
    [2, failed("limit")],
    [3, failed("limit")],
  ]);
  h.callbacks[0]?.();
  await turn();
  assert.equal(results.length, 3);
  assert.equal(h.chunks.length, 1);
});

test("p0.transport write: actual Writable callback error and destroy(error) preserve the first failure", async () => {
  for (const kind of ["callback", "destroy"] as const) {
    const h = slow();
    const results: WriteCompletion[] = [];
    const errors: unknown[] = [];
    const problem = new Error(`controlled ${kind}`);
    h.channel.on("transportError", (stage, error) => errors.push([stage, error]));
    assert.equal(
      h.channel.send({ n: 1 }, (result) => results.push(result)),
      true,
    );
    assert.equal(
      h.channel.send({ n: 2 }, (result) => results.push(result)),
      true,
    );
    if (kind === "callback") h.callbacks[0]?.(problem);
    else h.output.destroy(problem);
    await turn();
    assert.equal(h.channel.closed, true);
    assert.deepEqual(errors, [["write", problem]]);
    assert.deepEqual(results, [failed("write"), failed("write")]);
    assert.equal(h.output.listenerCount("error"), 1); // Static retirement sink remains.
  }
});

test("p0.transport write: close settles pending before late device completion without rewriting success", async () => {
  const h = slow();
  const results: Array<[number, WriteCompletion]> = [];
  h.channel.send({ n: 1 }, (result) => results.push([1, result]));
  h.callbacks[0]?.();
  await turn();
  h.channel.send({ n: 2 }, (result) => results.push([2, result]));
  h.channel.close();
  assert.deepEqual(results, [
    [1, written],
    [2, failed("closed")],
  ]);
  h.callbacks[1]?.();
  await turn();
  h.channel.close();
  assert.deepEqual(results, [
    [1, written],
    [2, failed("closed")],
  ]);
});

test("p0.transport write: close fixes pending failure before a real Writable destroy hook completes its write", () => {
  let finishWrite: (() => void) | undefined;
  const output = new Writable({
    write(_chunk, _encoding, callback) {
      finishWrite = callback;
    },
    destroy(error, callback) {
      finishWrite?.();
      callback(error);
    },
  });
  const channel = new JsonChannel(new PassThrough(), output, 1024, 1);
  const results: WriteCompletion[] = [];
  channel.send({}, (result) => results.push(result));
  channel.close();
  assert.deepEqual(results, [failed("closed")]);
});

test("p0.transport write: active stream error fixes failure before an observer completes the old write", async () => {
  const h = slow();
  const results: WriteCompletion[] = [];
  const problem = new Error("controlled destroy error with observer reentry");
  const errors: unknown[] = [];
  h.channel.on("transportError", (stage, error) => {
    errors.push([stage, error]);
    h.callbacks[0]?.();
  });
  h.channel.send({}, (result) => results.push(result));
  h.output.destroy(problem);
  await turn();
  assert.deepEqual(errors, [["write", problem]]);
  assert.deepEqual(results, [failed("write")]);
});

test("p0.transport write: a synchronous callback error precedes a later write throw", () => {
  const h = slow(1);
  const first = new Error("callback failed first");
  const second = new Error("write threw second");
  const errors: Array<[string, unknown]> = [];
  const results: WriteCompletion[] = [];
  const queued: unknown[] = [];
  let callback: ((error?: Error | null) => void) | undefined;
  h.channel.on("transportError", (stage, error) => errors.push([stage, error]));
  h.channel.on("queued", (value) => queued.push(value));
  Object.defineProperty(h.output, "write", {
    value: (_data: Buffer, done: (error?: Error | null) => void) => {
      callback = done;
      done(first);
      throw second;
    },
  });
  assert.equal(
    h.channel.send({}, (result) => results.push(result)),
    false,
  );
  assert.deepEqual(errors, [["write", first]]);
  assert.deepEqual(results, [failed("write")]);
  assert.deepEqual(queued, []);
  assert.equal(h.channel.closed, true);
  callback?.(second);
  assert.deepEqual(results, [failed("write")]);
});

test("p0.transport write: a transportError observer cannot re-report a later stream error", async () => {
  const h = slow();
  const first = new Error("stream failed first");
  const second = new Error("observer emitted second");
  const errors: Array<[string, unknown]> = [];
  const results: WriteCompletion[] = [];
  h.channel.on("transportError", (stage, error) => {
    errors.push([stage, error]);
    if (error === first) h.output.emit("error", second); // Finite controlled reentry.
  });
  assert.equal(
    h.channel.send({ n: 1 }, (result) => results.push(result)),
    true,
  );
  assert.equal(
    h.channel.send({ n: 2 }, (result) => results.push(result)),
    true,
  );
  h.output.emit("error", first);
  assert.deepEqual(errors, [["write", first]]);
  assert.deepEqual(results, [failed("write"), failed("write")]);
  assert.equal(h.channel.closed, true);
  h.callbacks[0]?.();
  await turn();
  assert.deepEqual(results, [failed("write"), failed("write")]);
});

test("p0.transport write: normal end drains accepted writes while refusing new writes", async () => {
  const h = slow();
  const results: Array<[number, WriteCompletion]> = [];
  h.channel.send({ n: 1 }, (result) => results.push([1, result]));
  h.channel.send({ n: 2 }, (result) => results.push([2, result]));
  const closed = once(h.channel, "closed");
  h.channel.end();
  assert.equal(h.channel.closed, false);
  assert.equal(
    h.channel.send({ n: 3 }, (result) => results.push([3, result])),
    false,
  );
  assert.deepEqual(results, [[3, failed("closed")]]);
  h.callbacks[0]?.();
  h.callbacks[1]?.();
  await closed;
  assert.deepEqual(results, [
    [3, failed("closed")],
    [1, written],
    [2, written],
  ]);
});

test("p0.transport write: original finite end deadline fails an unfinished write", async () => {
  const h = slow();
  const results: WriteCompletion[] = [];
  h.channel.send({ pending: true }, (result) => results.push(result));
  const closed = once(h.channel, "closed");
  h.channel.end();
  await closed;
  assert.deepEqual(results, [failed("closed")]);
  h.callbacks[0]?.();
  await turn();
  assert.deepEqual(results, [failed("closed")]);
});

// Deliberately non-conforming write overrides exercise synchronous and duplicate
// callback adversaries; they are not claims about ordinary Node Writable behavior.
test("p0.transport write: controlled synchronous callback waits for queued; callback then throw only fails", () => {
  for (const throws of [false, true]) {
    const h = slow(1);
    const order: string[] = [];
    const results: WriteCompletion[] = [];
    let callback: ((error?: Error | null) => void) | undefined;
    Object.defineProperty(h.output, "write", {
      value: (_data: Buffer, done: (error?: Error | null) => void) => {
        callback = done;
        order.push("write");
        done();
        assert.deepEqual(results, []);
        if (throws) throw new Error("controlled callback then throw");
        return false;
      },
    });
    h.channel.on("queued", () => order.push("queued"));
    assert.equal(
      h.channel.send({}, (result) => {
        order.push("complete");
        results.push(result);
      }),
      !throws,
    );
    assert.deepEqual(results, [throws ? failed("write") : written]);
    assert.deepEqual(order, throws ? ["write", "complete"] : ["write", "queued", "complete"]);
    callback?.();
    callback?.(new Error("late duplicate"));
    assert.equal(results.length, 1);
    h.channel.close();
  }
});

test("p0.transport write: completion frees its slot before reentrant send and close", async () => {
  const h = slow(1);
  const results: Array<[number, WriteCompletion]> = [];
  h.channel.send({ n: 1 }, (result) => {
    results.push([1, result]);
    assert.equal(
      h.channel.send({ n: 2 }, (next) => results.push([2, next])),
      true,
    );
    h.channel.close();
  });
  h.callbacks[0]?.();
  await turn();
  assert.deepEqual(results, [
    [1, written],
    [2, failed("closed")],
  ]);
  h.callbacks[1]?.();
  await turn();
  assert.equal(results.length, 2);
});

test("p0.transport write: throwing completion cannot strand others or escape close", async () => {
  for (const closing of [false, true]) {
    const h = slow();
    const results: Array<[number, WriteCompletion]> = [];
    const failures: string[] = [];
    h.channel.on("dispatchError", () => failures.push("dispatch"));
    h.channel.send({ n: 1 }, (result) => {
      results.push([1, result]);
      throw new Error("controlled completion exception");
    });
    h.channel.send({ n: 2 }, (result) => results.push([2, result]));
    assert.doesNotThrow(() => (closing ? h.channel.close() : h.callbacks[0]?.()));
    await turn();
    assert.equal(h.channel.closed, true);
    assert.deepEqual(results, [
      [1, closing ? failed("closed") : written],
      [2, failed(closing ? "closed" : "dispatch")],
    ]);
    assert.deepEqual(failures, ["dispatch"]);
  }
});

test("p0.transport write: observer exceptions settle failure once and cannot reenter an accepting sender", () => {
  for (const fault of ["enqueue", "queued"] as const) {
    const h = slow();
    const results: WriteCompletion[] = [];
    const reentrant: WriteCompletion[] = [];
    Object.defineProperty(h.output, "write", {
      value: (_data: Buffer, done: () => void) => {
        done();
        return true;
      },
    });
    h.channel.on(fault, () => {
      throw new Error("controlled observation failure");
    });
    h.channel.on("dispatchError", () => {
      assert.equal(
        h.channel.send({}, (result) => reentrant.push(result)),
        false,
      );
    });
    assert.equal(
      h.channel.send({}, (result) => results.push(result)),
      false,
    );
    assert.deepEqual(results, [failed("dispatch")]);
    assert.deepEqual(reentrant, [failed("closed")]);
  }
});

test("p0.transport write: closed, encoding and frame limits all report immediate refusal once", () => {
  for (const kind of ["closed", "encode", "limit"] as const) {
    const h = slow(1, 32);
    const results: WriteCompletion[] = [];
    if (kind === "closed") h.channel.close();
    const value = kind === "encode" ? 1n : { text: "x".repeat(64) };
    assert.doesNotThrow(() => {
      assert.equal(
        h.channel.send(value, (result) => results.push(result)),
        false,
      );
    });
    assert.deepEqual(results, [failed(kind)]);
    assert.equal(h.chunks.length, 0);
    h.channel.close();
    assert.equal(results.length, 1);
  }
});
