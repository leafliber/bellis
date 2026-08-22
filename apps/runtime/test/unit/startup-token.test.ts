import { describe, expect, it } from "vitest";
import { StartupTokenService } from "../../src/index.js";

describe("StartupTokenService", () => {
  it("签发的 Token 至少 256-bit 随机且可成功交换一次", () => {
    const tokens = new StartupTokenService({ ttlMs: 60_000 });
    const issued = tokens.issue();
    expect(issued.token.length).toBeGreaterThanOrEqual(43);
    expect(tokens.exchange(issued.token)).toEqual({ ok: true });
  });

  it("同一 Token 第二次交换失败", () => {
    const tokens = new StartupTokenService({ ttlMs: 60_000 });
    const issued = tokens.issue();
    expect(tokens.exchange(issued.token).ok).toBe(true);
    expect(tokens.exchange(issued.token).ok).toBe(false);
  });

  it("过期 Token 失败（可注入时钟）", () => {
    let now = 1_000;
    const tokens = new StartupTokenService({ ttlMs: 1_000, nowMs: () => now });
    const issued = tokens.issue();
    now += 1_001;
    expect(tokens.exchange(issued.token).ok).toBe(false);
  });

  it("未知、非法类型输入统一失败", () => {
    const tokens = new StartupTokenService();
    expect(tokens.exchange(undefined).ok).toBe(false);
    expect(tokens.exchange(1234).ok).toBe(false);
    expect(tokens.exchange("").ok).toBe(false);
    expect(tokens.exchange("not-a-real-token").ok).toBe(false);
  });

  it("并发交换同一 Token 只有一个成功", async () => {
    const tokens = new StartupTokenService();
    const issued = tokens.issue();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => Promise.resolve(tokens.exchange(issued.token))),
    );
    expect(results.filter((result) => result.ok).length).toBe(1);
  });

  it("签发互不相同", () => {
    const tokens = new StartupTokenService();
    const first = tokens.issue().token;
    const second = tokens.issue().token;
    expect(first).not.toBe(second);
  });
});
