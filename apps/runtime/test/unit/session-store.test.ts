import { describe, expect, it } from "vitest";
import type { ControlLogicalState } from "@bellis/transport";
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

interface ScheduledEntry {
  fireAtMs: number;
  onFire: () => void;
  cancelled: boolean;
}

/** 手动调度器：与生产 unref setTimeout 同语义（按延迟触发、可取消）。 */
class ManualScheduler {
  #now: number;
  readonly #entries: ScheduledEntry[] = [];

  constructor(startMs = 1_000) {
    this.#now = startMs;
  }

  readonly nowMs = (): number => this.#now;

  readonly scheduleTimer = (delayMs: number, onFire: () => void): (() => void) => {
    const entry: ScheduledEntry = {
      fireAtMs: this.#now + Math.max(0, delayMs),
      onFire,
      cancelled: false,
    };
    this.#entries.push(entry);
    return () => {
      entry.cancelled = true;
    };
  };

  get pendingCount(): number {
    return this.#entries.filter((entry) => !entry.cancelled).length;
  }

  /** 推进时钟：按到期顺序逐个触发（触发回调可再注册新调度）。 */
  advanceTo(targetMs: number): void {
    for (;;) {
      let next: ScheduledEntry | undefined;
      for (const entry of this.#entries) {
        if (entry.cancelled || entry.fireAtMs > targetMs) {
          continue;
        }
        if (next === undefined || entry.fireAtMs < next.fireAtMs) {
          next = entry;
        }
      }
      if (next === undefined) {
        this.#now = Math.max(this.#now, targetMs);
        return;
      }
      this.#now = next.fireAtMs;
      next.cancelled = true;
      next.onFire();
    }
  }
}

const REGISTRY_DEFAULTS = { maxOpenStreams: 8, maxTotalStreams: 16, maxFramesPerStream: 64 };

function buildStore(options?: {
  ttlMs?: number;
  maxSessions?: number;
  nowMs?: () => number;
  scheduleTimer?: (delayMs: number, onFire: () => void) => () => void;
}): SessionStore {
  // 测试时间基线固定（默认 nowMs 为真实 Date.now，会把小时间戳判为过期）；
  // 调度默认走手动队列（不在测试进程留下真实 OS 定时器）。
  let now = 1_000;
  const fallbackScheduler = new ManualScheduler();
  return new SessionStore(REGISTRY_DEFAULTS, {
    ttlMs: options?.ttlMs ?? 3_600_000,
    maxSessions: options?.maxSessions ?? 1024,
    nowMs: options?.nowMs ?? (() => now),
    scheduleTimer: options?.scheduleTimer ?? fallbackScheduler.scheduleTimer,
  });
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

describe("TTL 最近到期调度器（三轮评审修复 2）", () => {
  it("已建立连接的 Session 无任何 Store 查询时按 TTL 主动关闭", () => {
    const scheduler = new ManualScheduler();
    const store = buildStore({
      ttlMs: 5_000,
      nowMs: scheduler.nowMs,
      scheduleTimer: scheduler.scheduleTimer,
    });
    const session = store.create("cookie-a", "11111111-1111-4111-8111-111111111111", 1_000);
    const control = new FakeControlConnection();
    const media = new FakeMediaConnection();
    session.control = control;
    session.mediaConnections.add(media);

    // 全程不触发 create/resolve——纯靠调度器到点主动回收（强关连接+撤销 Cookie）。
    scheduler.advanceTo(6_000);
    expect(control.forceClosed).toBe(1);
    expect(media.forceClosed).toEqual(["session_expired"]);
    expect(store.size).toBe(0);
    expect(store.resolveByCookie("cookie-a")).toBeNull();
  });

  it("调度点取最近到期：先到期先回收，随后自动重排到下一个", () => {
    const scheduler = new ManualScheduler();
    const store = buildStore({
      ttlMs: 5_000,
      nowMs: scheduler.nowMs,
      scheduleTimer: scheduler.scheduleTimer,
    });
    // A createdAt=3_000（到期 8_000）后创建，但 B createdAt=2_000（到期 7_000）
    // 更早到期：调度点必须选 B（createdAtMs 由调用方给定，与插入顺序无关）。
    const late = store.create("cookie-late", "11111111-1111-4111-8111-111111111111", 3_000);
    store.create("cookie-early", "22222222-2222-4222-8222-222222222222", 2_000);

    scheduler.advanceTo(7_000);
    expect(store.resolveById("22222222-2222-4222-8222-222222222222")).toBeNull();
    expect(store.resolveById("11111111-1111-4111-8111-111111111111")).toBe(late);

    // 回收后重排：剩余 Session 到点同样被主动回收。
    scheduler.advanceTo(8_000);
    expect(store.size).toBe(0);
  });

  it("close() 取消调度：跨过 TTL 不再移除、不再强关，无残留调度", () => {
    const scheduler = new ManualScheduler();
    const store = buildStore({
      ttlMs: 5_000,
      nowMs: scheduler.nowMs,
      scheduleTimer: scheduler.scheduleTimer,
    });
    const session = store.create("cookie-a", "11111111-1111-4111-8111-111111111111", 1_000);
    const control = new FakeControlConnection();
    session.control = control;
    expect(scheduler.pendingCount).toBe(1);

    store.close();
    expect(scheduler.pendingCount).toBe(0);
    scheduler.advanceTo(10_000);
    expect(store.size).toBe(1);
    expect(control.forceClosed).toBe(0);
  });
});

describe("导出状态事务式消费（三轮评审修复 1）", () => {
  const STATE: ControlLogicalState = { nextSeq: 4n, confirmedAck: 3n, replay: [] };

  function buildSession(): LogicalSession {
    return new LogicalSession("11111111-1111-4111-8111-111111111111", 1_000, REGISTRY_DEFAULTS);
  }

  it("commit 永久消费：后续 claim 拿不到状态", async () => {
    const session = buildSession();
    session.exportedControlState = STATE;
    const claim = await session.claimExportedControlState();
    expect(claim.state).toBe(STATE);
    claim.commit();
    const second = await session.claimExportedControlState();
    expect(second.state).toBeNull();
  });

  it("rollback 原样归还：后续重连仍能获得同一状态", async () => {
    const session = buildSession();
    session.exportedControlState = STATE;
    const claim = await session.claimExportedControlState();
    claim.rollback();
    expect(session.exportedControlState).toBe(STATE);
    const second = await session.claimExportedControlState();
    expect(second.state).toBe(STATE);
  });

  it("并发 claim 至多一个获得状态：等待者在 rollback 后获得归还状态", async () => {
    const session = buildSession();
    session.exportedControlState = STATE;
    const firstPromise = session.claimExportedControlState();
    const secondPromise = session.claimExportedControlState();
    const first = await firstPromise;
    expect(first.state).toBe(STATE);

    // 第二个 claim 在第一个 settle 前必须等待（并发初始化不重复消费）。
    let secondDone = false;
    void secondPromise.then(() => {
      secondDone = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(secondDone).toBe(false);

    first.rollback();
    const second = await secondPromise;
    expect(second.state).toBe(STATE);
  });

  it("并发 claim：commit 后等待者拿到 null（不重复消费）", async () => {
    const session = buildSession();
    session.exportedControlState = STATE;
    const first = await session.claimExportedControlState();
    const secondPromise = session.claimExportedControlState();
    first.commit();
    const second = await secondPromise;
    expect(second.state).toBeNull();
  });

  it("无导出状态时不设独占点：并发 claim 均立即拿到 null", async () => {
    const session = buildSession();
    const [a, b] = await Promise.all([
      session.claimExportedControlState(),
      session.claimExportedControlState(),
    ]);
    expect(a.state).toBeNull();
    expect(b.state).toBeNull();
  });

  it("重复 settle 幂等：commit 后 rollback 不归还", async () => {
    const session = buildSession();
    session.exportedControlState = STATE;
    const claim = await session.claimExportedControlState();
    claim.commit();
    claim.rollback();
    expect(session.exportedControlState).toBeNull();
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
