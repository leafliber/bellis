import assert from "node:assert/strict";
import { test } from "node:test";
import { parseJson, payloadDigest } from "../packages/contract-sdk/src/index.ts";

test("sdk.json: preserves valid JSON including astral characters and escaped keys", () => {
  for (const value of [null, true, 1.5, [1, "🎙"], { x: [false], "a\\b": '"' }]) {
    assert.deepEqual(parseJson(JSON.stringify(value)), value);
  }
  assert.equal(payloadDigest({ a: 1, b: 2 }), payloadDigest({ b: 2, a: 1 }));
});

test("sdk.json: rejects duplicate keys, invalid syntax, overflow and excessive nesting", () => {
  for (const input of [
    '{"a":1,"\\u0061":2}',
    "[1,]",
    '{"x":}',
    "NaN",
    "1e9999",
    '"\\ud800"',
    "true false",
    "01",
    "[",
    '"x',
    `${"[".repeat(66)}0${"]".repeat(66)}`,
  ]) {
    assert.throws(() => parseJson(input), input);
  }
  assert.throws(() => payloadDigest({ x: Infinity }));
  assert.throws(() => payloadDigest({ x: "\ud800" }));
  assert.throws(() => payloadDigest(new Array(2)));
});
