import { describe, expect, it } from "vitest";
import { BoundedSendQueue } from "../../src/index.js";
import type { QueuedSend } from "../../src/index.js";
import { SESSION_ID } from "../helpers.js";

/** 测试用暂存条目：在记账字段之外加一个 id 用于顺序断言。 */
interface TestSend extends QueuedSend {
  readonly id: string;
}

let counter = 0;
function message(
  overrides: Partial<TestSend> & { priority: QueuedSend["priority"]; type?: string },
): TestSend {
  counter += 1;
  const type = overrides.type ?? "server.ready";
  return {
    id: `m${counter.toString().padStart(3, "0")}`,
    priority: overrides.priority,
    byteSize: overrides.byteSize ?? 200,
    category: overrides.category ?? type,
    deadlineUs: overrides.deadlineUs ?? null,
    mergeKey: overrides.mergeKey ?? null,
    replaceable: overrides.replaceable ?? false,
  };
}

describe("BoundedSendQueue", () => {
  it("drain 按优先级升序、同优先级 FIFO", () => {
    const queue = new BoundedSendQueue<TestSend>();
    const bulk1 = message({ priority: 3, type: "scene.prepared" });
    const critical = message({ priority: 1, type: "error" });
    const control = message({ priority: 2, type: "server.ready" });
    const bulk2 = message({ priority: 3, type: "scene.prepared" });
    for (const item of [bulk1, critical, control, bulk2]) {
      expect(queue.enqueue(item).status).toBe("queued");
    }
    expect(queue.drain().map((item) => item.id)).toEqual([
      critical.id,
      control.id,
      bulk1.id,
      bulk2.id,
    ]);
    expect(queue.messageCount()).toBe(0);
    expect(queue.byteCount()).toBe(0);
  });

  it("消息数达到上限：先淘汰最低优先级中最旧的条目", () => {
    const queue = new BoundedSendQueue<TestSend>({ maxMessages: 2, maxBytes: 1_000_000 });
    const bulk1 = message({ priority: 3, type: "scene.prepared" });
    const bulk2 = message({ priority: 3, type: "scene.prepared" });
    queue.enqueue(bulk1);
    queue.enqueue(bulk2);
    const control = message({ priority: 2, type: "server.ready" });
    const outcome = queue.enqueue(control);
    expect(outcome.status).toBe("queued");
    if (outcome.status === "queued") {
      expect(outcome.evicted).toEqual([bulk1]);
      expect(outcome.merged).toEqual([]);
    }
    expect(queue.drain()).toEqual([control, bulk2]);
  });

  it("字节上限生效：高优先级入队时淘汰足够的低优先级字节", () => {
    const bigBulk = message({ priority: 3, type: "scene.prepared", byteSize: 600 });
    const bigCritical = message({ priority: 1, type: "error", byteSize: 600 });
    const queue = new BoundedSendQueue<TestSend>({ maxMessages: 10, maxBytes: 1000 });
    queue.enqueue(bigBulk);
    const outcome = queue.enqueue(bigCritical);
    expect(outcome.status).toBe("queued");
    expect(queue.byteCount()).toBe(600);
  });

  it("低优先级消息在容量不足时被丢弃（dropped）", () => {
    const queue = new BoundedSendQueue<TestSend>({ maxMessages: 1, maxBytes: 1_000_000 });
    queue.enqueue(message({ priority: 3, type: "scene.prepared" }));
    const outcome = queue.enqueue(message({ priority: 3, type: "scene.prepared" }));
    expect(outcome.status).toBe("dropped");
  });

  it("高优先级消息无法入队 → close_slow_consumer（不静默丢失）", () => {
    const queue = new BoundedSendQueue<TestSend>({ maxMessages: 1, maxBytes: 1_000_000 });
    const existing = message({ priority: 1, type: "error" });
    queue.enqueue(existing);
    const outcome = queue.enqueue(message({ priority: 1, type: "error" }));
    expect(outcome.status).toBe("close_slow_consumer");
    // 原有条目不被淘汰（优先级 1 永不淘汰）。
    expect(queue.drain()).toEqual([existing]);
  });

  it("单条消息超过总字节上限：立即拒绝且不淘汰既有条目", () => {
    const queue = new BoundedSendQueue<TestSend>({ maxMessages: 10, maxBytes: 1000 });
    const small = message({ priority: 3, type: "scene.prepared", byteSize: 100 });
    queue.enqueue(small);
    const huge = message({ priority: 1, type: "error", byteSize: 2000 });
    const outcome = queue.enqueue(huge);
    expect(outcome.status).toBe("close_slow_consumer");
    expect(queue.drain()).toEqual([small]);
  });

  it("mergeKey 替换同 Key 旧条目：成功路径按 merged 记账", () => {
    const queue = new BoundedSendQueue<TestSend>();
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
      expect(outcome.merged).toEqual([first]);
      expect(outcome.evicted).toEqual([]);
    }
    expect(queue.drain()).toEqual([second]);
  });

  it("替换消息超限：拒绝新条目且旧条目原样保留（不先删后拒）", () => {
    const queue = new BoundedSendQueue<TestSend>({ maxMessages: 4, maxBytes: 1000 });
    const first = message({
      priority: 3,
      type: "scene.prepared",
      mergeKey: "world-delta",
      replaceable: true,
      byteSize: 100,
    });
    expect(queue.enqueue(first).status).toBe("queued");
    const oversizedReplacement = message({
      priority: 3,
      type: "scene.prepared",
      mergeKey: "world-delta",
      replaceable: true,
      byteSize: 2000,
    });
    const outcome = queue.enqueue(oversizedReplacement);
    expect(outcome.status).toBe("dropped");
    expect(outcome.merged).toEqual([]);
    expect(outcome.evicted).toEqual([]);
    // 旧的有效消息仍在队列中，未被失败的替换删除。
    expect(queue.drain()).toEqual([first]);
  });

  it("替换按释放后的字节口径计算可行性（不误淘汰第三方条目）", () => {
    const queue = new BoundedSendQueue<TestSend>({ maxMessages: 4, maxBytes: 150 });
    const first = message({
      priority: 3,
      type: "scene.prepared",
      mergeKey: "world-delta",
      replaceable: true,
      byteSize: 100,
    });
    expect(queue.enqueue(first).status).toBe("queued");
    // 无替换口径时 120+100=220 > 150 放不下；替换口径 120 ≤ 150 放得下。
    const second = message({
      priority: 3,
      type: "scene.prepared",
      mergeKey: "world-delta",
      replaceable: true,
      byteSize: 120,
    });
    const outcome = queue.enqueue(second);
    expect(outcome.status).toBe("queued");
    expect(outcome.merged).toEqual([first]);
    expect(outcome.evicted).toEqual([]);
    expect(queue.byteCount()).toBe(120);
  });

  it("消息数上限下替换自身：替换不额外占用条目数", () => {
    const queue = new BoundedSendQueue<TestSend>({ maxMessages: 1, maxBytes: 1_000_000 });
    const first = message({
      priority: 3,
      type: "scene.prepared",
      mergeKey: "k",
      replaceable: true,
    });
    queue.enqueue(first);
    const second = message({
      priority: 3,
      type: "scene.prepared",
      mergeKey: "k",
      replaceable: true,
    });
    const outcome = queue.enqueue(second);
    expect(outcome.status).toBe("queued");
    expect(queue.drain()).toEqual([second]);
  });

  it("不可替代消息不受 mergeKey 影响", () => {
    const queue = new BoundedSendQueue<TestSend>();
    const first = message({ priority: 1, type: "error", mergeKey: "k", replaceable: false });
    queue.enqueue(first);
    const second = message({ priority: 1, type: "error", mergeKey: "k", replaceable: false });
    queue.enqueue(second);
    expect(queue.drain().length).toBe(2);
  });

  it("pruneExpired 只丢弃过期条目", () => {
    const queue = new BoundedSendQueue<TestSend>();
    const expired = message({ priority: 3, type: "scene.prepared", deadlineUs: 1000n });
    const alive = message({ priority: 3, type: "scene.prepared", deadlineUs: 5000n });
    queue.enqueue(expired);
    queue.enqueue(alive);
    const pruned = queue.pruneExpired(2000n);
    expect(pruned).toEqual([expired]);
    expect(queue.drain()).toEqual([alive]);
  });

  it("snapshot 按 drain 顺序返回但不清空队列", () => {
    const queue = new BoundedSendQueue<TestSend>();
    const bulk = message({ priority: 3, type: "scene.prepared" });
    const critical = message({ priority: 1, type: "error" });
    queue.enqueue(bulk);
    queue.enqueue(critical);
    expect(queue.snapshot().map((item) => item.id)).toEqual([critical.id, bulk.id]);
    expect(queue.messageCount()).toBe(2);
    expect(queue.drain().length).toBe(2);
  });

  it("边界与淘汰顺序的确定性：P2 只能淘汰 P3/P4，不能淘汰其他 P2", () => {
    const queue = new BoundedSendQueue<TestSend>({ maxMessages: 2, maxBytes: 1_000_000 });
    const controlA = message({ priority: 2, type: "server.ready" });
    const bulkA = message({ priority: 3, type: "scene.prepared" });
    queue.enqueue(controlA);
    queue.enqueue(bulkA);
    const controlB = message({ priority: 2, type: "server.ready" });
    const outcome = queue.enqueue(controlB);
    expect(outcome.status).toBe("queued");
    expect(queue.drain().map((item) => item.id)).toEqual([controlA.id, controlB.id]);
  });

  it("非法配置抛出 RangeError", () => {
    expect(() => new BoundedSendQueue({ maxMessages: 0 })).toThrow(RangeError);
    expect(() => new BoundedSendQueue({ maxBytes: 0 })).toThrow(RangeError);
  });

  it("队列对象之间不共享可变状态", () => {
    const a = new BoundedSendQueue<TestSend>({ maxMessages: 1, maxBytes: 1_000_000 });
    const b = new BoundedSendQueue<TestSend>({ maxMessages: 1, maxBytes: 1_000_000 });
    a.enqueue(message({ priority: 1, type: "error" }));
    expect(b.messageCount()).toBe(0);
    expect(SESSION_ID).toBe(SESSION_ID);
  });
});
