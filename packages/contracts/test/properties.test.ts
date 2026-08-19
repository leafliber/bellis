import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseDecimalString } from "../src/common/decimal-string.js";
import {
  ClientControlEnvelopeSchema,
  ServerControlEnvelopeSchema,
} from "../src/transport/control-envelope.js";
import { MAX_U64, MESSAGE_ID, SESSION_ID, TRACE_ID } from "./fixtures.js";

/**
 * 性质测试（phase-1-build-guide.md §11.2）：
 * - 任意合法 Envelope JSON 编码再解码保持等价。
 * - 任意大序号和水位在 JSON 往返后无精度损失（包括超过 2^53 的值）。
 */

const decimalArb = fc.bigInt({ min: 0n, max: 10n ** 30n - 1n }).map((value) => value.toString(10));

function serverEnvelope(seq: string, sentAtUs: string): Record<string, unknown> {
  return {
    version: 1,
    type: "scene.committed",
    messageId: MESSAGE_ID,
    sessionId: SESSION_ID,
    trace: { traceId: TRACE_ID },
    sentAtUs,
    payload: { sceneId: "44444444-4444-4444-8444-444444444444" },
    direction: "server",
    seq,
  };
}

function clientEnvelope(ack: string, sentAtUs: string): Record<string, unknown> {
  return {
    version: 1,
    type: "clock.ping",
    messageId: MESSAGE_ID,
    sessionId: SESSION_ID,
    trace: { traceId: TRACE_ID },
    sentAtUs,
    payload: { c0: "1" },
    direction: "client",
    ack,
  };
}

describe("envelope JSON round-trip", () => {
  it("server envelope survives JSON encode/decode with exact seq and sentAtUs", () => {
    fc.assert(
      fc.property(decimalArb, decimalArb, (seq, sentAtUs) => {
        const wire = JSON.parse(JSON.stringify(serverEnvelope(seq, sentAtUs)));
        const parsed = ServerControlEnvelopeSchema.parse(wire);
        expect(parseDecimalString(parsed.seq)).toBe(BigInt(seq));
        expect(parseDecimalString(parsed.sentAtUs)).toBe(BigInt(sentAtUs));
      }),
      { numRuns: 200 },
    );
  });

  it("client envelope survives JSON encode/decode with exact ack", () => {
    fc.assert(
      fc.property(decimalArb, decimalArb, (ack, sentAtUs) => {
        const wire = JSON.parse(JSON.stringify(clientEnvelope(ack, sentAtUs)));
        const parsed = ClientControlEnvelopeSchema.parse(wire);
        expect(parseDecimalString(parsed.ack as string)).toBe(BigInt(ack));
      }),
      { numRuns: 200 },
    );
  });

  it("values beyond 2^53 keep exact precision as decimal strings", () => {
    const cases = [2n ** 53n + 1n, 2n ** 63n - 1n, BigInt(MAX_U64)];
    for (const value of cases) {
      const decimal = value.toString(10);
      const wire = JSON.parse(JSON.stringify(serverEnvelope(decimal, decimal)));
      expect(wire.seq).toBe(decimal);
      expect(parseDecimalString(wire.seq as string)).toBe(value);
    }
  });
});
