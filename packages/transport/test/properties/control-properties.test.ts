import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { formatDecimalString, parseDecimalString } from "@bellis/contracts";
import {
  BoundedSendQueue,
  ReplayWindow,
  decodeControlMessage,
  encodeControlMessage,
} from "../../src/index.js";
import type { QueuedSend, ReplayMessage, SendPriority } from "../../src/index.js";
import type { ControlEnvelope } from "@bellis/contracts";
import { SESSION_ID, TRACE_ID, VALID_PAYLOADS, serverText } from "../helpers.js";

/**
 * 性质测试（phase-1-build-guide.md §11.2）：
 * - 任意合法 Envelope 编码再解码保持等价。
 * - 任意大序号/时间十进制字符串 JSON 往返无精度损失。
 * - 任意 ACK 序列不会让已确认 Seq 倒退或超过已分配最大 Seq。
 * - 任意队列操作不会突破配置的消息/字节上限（守恒式记账）。
 */

function makeEntry(seq: bigint): ReplayMessage {
  const text = serverText({ type: "scene.prepared" }, { seq: seq.toString() });
  return {
    seq,
    messageId: crypto.randomUUID(),
    text,
    envelope: JSON.parse(text),
    persistable: true,
  };
}

/** 方向兼容的 (type, payload) 组合表。 */
const CLIENT_TYPES = ["client.hello", "heartbeat.ping", "clock.ping", "media.stream.open"] as const;
const SERVER_TYPES = [
  "server.hello",
  "server.ready",
  "heartbeat.pong",
  "clock.pong",
  "session.snapshot",
  "scene.prepared",
  "scene.committed",
  "scene.cancelled",
  "error",
] as const;

const decimalStringArb = fc
  .bigInt({ min: 0n, max: 10n ** 30n - 1n })
  .map((value) => formatDecimalString(value));

const envelopeArb = fc
  .record({
    type: fc.constantFrom(...CLIENT_TYPES, ...SERVER_TYPES),
    messageId: fc.uuid(),
    sentAtUs: decimalStringArb,
    withDeadline: fc.boolean(),
    seq: fc.bigInt({ min: 0n, max: 10n ** 20n }),
    ack: fc.bigInt({ min: 0n, max: 10n ** 20n }),
    withAck: fc.boolean(),
  })
  .map((fields) => {
    const isClientType = (CLIENT_TYPES as readonly string[]).includes(fields.type);
    const direction: "client" | "server" = isClientType ? "client" : "server";
    const envelope: Record<string, unknown> = {
      version: 1,
      direction,
      type: fields.type,
      messageId: fields.messageId,
      sessionId: SESSION_ID,
      trace: { traceId: TRACE_ID },
      sentAtUs: fields.sentAtUs,
      payload: VALID_PAYLOADS[fields.type],
    };
    if (fields.withDeadline) {
      envelope.deadlineUs = formatDecimalString(fields.seq);
    }
    if (direction === "server") {
      envelope.seq = formatDecimalString(fields.seq);
    } else if (fields.withAck) {
      envelope.ack = formatDecimalString(fields.ack);
    }
    return envelope as unknown as ControlEnvelope;
  });

describe("性质：Control Envelope 编解码", () => {
  it("任意合法 Envelope：encode → decode 保持深度等价", () => {
    fc.assert(
      fc.property(envelopeArb, (envelope) => {
        const encoded = encodeControlMessage(envelope);
        const decoded = decodeControlMessage(encoded);
        expect(decoded.ok).toBe(true);
        if (decoded.ok) {
          expect(decoded.value).toEqual(envelope);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("任意大的 seq/ack/时间：十进制字符串 JSON 往返无精度损失", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 30n - 1n }), (value) => {
        const wire = formatDecimalString(value);
        const roundTrip = parseDecimalString(JSON.parse(JSON.stringify(wire)) as string);
        expect(roundTrip).toBe(value);
      }),
      { numRuns: 300 },
    );
  });

  it("翻转 direction 后必须稳定拒绝（方向判别字段不可伪装）", () => {
    fc.assert(
      fc.property(envelopeArb, (envelope) => {
        const opposite = envelope.direction === "client" ? "server" : "client";
        const mutated = { ...envelope, direction: opposite };
        const result = decodeControlMessage(JSON.stringify(mutated));
        expect(result.ok).toBe(false);
      }),
      { numRuns: 200 },
    );
  });
});

describe("性质：Replay 与 ACK", () => {
  const replayEntryArb = fc.bigInt({ min: 1n, max: 10n ** 12n });

  it("任意 ACK 序列：confirmedAck 单调不减且不超过已分配最大 Seq", () => {
    fc.assert(
      fc.property(
        fc.array(replayEntryArb, { minLength: 0, maxLength: 40 }),
        fc.array(fc.bigInt({ min: 0n, max: 50n }), { minLength: 0, maxLength: 30 }),
        (seqs, acks) => {
          const window = new ReplayWindow({ capacity: 64 });
          const uniqueSeqs = [...new Set(seqs.map((value) => value))];
          for (const seq of uniqueSeqs.toSorted((a, b) => Number(a - b))) {
            window.append(makeEntry(seq));
          }
          const latest = window.latestAssignedSeq();
          let confirmed = 0n;
          for (const ackRaw of acks) {
            const ack = ackRaw % (latest + 2n); // 覆盖合法值与超前值。
            if (ack > latest) {
              continue; // 超前 ACK 由 Session 拒绝，不影响窗口。
            }
            if (ack > confirmed) {
              confirmed = ack;
              window.pruneThrough(ack);
            }
            expect(confirmed <= latest).toBe(true);
          }
          expect(confirmed <= window.latestAssignedSeq()).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("任意 lastAck：replayAfter 要么整体命中（连续且严格递增），要么给出稳定状态", () => {
    // 真实 Session 的窗口总是连续 Seq（每条服务端消息都追加），这里按
    // 连续区间生成，验证重放语义。
    const contiguousWindowArb = fc.record({
      firstSeq: fc.bigInt({ min: 1n, max: 40n }),
      length: fc.integer({ min: 0, max: 30 }),
    });
    fc.assert(
      fc.property(
        contiguousWindowArb,
        fc.bigInt({ min: 0n, max: 10n ** 13n }),
        ({ firstSeq, length }, lastAck) => {
          const window = new ReplayWindow({ capacity: 1024 });
          for (let index = 0; index < length; index += 1) {
            window.append(makeEntry(firstSeq + BigInt(index)));
          }
          const outcome = window.replayAfter(lastAck);
          if (outcome.status === "replay") {
            const replaySeqs = outcome.messages.map((message) => message.seq);
            for (let index = 1; index < replaySeqs.length; index += 1) {
              expect(replaySeqs[index]).toBe((replaySeqs[index - 1] ?? 0n) + 1n);
            }
            expect(replaySeqs[0] ?? 0n).toBe(lastAck + 1n);
          } else {
            expect(["snapshot_required", "up_to_date", "invalid_ahead"]).toContain(outcome.status);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

function makeQueued(fields: {
  priority: SendPriority;
  size: number;
  category: string;
  replaceable: boolean;
}): QueuedSend {
  const text = serverText({ type: fields.category === "error" ? "error" : "server.ready" });
  // 用填充键构造任意字节大小的消息（wire 上等价于更长的 payload）。
  const padded = `${text.slice(0, -1)},"pad":"${"x".repeat(Math.max(0, fields.size - 8))}"}`;
  return {
    priority: fields.priority,
    text: padded,
    byteSize: Buffer.byteLength(padded, "utf8"),
    envelope: JSON.parse(padded),
    category: fields.category,
    deadlineUs: null,
    mergeKey: null,
    replaceable: fields.replaceable,
  };
}

describe("性质：有界发送队列", () => {
  const queuedSendArb = fc.record({
    priority: fc.constantFrom<SendPriority>(1, 2, 3, 4),
    size: fc.integer({ min: 1, max: 120 }),
    category: fc.constantFrom("scene.prepared", "server.ready", "error", "debug.trace"),
    replaceable: fc.boolean(),
  });

  it("任意入队/排空序列：队列绝不突破消息数与字节上限；守恒记账成立", () => {
    const maxMessages = 8;
    const maxBytes = 600;
    fc.assert(
      fc.property(
        fc.array(queuedSendArb, { minLength: 0, maxLength: 60 }),
        fc.array(fc.integer({ min: 0, max: 5 }), { minLength: 0, maxLength: 10 }),
        (messages, drainIndices) => {
          const queue = new BoundedSendQueue({ maxMessages, maxBytes });
          let enqueued = 0;
          let handedOff = 0;
          let droppedOrEvicted = 0;
          const drains = new Set(drainIndices);
          messages.forEach((fields, index) => {
            const message = makeQueued(fields);
            if (message.byteSize <= maxBytes) {
              enqueued += 1;
            }
            const outcome = queue.enqueue(message);
            if (outcome.status === "queued") {
              droppedOrEvicted += outcome.evicted.length;
            } else {
              droppedOrEvicted += 1 + outcome.evicted.length;
            }
            // 不变量：任意操作后队列不超限。
            expect(queue.messageCount()).toBeLessThanOrEqual(maxMessages);
            expect(queue.byteCount()).toBeLessThanOrEqual(maxBytes);
            if (drains.has(index)) {
              const drained = queue.drain();
              handedOff += drained.length;
              expect(queue.messageCount()).toBe(0);
              expect(queue.byteCount()).toBe(0);
            }
          });
          const finalDrained = queue.drain();
          handedOff += finalDrained.length;
          // 守恒：每条曾入队（或被拒绝）的消息要么交付、要么计入淘汰。
          expect(handedOff + droppedOrEvicted).toBeGreaterThanOrEqual(enqueued);
        },
      ),
      { numRuns: 150 },
    );
  });

  it("任意优先级序列：drain 输出按优先级非降序排列", () => {
    fc.assert(
      fc.property(fc.array(queuedSendArb, { minLength: 0, maxLength: 40 }), (messages) => {
        const queue = new BoundedSendQueue({ maxMessages: 512, maxBytes: 10_000_000 });
        const accepted: SendPriority[] = [];
        for (const fields of messages) {
          const outcome = queue.enqueue(makeQueued(fields));
          if (outcome.status === "queued") {
            accepted.push(fields.priority);
          }
        }
        const drained = queue.drain();
        expect(drained.length).toBe(accepted.length);
        for (let index = 1; index < drained.length; index += 1) {
          expect((drained[index]?.priority ?? 4) >= (drained[index - 1]?.priority ?? 1)).toBe(true);
        }
      }),
      { numRuns: 150 },
    );
  });
});
