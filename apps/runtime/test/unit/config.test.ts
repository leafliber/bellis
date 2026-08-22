import { describe, expect, it } from "vitest";
import { normalizeHostHeader, parseRuntimeConfig, resolveAllowedOrigins } from "../../src/index.js";

describe("parseRuntimeConfig", () => {
  const validBase = {
    dataDirectory: "/tmp/bellis-data",
    runtimeVersion: "0.1.0",
  };

  it("应用全部默认值（host loopback、端口 17890、限额）", () => {
    const result = parseRuntimeConfig(validBase);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.config.host).toBe("127.0.0.1");
    expect(result.config.port).toBe(17_890);
    expect(result.config.allowedHosts).toEqual(["127.0.0.1", "localhost"]);
    expect(result.config.allowMissingOrigin).toBe(false);
    expect(result.config.startupTokenTtlMs).toBe(60_000);
    expect(result.config.sessionCookieName).toBe("bellis_session");
    expect(result.config.shutdownGraceMs).toBe(10_000);
    expect(result.config.limits.heartbeatIntervalMs).toBe(30_000);
    expect(result.config.limits.maxControlTextBytes).toBe(1_048_576);
    expect(result.config.limits.maxMediaPayloadBytes).toBe(1024 * 1024);
    expect(result.config.limits.sendQueue.maxMessages).toBe(512);
    expect(result.config.outbox.pollIntervalMs).toBe(100);
    expect(result.config.persistence.defaultDeadlineMs).toBe(10_000);
  });

  it("拒绝非 loopback Host", () => {
    const result = parseRuntimeConfig({ ...validBase, host: "0.0.0.0" });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.issues.some((issue) => issue.path === "host")).toBe(true);
  });

  it("拒绝相对数据目录与缺失 runtimeVersion", () => {
    const relative = parseRuntimeConfig({ ...validBase, dataDirectory: "bellis-data" });
    expect(relative.ok).toBe(false);
    const noVersion = parseRuntimeConfig({ dataDirectory: "/tmp/x" });
    expect(noVersion.ok).toBe(false);
  });

  it("拒绝非 loopback Origin 与非法端口", () => {
    const origin = parseRuntimeConfig({
      ...validBase,
      allowedOrigins: ["http://example.com"],
    });
    expect(origin.ok).toBe(false);
    const port = parseRuntimeConfig({ ...validBase, port: 70_000 });
    expect(port.ok).toBe(false);
  });

  it("允许 ::1 / localhost Host 与显式 loopback Origin", () => {
    const result = parseRuntimeConfig({
      ...validBase,
      host: "::1",
      allowedOrigins: ["http://localhost:17890"],
    });
    expect(result.ok).toBe(true);
  });

  it("跨字段约束：replayWindowCapacity 超过 sendQueue.maxMessages 在启动前拒绝（P4 修复 5）", () => {
    const invalid = parseRuntimeConfig({
      ...validBase,
      limits: {
        replayWindowCapacity: 513,
        sendQueue: { maxMessages: 512, maxBytes: 8 * 1024 * 1024 },
      },
    });
    expect(invalid.ok).toBe(false);
    if (invalid.ok) {
      return;
    }
    expect(invalid.issues.some((issue) => issue.path === "limits.replayWindowCapacity")).toBe(true);
    // 合法组合通过。
    const valid = parseRuntimeConfig({
      ...validBase,
      limits: {
        replayWindowCapacity: 512,
        sendQueue: { maxMessages: 512, maxBytes: 8 * 1024 * 1024 },
      },
    });
    expect(valid.ok).toBe(true);
  });

  it("非对象输入稳定失败", () => {
    for (const input of [null, undefined, 42, "config", []]) {
      expect(parseRuntimeConfig(input).ok).toBe(false);
    }
  });
});

describe("normalizeHostHeader", () => {
  it("剥离端口并保留合法 loopback 主机名", () => {
    expect(normalizeHostHeader("127.0.0.1:17890")).toBe("127.0.0.1");
    expect(normalizeHostHeader("localhost:8080")).toBe("localhost");
    expect(normalizeHostHeader("[::1]:17890")).toBe("::1");
    expect(normalizeHostHeader("LOCALHOST")).toBe("localhost");
  });

  it("欺骗与非法值返回 null（含 IPv6 方括号后缀欺骗，P4 修复 6）", () => {
    expect(normalizeHostHeader("evil.example.com:80")).toBe("evil.example.com");
    expect(normalizeHostHeader("")).toBeNull();
    expect(normalizeHostHeader("[::1")).toBeNull();
    // 方括号后只允许空或 :纯数字端口。
    expect(normalizeHostHeader("[::1]evil")).toBeNull();
    expect(normalizeHostHeader("[::1]:17890evil")).toBeNull();
    expect(normalizeHostHeader("[::1]:17890x")).toBeNull();
    expect(normalizeHostHeader("[::1]:")).toBeNull();
    // 合法形式仍被归一。
    expect(normalizeHostHeader("[::1]:17890")).toBe("::1");
    expect(normalizeHostHeader("[::1]")).toBe("::1");
    // 裸 IPv6 带欺骗后缀整体作为主机名（不在允许列表内即被拒）。
    expect(normalizeHostHeader("::1:17890evil")).toBe("::1:17890evil");
  });
});

describe("resolveAllowedOrigins", () => {
  it("缺省时按 allowedHosts + 实际端口推导", () => {
    const parsed = parseRuntimeConfig({ dataDirectory: "/tmp/x", runtimeVersion: "0.1.0" });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(resolveAllowedOrigins(parsed.config, 19999)).toEqual([
      "http://127.0.0.1:19999",
      "http://localhost:19999",
    ]);
  });
});
