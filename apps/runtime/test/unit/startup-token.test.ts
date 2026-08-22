import { describe, expect, it } from "vitest";
import { StartupTokenService } from "../../src/index.js";

describe("StartupTokenService", () => {
  it("签发的 Token 至少 256-bit 随机且可成功预留并消费一次", () => {
    const tokens = new StartupTokenService({ ttlMs: 60_000 });
    const issued = tokens.issue();
    expect(issued.token.length).toBeGreaterThanOrEqual(43);
    const reservation = tokens.reserve(issued.token);
    expect(reservation).not.toBeNull();
    reservation?.commit();
  });

  it("同一 Token commit 后不可再次预留", () => {
    const tokens = new StartupTokenService({ ttlMs: 60_000 });
    const issued = tokens.issue();
    tokens.reserve(issued.token)?.commit();
    expect(tokens.reserve(issued.token)).toBeNull();
  });

  it("预留期间并发预留失败（独占持有，二轮评审修复 5）", () => {
    const tokens = new StartupTokenService({ ttlMs: 60_000 });
    const issued = tokens.issue();
    const first = tokens.reserve(issued.token);
    expect(first).not.toBeNull();
    // 未 commit/release 前同 Token 的其它请求一律失败。
    expect(tokens.reserve(issued.token)).toBeNull();
    first?.release();
    // 释放后可再次预留。
    expect(tokens.reserve(issued.token)).not.toBeNull();
  });

  it("release 后同 Token 重试有效（可重试失败场景）", () => {
    const tokens = new StartupTokenService({ ttlMs: 60_000 });
    const issued = tokens.issue();
    tokens.reserve(issued.token)?.release();
    const second = tokens.reserve(issued.token);
    expect(second).not.toBeNull();
    second?.commit();
    expect(tokens.reserve(issued.token)).toBeNull();
  });

  it("release 已过期的预留直接作废（不放回可用集）", () => {
    let now = 1_000;
    const tokens = new StartupTokenService({ ttlMs: 1_000, nowMs: () => now });
    const issued = tokens.issue();
    const reservation = tokens.reserve(issued.token);
    expect(reservation).not.toBeNull();
    now += 2_000;
    reservation?.release();
    expect(tokens.reserve(issued.token)).toBeNull();
  });

  it("过期 Token 失败（可注入时钟）", () => {
    let now = 1_000;
    const tokens = new StartupTokenService({ ttlMs: 1_000, nowMs: () => now });
    const issued = tokens.issue();
    now += 1_001;
    expect(tokens.reserve(issued.token)).toBeNull();
  });

  it("未知、非法类型输入统一失败", () => {
    const tokens = new StartupTokenService();
    expect(tokens.reserve(undefined)).toBeNull();
    expect(tokens.reserve(1234)).toBeNull();
    expect(tokens.reserve("")).toBeNull();
    expect(tokens.reserve("not-a-real-token")).toBeNull();
  });

  it("重复 settle（commit 后 release）幂等无副作用", () => {
    const tokens = new StartupTokenService({ ttlMs: 60_000 });
    const issued = tokens.issue();
    const reservation = tokens.reserve(issued.token);
    reservation?.commit();
    // 重复 release 不得把已消费 Token 放回可用集。
    reservation?.release();
    expect(tokens.reserve(issued.token)).toBeNull();
  });

  it("内部记录不保存原始 Token 值（P4 修复 10）", () => {
    const tokens = new StartupTokenService();
    const issued = tokens.issue();
    expect(tokens.containsRawValue(issued.token)).toBe(false);
    // 消费成功后同样不保存原值。
    tokens.reserve(issued.token)?.commit();
    expect(tokens.containsRawValue(issued.token)).toBe(false);
  });

  it("签发互不相同", () => {
    const tokens = new StartupTokenService();
    const first = tokens.issue().token;
    const second = tokens.issue().token;
    expect(first).not.toBe(second);
  });

  it("同 Token 重试复用首次预留固定的持久化身份（三轮评审修复 3）", () => {
    const tokens = new StartupTokenService({ ttlMs: 60_000 });
    const issued = tokens.issue();
    const first = tokens.reserve(issued.token);
    expect(first).not.toBeNull();
    if (first === null) {
      return;
    }
    // 可重试失败：release 归还；同 Token 再次预留必须拿到相同身份。
    first.release();
    const second = tokens.reserve(issued.token);
    expect(second).not.toBeNull();
    if (second === null) {
      return;
    }
    expect(second.sessionIdentity.sessionId).toBe(first.sessionIdentity.sessionId);
    expect(second.sessionIdentity.createdAtMs).toBe(first.sessionIdentity.createdAtMs);
    // 身份为合法 UUID。
    expect(first.sessionIdentity.sessionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("不同 Token 的持久化身份互不相同", () => {
    const tokens = new StartupTokenService({ ttlMs: 60_000 });
    const first = tokens.reserve(tokens.issue().token);
    const second = tokens.reserve(tokens.issue().token);
    expect(first?.sessionIdentity.sessionId).not.toBe(second?.sessionIdentity.sessionId);
  });
});
