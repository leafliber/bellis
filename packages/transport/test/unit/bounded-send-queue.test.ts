import { describe, expect, it } from "vitest";
import { BoundedSendQueue } from "../../src/index.js";
import type { QueuedSend } from "../../src/index.js";
import { MESSAGE_ID, SESSION_ID, serverText } from "../helpers.js";

let counter = 0;
function message(
  overrides: Partial<QueuedSend> & { priority: QueuedSend["priority"]; type?: string },
): QueuedSend {
  counter += 1;
  const type = overrides.type ?? "server.ready";
  const text = serverText(
    { type, messageId: `${MESSAGE_ID.slice(0, 13)}${counter.toString().padStart(4, "0")}` },
    { seq: counter.toString() },
  );
  return {
    priority: overrides.priority,
    text,
    byteSize: overrides.byteSize ?? Buffer.byteLength(text, "utf8"),
    envelope: JSON.parse(text),
    category: overrides.category ?? type,
    deadlineUs: overrides.deadlineUs ?? null,
    mergeKey: overrides.mergeKey ?? null,
    replaceable: overrides.replaceable ?? false,
  };
}

describe("BoundedSendQueue", () => {
  it("drain 按优先级升序、同优先级 FIFO", () => {
    const queue = new BoundedSendQueue();
    const bulk1 = message({ priority: 3, type: "scene.prepared" });
    const critical = message({ priority: 1, type: "error" });
    const control = message({ priority: 2, type: "server.ready" });
    const bulk2 = message({ priority: 3, type: "scene.prepared" });
    for (const item of [bulk1, critical, control, bulk2]) {
      expect(queue.enqueue(item).status).toBe("queued");
    }
    const drained = queue.drain();
    expect(drained.map((item) => item.envelope.messageId)).toEqual([
      critical.envelope.messageId,
      control.envelope.messageId,
      bulk1.envelope.messageId,
      bulk2.envelope.messageId,
    ]);
    expect(queue.messageCount()).toBe(0);
    expect(queue.byteCount()).toBe(0);
  });

  it("消息数达到上限：先淘汰最低优先级中最旧的条目", () => {
    const queue = new BoundedSendQueue({ maxMessages: 2, maxBytes: 1_000_000 });
    const bulk1 = message({ priority: 3, type: "scene.prepared" });
    const bulk2 = message({ priority: 3, type: "scene.prepared" });
    queue.enqueue(bulk1);
    queue.enqueue(bulk2);
    const control = message({ priority: 2, type: "server.ready" });
    const outcome = queue.enqueue(control);
    expect(outcome.status).toBe("queued");
    if (outcome.status === "queued") {
      expect(outcome.evicted).toEqual([bulk1]);
    }
    const drained = queue.drain();
    // drain 按优先级升序：P2(control) 在 P3(bulk2) 之前。
    expect(drained).toEqual([control, bulk2]);
  });

  it("字节上限生效：高优先级入队时淘汰足够的低优先级字节", () => {
    const bigBulk = message({ priority: 3, type: "scene.prepared", byteSize: 600 });
    const bigCritical = message({ priority: 1, type: "error", byteSize: 600 });
    const queue = new BoundedSendQueue({ maxMessages: 10, maxBytes: 1000 });
    queue.enqueue(bigBulk);
    const outcome = queue.enqueue(bigCritical);
    expect(outcome.status).toBe("queued");
    expect(queue.byteCount()).toBe(600);
  });

  it("低优先级消息在容量不足时被丢弃（dropped）", () => {
    const queue = new BoundedSendQueue({ maxMessages: 1, maxBytes: 1_000_000 });
    queue.enqueue(message({ priority: 3, type: "scene.prepared" }));
    const outcome = queue.enqueue(message({ priority: 3, type: "scene.prepared" }));
    expect(outcome.status).toBe("dropped");
  });

  it("高优先级消息无法入队 → close_slow_consumer（不静默丢失）", () => {
    const queue = new BoundedSendQueue({ maxMessages: 1, maxBytes: 1_000_000 });
    const existing = message({ priority: 1, type: "error" });
    queue.enqueue(existing);
    const outcome = queue.enqueue(message({ priority: 1, type: "error" }));
    expect(outcome.status).toBe("close_slow_consumer");
    // 原有条目不被淘汰（优先级 1 永不淘汰）。
    expect(queue.drain()).toEqual([existing]);
  });

  it("单条消息超过总字节上限：立即拒绝且不淘汰既有条目", () => {
    const queue = new BoundedSendQueue({ maxMessages: 10, maxBytes: 1000 });
    const small = message({ priority: 3, type: "scene.prepared", byteSize: 100 });
    queue.enqueue(small);
    const huge = message({ priority: 1, type: "error", byteSize: 2000 });
    const outcome = queue.enqueue(huge);
    expect(outcome.status).toBe("close_slow_consumer");
    expect(queue.drain()).toEqual([small]);
  });

  it("mergeKey 替换同 Key 旧条目（可替代低优先级）", () => {
    const queue = new BoundedSendQueue();
    const first = message({
      priority: 3,
      type: "scene.prepared",
      mergeKey: "world-delta",
      replaceable: true,
    });
    queue.enqueue(first);
    const second = message({
      priority: 3,
      type: "scene.prepared",
      mergeKey: "world-delta",
      replaceable: true,
    });
    const outcome = queue.enqueue(second);
    expect(outcome.status).toBe("queued");
    if (outcome.status === "queued") {
      expect(outcome.evicted).toEqual([first]);
    }
    expect(queue.drain()).toEqual([second]);
  });

  it("不可替代消息不受 mergeKey 影响", () => {
    const queue = new BoundedSendQueue();
    const first = message({ priority: 1, type: "error", mergeKey: "k", replaceable: false });
    queue.enqueue(first);
    const second = message({ priority: 1, type: "error", mergeKey: "k", replaceable: false });
    queue.enqueue(second);
    expect(queue.drain().length).toBe(2);
  });

  it("pruneExpired 只丢弃过期条目", () => {
    const queue = new BoundedSendQueue();
    const expired = message({ priority: 3, type: "scene.prepared", deadlineUs: 1000n });
    const alive = message({ priority: 3, type: "scene.prepared", deadlineUs: 5000n });
    queue.enqueue(expired);
    queue.enqueue(alive);
    const pruned = queue.pruneExpired(2000n);
    expect(pruned).toEqual([expired]);
    expect(queue.drain()).toEqual([alive]);
  });

  it("边界与淘汰顺序的确定性：P2 只能淘汰 P3/P4，不能淘汰其他 P2", () => {
    const queue = new BoundedSendQueue({ maxMessages: 2, maxBytes: 1_000_000 });
    const controlA = message({ priority: 2, type: "server.ready" });
    const bulkA = message({ priority: 3, type: "scene.prepared" });
    queue.enqueue(controlA);
    queue.enqueue(bulkA);
    const controlB = message({ priority: 2, type: "server.ready" });
    const outcome = queue.enqueue(controlB);
    expect(outcome.status).toBe("queued");
    expect(queue.drain().map((item) => item.envelope.messageId)).toEqual([
      controlA.envelope.messageId,
      controlB.envelope.messageId,
    ]);
  });

  it("非法配置抛出 RangeError", () => {
    expect(() => new BoundedSendQueue({ maxMessages: 0 })).toThrow(RangeError);
    expect(() => new BoundedSendQueue({ maxBytes: 0 })).toThrow(RangeError);
  });

  it("队列对象之间不共享可变状态", () => {
    const a = new BoundedSendQueue({ maxMessages: 1, maxBytes: 1_000_000 });
    const b = new BoundedSendQueue({ maxMessages: 1, maxBytes: 1_000_000 });
    a.enqueue(message({ priority: 1, type: "error" }));
    expect(b.messageCount()).toBe(0);
    expect(SESSION_ID).toBe(SESSION_ID);
  });
});
