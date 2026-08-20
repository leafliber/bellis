import { describe, expect, it } from "vitest";
import { MessageDeduplicator } from "../../src/index.js";

describe("MessageDeduplicator", () => {
  it("首次出现返回 true，重复返回 false", () => {
    const dedup = new MessageDeduplicator();
    expect(dedup.add("a")).toBe(true);
    expect(dedup.add("a")).toBe(false);
    expect(dedup.add("b")).toBe(true);
    expect(dedup.size()).toBe(2);
  });

  it("容量满时 FIFO 淘汰最旧 messageId", () => {
    const dedup = new MessageDeduplicator({ capacity: 2 });
    dedup.add("a");
    dedup.add("b");
    expect(dedup.add("c")).toBe(true); // 淘汰 a
    expect(dedup.has("a")).toBe(false);
    expect(dedup.add("a")).toBe(true); // a 重新可见，淘汰 b
    expect(dedup.has("b")).toBe(false);
    expect(dedup.size()).toBe(2);
  });

  it("clear() 清空集合", () => {
    const dedup = new MessageDeduplicator();
    dedup.add("a");
    dedup.clear();
    expect(dedup.size()).toBe(0);
    expect(dedup.add("a")).toBe(true);
  });

  it("非法容量抛出 RangeError", () => {
    expect(() => new MessageDeduplicator({ capacity: 0 })).toThrow(RangeError);
  });
});
