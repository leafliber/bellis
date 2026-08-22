import { describe, expect, it } from "vitest";
import {
  LogicalSession,
  newSessionIdentity,
  SessionStore,
} from "../../src/websocket/session-store.js";

/** 记录 forceClose/beginDrain 调用的假连接。 */
class FakeControlConnection {
  drained: string[] = [];
  forceClosed = 0;
  beginDrain(reason: string): void {
    this.drained.push(reason);
  }
  forceClose(): void {
    this.forceClosed += 1;
  }
}

class FakeMediaConnection {
  forceClosed: string[] = [];
  forceClose(reason: string): void {
    this.forceClosed.push(reason);
  }
}

function buildStore(options?: {
  ttlMs?: number;
  maxSessions?: number;
  nowMs?: () => number;
}): SessionStore {
  // 测试时间基线固定（默认 nowMs 为真实 Date.now，会把小时间戳判为过期）。
  let now = 1_000;
  return new SessionStore(
    { maxOpenStreams: 8, maxTotalStreams: 16, maxFramesPerStream: 64 },
    {
      ttlMs: options?.ttlMs ?? 3_600_000,
      maxSessions: options?.maxSessions ?? 1024,
      nowMs: options?.nowMs ?? (() => now),
    },
  );
}

describe("SessionStore 同进程重复挂载（二轮评审修复 1）", () => {
  it("同 sessionId 二次 create 复用同一对象并原子轮换 Cookie", () => {
    const store = buildStore();
    const first = store.create("cookie-a", "11111111-1111-4111-8111-111111111111", 1_000);
    const second = store.create("cookie-b", "11111111-1111-4111-8111-111111111111", 2_000, {
      restorable: true,
    });
    expect(second).toBe(first);
    expect(store.size).toBe(1);
    // 旧 Cookie 立即失效，新 Cookie 解析到同一对象。
    expect(store.resolveByCookie("cookie-a")).toBeNull();
    expect(store.resolveByCookie("cookie-b")).toBe(first);
    expect(store.resolveById("11111111-1111-4111-8111-111111111111")).toBe(first);
  });

  it("轮换后旧 Cookie 不能建立 Control/Media 连接（双 Cookie 不并存）", () => {
    const store = buildStore();
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const session = store.create("cookie-a", sessionId, 1_000);
    const control = new FakeControlConnection();
    session.control = control;
    store.create("cookie-b", sessionId, 2_000, { restorable: true });
    expect(store.resolveByCookie("cookie-a")).toBeNull();
    expect(store.resolveByCookie("cookie-b")).toBe(session);
    // store 上只有一个对象：关闭回收遍历覆盖全部连接。
    session.control = null;
    const media = new FakeMediaConnection();
    session.mediaConnections.add(media);
    store.forceCloseAll("shutdown");
    expect(media.forceClosed).toEqual(["shutdown"]);
    expect(control.forceClosed).toBe(0);
  });

  it("不同 sessionId 各自独立，Cookie 不串扰", () => {
    const store = buildStore();
    const a = store.create("cookie-a", "11111111-1111-4111-8111-111111111111", 1_000);
    const b = store.create("cookie-b", "22222222-2222-4222-8222-222222222222", 1_001);
    expect(a).not.toBe(b);
    expect(store.resolveByCookie("cookie-a")).toBe(a);
    expect(store.resolveByCookie("cookie-b")).toBe(b);
    expect(store.size).toBe(2);
  });
});

describe("SessionStore 过期与容量（二轮评审修复 9）", () => {
  it("TTL 过期后 Cookie 解析失败且连接被强关回收", () => {
    let now = 1_000;
    const store = buildStore({ ttlMs: 5_000, nowMs: () => now });
    const session = store.create("cookie-a", "11111111-1111-4111-8111-111111111111", now);
    const control = new FakeControlConnection();
    const media = new FakeMediaConnection();
    session.control = control;
    session.mediaConnections.add(media);
    expect(store.resolveByCookie("cookie-a")).toBe(session);
    now += 5_000;
    expect(store.resolveByCookie("cookie-a")).toBeNull();
    expect(store.resolveById("11111111-1111-4111-8111-111111111111")).toBeNull();
    expect(store.size).toBe(0);
    expect(control.forceClosed).toBe(1);
    expect(media.forceClosed).toEqual(["session_expired"]);
  });

  it("TTL 未过期的 Session 不受影响", () => {
    let now = 1_000;
    const store = buildStore({ ttlMs: 5_000, nowMs: () => now });
    const session = store.create("cookie-a", "11111111-1111-4111-8111-111111111111", now);
    now += 4_999;
    expect(store.resolveByCookie("cookie-a")).toBe(session);
  });

  it("超出容量按创建时间淘汰最旧（含强关连接）", () => {
    const store = buildStore({ maxSessions: 2 });
    const oldest = store.create("cookie-old", "11111111-1111-4111-8111-111111111111", 1_000);
    const control = new FakeControlConnection();
    oldest.control = control;
    store.create("cookie-mid", "22222222-2222-4222-8222-222222222222", 2_000);
    store.create("cookie-new", "33333333-3333-4333-8333-333333333333", 3_000);
    expect(store.size).toBe(2);
    expect(store.resolveByCookie("cookie-old")).toBeNull();
    expect(store.resolveById("11111111-1111-4111-8111-111111111111")).toBeNull();
    expect(control.forceClosed).toBe(1);
    expect(store.resolveByCookie("cookie-mid")).not.toBeNull();
    expect(store.resolveByCookie("cookie-new")).not.toBeNull();
  });

  it("惰性回收：create 时清理已过期 Session", () => {
    let now = 1_000;
    const store = buildStore({ ttlMs: 1_000, nowMs: () => now });
    store.create("cookie-a", "11111111-1111-4111-8111-111111111111", now);
    now += 2_000;
    store.create("cookie-b", "22222222-2222-4222-8222-222222222222", now);
    expect(store.size).toBe(1);
    expect(store.resolveByCookie("cookie-a")).toBeNull();
  });
});

describe("newSessionIdentity / LogicalSession", () => {
  it("Session ID 与 Cookie 令牌随机且互不相同", () => {
    const first = newSessionIdentity();
    const second = newSessionIdentity();
    expect(first.sessionId).not.toBe(second.sessionId);
    expect(first.cookieToken).not.toBe(second.cookieToken);
    expect(first.cookieToken.length).toBeGreaterThanOrEqual(43);
  });

  it("Media Registry 重建产生全新配额", () => {
    const session = new LogicalSession(
      "11111111-1111-4111-8111-111111111111",
      1_000,
      { maxOpenStreams: 8, maxTotalStreams: 16, maxFramesPerStream: 64 },
      { restorable: true },
    );
    const before = session.mediaStreams;
    session.resetMediaRegistry();
    expect(session.mediaStreams).not.toBe(before);
    expect(session.restorable).toBe(true);
  });
});
