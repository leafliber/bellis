import { request as httpRequest } from "node:http";
import { afterAll, describe, expect, it } from "vitest";
import { PersistenceError } from "@bellis/persistence";
import type { PersistenceClient } from "@bellis/persistence";
import type { RuntimeHandle } from "../../src/index.js";
import {
  cleanupTempDataDirectory,
  createMigratedBaseClient,
  createTempDataDirectory,
  exchangeToken,
  originFor,
  startTestRuntime,
  wrapPersistenceClient,
} from "../helpers.js";
import { ControlWsClient } from "../ws-client.js";
import { buildMediaFrame, clientEnvelope, mediaSocket } from "../ws-client.js";

/**
 * Session/认证边界回归（P4 二轮评审修复 1/5/8/9/11）：
 * - 同进程 resumeSessionId 只轮换 Cookie，不产生第二个逻辑 Session；
 * - Startup Token 原子 reserve/commit/release（可重试失败同 Token 重试）；
 * - Host 头端口非法值（localhost:evil / 127.0.0.1: / [::1]:65536）拒绝；
 * - Session TTL 过期与容量淘汰真实生效；
 * - OpenAPI 与 Auth 实际边界一致（Header-only、可选 Body、状态码）。
 */

const directories: string[] = [];
const baseClients: PersistenceClient[] = [];

function tempDirectory(prefix: string): string {
  const directory = createTempDataDirectory(prefix);
  directories.push(directory);
  return directory;
}

afterAll(async () => {
  for (const client of baseClients.splice(0)) {
    await client.close().catch(() => undefined);
  }
  for (const directory of directories.splice(0)) {
    cleanupTempDataDirectory(directory);
  }
});

/** 原始 HTTP 请求（fetch 会忽略 Host 覆盖，欺骗测试必须用 node:http）。 */
function rawRequest(
  port: number,
  headers: Record<string, string>,
  path = "/api/v1/health/live",
): Promise<{ kind: "status"; status: number } | { kind: "reset" }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port, path, headers }, (response) => {
      response.resume();
      response.on("end", () => resolve({ kind: "status", status: response.statusCode ?? 0 }));
    });
    request.on("error", (error: Error) => {
      if (error.message.includes("socket hang up") || error.message.includes("ECONNRESET")) {
        resolve({ kind: "reset" });
        return;
      }
      reject(error);
    });
    request.end();
  });
}

describe("同进程 resumeSessionId 重复挂载（二轮评审修复 1）", () => {
  it("同一 ID 二次挂载轮换 Cookie：旧 Cookie 拒绝、新 Cookie 复用同一逻辑 Session", async () => {
    const handle = await startTestRuntime({ dataDirectory: tempDirectory("bellis-p4-rr1-") });
    try {
      const token1 = handle.issueStartupToken().token;
      const first = await mustExchangeOk(handle, token1);
      const token2 = handle.issueStartupToken().token;
      const second = await exchangeToken(handle, token2, { resumeSessionId: first.sessionId });
      expect(second.status).toBe(200);
      expect(second.sessionId).toBe(first.sessionId);

      // 旧 Cookie 不能建立 Control 连接（双 Cookie 不并存）。
      const stale = new ControlWsClient({
        port: handle.status.port,
        path: "/ws/v1/control",
        cookie: first.cookie,
        origin: originFor(handle),
      });
      await stale.opened();
      expect(await stale.closed()).toBe(1008);

      // 新 Cookie 正常工作（同一逻辑 Session 的 Seq 连续）。
      const active = new ControlWsClient({
        port: handle.status.port,
        path: "/ws/v1/control",
        cookie: second.cookie ?? "",
        origin: originFor(handle),
      });
      await active.opened();
      active.send(
        clientEnvelope({
          sessionId: first.sessionId,
          type: "client.hello",
          payload: { protocolVersion: 1, clientType: "test-client" },
        }),
      );
      await active.waitForType("server.ready");
      active.send(
        clientEnvelope({ sessionId: first.sessionId, type: "clock.ping", payload: { c0: "1" } }),
      );
      const pong = await active.waitForType("clock.pong");
      expect(Number(pong.seq)).toBeGreaterThanOrEqual(3);
      active.close();

      // 优雅关闭回收该唯一逻辑 Session（无第二个对象残留）。
      await handle.close();
      expect(handle.status.phase).toBe("closed");
    } finally {
      if (handle.status.phase !== "closed") {
        await handle.close().catch(() => undefined);
      }
    }
  });
});

async function mustExchangeOk(
  handle: RuntimeHandle,
  token: string,
): Promise<{ sessionId: string; cookie: string }> {
  const result = await exchangeToken(handle, token);
  if (result.status !== 200 || result.sessionId === null || result.cookie === null) {
    throw new Error(`exchange failed: ${result.status} ${JSON.stringify(result.body)}`);
  }
  return { sessionId: result.sessionId, cookie: result.cookie };
}

describe("Startup Token 原子消费（二轮评审修复 5）", () => {
  it("可重试持久化失败释放预留：同 Token 重试成功", async () => {
    const directory = tempDirectory("bellis-p4-tokenretry-");
    const base = await createMigratedBaseClient(directory);
    baseClients.push(base);
    let failOnce = true;
    const handle = await startTestRuntime({
      dataDirectory: directory,
      persistenceClient: wrapPersistenceClient(base, {
        ensureSession: (input) =>
          failOnce
            ? Promise.reject(new PersistenceError("database_busy", "injected busy"))
            : base.ensureSession(input),
      }),
    });
    try {
      const token = handle.issueStartupToken().token;
      const first = await exchangeToken(handle, token);
      expect(first.status).toBe(503);
      expect((first.body as { retryable: boolean }).retryable).toBe(true);
      // 同 Token 重试：预留已释放，第二次成功。
      failOnce = false;
      const second = await exchangeToken(handle, token);
      expect(second.status).toBe(200);
      // 成功后永久消费。
      const third = await exchangeToken(handle, token);
      expect(third.status).toBe(401);
    } finally {
      await handle.close();
    }
  });

  it("并发交换同一 Token 只有一个成功（独占预留）", async () => {
    const handle = await startTestRuntime({ dataDirectory: tempDirectory("bellis-p4-tokenrace-") });
    try {
      const token = handle.issueStartupToken().token;
      const results = await Promise.all(
        Array.from({ length: 6 }, () => exchangeToken(handle, token)),
      );
      expect(results.filter((result) => result.status === 200).length).toBe(1);
      expect(results.filter((result) => result.status === 401).length).toBe(5);
    } finally {
      await handle.close();
    }
  });

  it("resume 目标不存在：401 且 Token 已消费（不被探测重放）；瞬态错误释放并可重试", async () => {
    const directory = tempDirectory("bellis-p4-tokenresume-");
    const base = await createMigratedBaseClient(directory);
    baseClients.push(base);
    let readFails = false;
    const handle = await startTestRuntime({
      dataDirectory: directory,
      persistenceClient: wrapPersistenceClient(base, {
        readRecoveryState: (sessionId: string) =>
          readFails
            ? Promise.reject(new PersistenceError("unavailable", "injected unavailable"))
            : base.readRecoveryState(sessionId),
      }),
    });
    try {
      const unknown = handle.issueStartupToken().token;
      const missing = await exchangeToken(handle, unknown, {
        resumeSessionId: "99999999-9999-4999-8999-999999999999",
      });
      expect(missing.status).toBe(401);
      // 客户端错误：Token 已消费，不可探测重放。
      const missingRetry = await exchangeToken(handle, unknown, {
        resumeSessionId: "99999999-9999-4999-8999-999999999999",
      });
      expect(missingRetry.status).toBe(401);

      // 持久化瞬态错误：503 可重试 + Token 释放——同 Token 重试真实成功。
      const existing = await mustExchangeOk(handle, handle.issueStartupToken().token);
      const transient = handle.issueStartupToken().token;
      readFails = true;
      const busy = await exchangeToken(handle, transient, {
        resumeSessionId: existing.sessionId,
      });
      expect(busy.status).toBe(503);
      expect((busy.body as { retryable: boolean }).retryable).toBe(true);
      readFails = false;
      const retried = await exchangeToken(handle, transient, {
        resumeSessionId: existing.sessionId,
      });
      expect(retried.status).toBe(200);
      expect(retried.sessionId).toBe(existing.sessionId);
    } finally {
      await handle.close();
    }
  });
});

describe("Token 重试的持久化身份稳定（三轮评审修复 3）", () => {
  it("ensureSession 提交成功但响应失败：同 Token 重试复用相同身份且仅一个逻辑 Session", async () => {
    const directory = tempDirectory("bellis-p4-identity-");
    const base = await createMigratedBaseClient(directory);
    baseClients.push(base);
    const ensureInputs: Array<{ sessionId: string; createdAtMs: number }> = [];
    let failAfterCommit = true;
    const handle = await startTestRuntime({
      dataDirectory: directory,
      persistenceClient: wrapPersistenceClient(base, {
        ensureSession: async (input) => {
          // 先执行真实提交，再人为失败（模拟 Worker 在提交后、响应前崩溃）。
          await base.ensureSession(input);
          ensureInputs.push({ sessionId: input.sessionId, createdAtMs: input.createdAtMs });
          if (failAfterCommit) {
            failAfterCommit = false;
            throw new PersistenceError("unavailable", "worker died after commit");
          }
        },
      }),
    });
    try {
      const token = handle.issueStartupToken().token;
      const first = await exchangeToken(handle, token);
      expect(first.status).toBe(503);
      // 同 Token 重试成功：幂等命中首次已提交的行，而非第二个 Session。
      const retry = await exchangeToken(handle, token);
      expect(retry.status).toBe(200);
      expect(ensureInputs).toHaveLength(2);
      expect(ensureInputs[1]).toEqual(ensureInputs[0]);
      expect(retry.sessionId).toBe(ensureInputs[0]?.sessionId);
      // Token 最终成功后即失效。
      const third = await exchangeToken(handle, token);
      expect(third.status).toBe(401);
      // P2 单行（相同 sessionId 幂等命中）：恢复状态可读。
      const recovery = await handle.readSessionRecovery(retry.sessionId ?? "");
      expect(recovery.latestServerSeq).toBe(0n);
    } finally {
      await handle.close();
    }
  });
});

describe("TTL 主动关闭活跃连接（三轮评审修复 2）", () => {
  it("Control/Media 保持连接且无其它请求：跨过 TTL 后被主动关闭，Cookie 撤销", async () => {
    const handle = await startTestRuntime({
      dataDirectory: tempDirectory("bellis-p4-ttl-active-"),
      limits: { sessionTtlMs: 800 },
    });
    try {
      const { sessionId, cookie } = await mustExchangeOk(handle, handle.issueStartupToken().token);

      const control = new ControlWsClient({
        port: handle.status.port,
        path: "/ws/v1/control",
        cookie,
        origin: originFor(handle),
      });
      await control.opened();
      control.send(
        clientEnvelope({
          sessionId,
          type: "client.hello",
          payload: { protocolVersion: 1, clientType: "test-client" },
        }),
      );
      await control.waitForType("server.ready");
      // TTL 内心跳正常（Pong 可达）。
      control.send(clientEnvelope({ sessionId, type: "clock.ping", payload: { c0: "1" } }));
      await control.waitForType("clock.pong");

      const media = mediaSocket({
        port: handle.status.port,
        path: "/ws/v1/media",
        cookie,
        origin: originFor(handle),
      });
      await new Promise<void>((resolve, reject) => {
        media.once("open", () => resolve());
        media.once("error", (error: Error) => reject(error));
      });
      // 过期前媒体帧已被接收（帧计数可见，无论接受/拒绝）。
      media.send(
        buildMediaFrame({
          streamId: "77777777-7777-4777-8777-777777777777",
          frameId: "88888888-8888-4888-8888-888888888888",
          sessionId,
          sequence: 1,
          traceId: "0123456789abcdef0123456789abcdef",
        }),
      );
      const deadline = Date.now() + 2_000;
      for (;;) {
        const stats = handle.mediaFrameStats(sessionId);
        if (stats !== null && stats.accepted + stats.rejected >= 1) {
          break;
        }
        if (Date.now() > deadline) {
          throw new Error("media frame not observed before TTL");
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      // 在等待前登记关闭 Promise：跨过 TTL（期间无任何请求/Store 查询）。
      const controlClosed = control.closed();
      const mediaClosed = new Promise<number>((resolve) => {
        media.once("close", (code: number) => resolve(code));
      });
      await new Promise((resolve) => setTimeout(resolve, 1_400));

      // 调度器主动关闭两条连接：Control forceClose=terminate（异常关闭
      // 1006）；Media forceClose=close(1000, reason)（优雅关闭）。
      expect(await controlClosed).toBe(1006);
      expect(await mediaClosed).toBe(1000);

      // 过期后：旧 Cookie 不可再建立 Control/Media 连接（无 Pong、无帧接收）。
      const staleControl = new ControlWsClient({
        port: handle.status.port,
        path: "/ws/v1/control",
        cookie,
        origin: originFor(handle),
      });
      await staleControl.opened();
      expect(await staleControl.closed()).toBe(1008);
      const staleMedia = mediaSocket({
        port: handle.status.port,
        path: "/ws/v1/media",
        cookie,
        origin: originFor(handle),
      });
      await new Promise<void>((resolve, reject) => {
        staleMedia.once("open", () => resolve());
        staleMedia.once("error", (error: Error) => reject(error));
      });
      const staleMediaClosed = new Promise<number>((resolve) => {
        staleMedia.once("close", (code: number) => resolve(code));
      });
      expect(await staleMediaClosed).toBe(1008);
      // Session 已被移除：媒体帧计数不再可见（帧不再被接收）。
      expect(handle.mediaFrameStats(sessionId)).toBeNull();
    } finally {
      await handle.close();
    }
  });
});

describe("Host 头端口非法值（二轮评审修复 8）", () => {
  it("非数字/空端口/超范围端口一律 403（REST）", async () => {
    const handle = await startTestRuntime({ dataDirectory: tempDirectory("bellis-p4-hostport-") });
    try {
      for (const spoof of [
        "localhost:evil",
        "127.0.0.1:",
        "[::1]:65536",
        "[::1]:99999",
        "localhost:0",
      ]) {
        const outcome = await rawRequest(handle.status.port, {
          host: spoof,
          origin: originFor(handle),
        });
        expect(outcome.kind === "status" ? outcome.status : 403).toBe(403);
      }
      // 合法端口仍通过（默认允许列表含 localhost/127.0.0.1）。
      const ok = await rawRequest(handle.status.port, {
        host: `localhost:${handle.status.port}`,
        origin: originFor(handle),
      });
      expect(ok.kind === "status" ? ok.status : 0).toBe(200);
      const okAddr = await rawRequest(handle.status.port, {
        host: `127.0.0.1:${handle.status.port}`,
        origin: originFor(handle),
      });
      expect(okAddr.kind === "status" ? okAddr.status : 0).toBe(200);
    } finally {
      await handle.close();
    }
  });

  it("WS Upgrade 上同样拒绝非法端口 Host", async () => {
    const handle = await startTestRuntime({ dataDirectory: tempDirectory("bellis-p4-hostws-") });
    try {
      for (const spoof of ["localhost:evil", "127.0.0.1:", "[::1]:65536"]) {
        const outcome = await rawRequest(
          handle.status.port,
          {
            host: spoof,
            origin: originFor(handle),
            connection: "Upgrade",
            upgrade: "websocket",
            "sec-websocket-version": "13",
            "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
          },
          "/ws/v1/control",
        );
        expect(outcome.kind === "status" ? outcome.status : 403).toBe(403);
      }
    } finally {
      await handle.close();
    }
  });
});

describe("Session 过期与容量（二轮评审修复 9）", () => {
  it("TTL 过期后 Cookie 解析失败（WS Upgrade 1008）", async () => {
    const handle = await startTestRuntime({
      dataDirectory: tempDirectory("bellis-p4-sessttl-"),
      limits: { sessionTtlMs: 150 },
    });
    try {
      const { sessionId, cookie } = await mustExchangeOk(handle, handle.issueStartupToken().token);
      const client = new ControlWsClient({
        port: handle.status.port,
        path: "/ws/v1/control",
        cookie,
        origin: originFor(handle),
      });
      await client.opened();
      client.send(
        clientEnvelope({
          sessionId,
          type: "client.hello",
          payload: { protocolVersion: 1, clientType: "test-client" },
        }),
      );
      await client.waitForType("server.ready");
      client.close();

      await new Promise((resolve) => setTimeout(resolve, 250));
      const expired = new ControlWsClient({
        port: handle.status.port,
        path: "/ws/v1/control",
        cookie,
        origin: originFor(handle),
      });
      await expired.opened();
      expect(await expired.closed()).toBe(1008);
    } finally {
      await handle.close();
    }
  });

  it("超出 maxSessions 淘汰最旧：旧 Session Cookie 失效", async () => {
    const handle = await startTestRuntime({
      dataDirectory: tempDirectory("bellis-p4-sesscap-"),
      limits: { maxSessions: 1 },
    });
    try {
      const first = await mustExchangeOk(handle, handle.issueStartupToken().token);
      const second = await mustExchangeOk(handle, handle.issueStartupToken().token);
      // 第一个 Session 被淘汰：其 Cookie 不再解析。
      const stale = new ControlWsClient({
        port: handle.status.port,
        path: "/ws/v1/control",
        cookie: first.cookie,
        origin: originFor(handle),
      });
      await stale.opened();
      expect(await stale.closed()).toBe(1008);
      // 新 Session 正常。
      const active = new ControlWsClient({
        port: handle.status.port,
        path: "/ws/v1/control",
        cookie: second.cookie,
        origin: originFor(handle),
      });
      await active.opened();
      active.send(
        clientEnvelope({
          sessionId: second.sessionId,
          type: "client.hello",
          payload: { protocolVersion: 1, clientType: "test-client" },
        }),
      );
      await active.waitForType("server.ready");
      active.close();
    } finally {
      await handle.close();
    }
  });
});

describe("OpenAPI 与 Auth 实际边界一致（二轮修复 11 + 三轮修复 4）", () => {
  it("auth/exchange 文档：标准 Bearer Scheme、可选 Body、实际状态码、不宣称无凭据合法", async () => {
    const handle = await startTestRuntime({ dataDirectory: tempDirectory("bellis-p4-oapi-") });
    try {
      const response = await fetch(`http://127.0.0.1:${handle.status.port}/api/v1/openapi.json`, {
        headers: { origin: originFor(handle) },
      });
      const doc = (await response.json()) as {
        paths: Record<
          string,
          {
            post?: {
              security?: Array<Record<string, unknown>>;
              parameters?: Array<{ name?: string }>;
              "x-bellis-auth"?: { credentialSources?: unknown[] };
              requestBody?: { required?: boolean };
              responses?: Record<string, unknown>;
            };
          }
        >;
        components: { securitySchemes?: Record<string, Record<string, unknown>> };
      };
      const operation = doc.paths["/api/v1/auth/exchange"]?.post;
      expect(operation).toBeDefined();
      // 标准 HTTP Bearer Scheme：apiKey 会让客户端把 Token 原值直接写入
      // Authorization 头（无 Bearer 前缀），与服务端真实解析不一致。
      const scheme = doc.components.securitySchemes?.startupToken;
      expect(scheme?.type).toBe("http");
      expect(scheme?.scheme).toBe("bearer");
      expect(scheme?.name).toBeUndefined();
      // security 只声明 Bearer 一种方式：不得出现 `{}`（宣称无凭据请求合法）。
      expect(operation?.security).toEqual([{ startupToken: [] }]);
      // Authorization 头只由 Security Scheme 定义，不再同时声明普通参数。
      expect(operation?.parameters).toBeUndefined();
      // Header-only 请求合法：Body 可选；扩展说明三种凭据来源。
      expect(operation?.requestBody?.required).toBe(false);
      expect(operation?.["x-bellis-auth"]?.credentialSources?.length).toBeGreaterThanOrEqual(2);
      // 实际可能返回的状态码全部列出（含 500/504）。
      const responses = Object.keys(operation?.responses ?? {});
      for (const status of ["200", "400", "401", "500", "503", "504"]) {
        expect(responses).toContain(status);
      }
    } finally {
      await handle.close();
    }
  });

  it("按文档构造的 Bearer 请求被真实路由接受；StartupToken 前缀等价", async () => {
    const handle = await startTestRuntime({ dataDirectory: tempDirectory("bellis-p4-oapi2-") });
    try {
      // 文档声明的标准方式：Authorization: Bearer <token>（无 Body）。
      const token = handle.issueStartupToken().token;
      const response = await fetch(`http://127.0.0.1:${handle.status.port}/api/v1/auth/exchange`, {
        method: "POST",
        headers: { origin: originFor(handle), authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("set-cookie")).toContain("HttpOnly");
      const body = (await response.json()) as { sessionId: string };
      expect(body.sessionId).toMatch(/^[0-9a-f-]{36}$/);

      // 扩展声明的 StartupToken 前缀同样被接受。
      const prefixed = handle.issueStartupToken().token;
      const prefixResponse = await fetch(
        `http://127.0.0.1:${handle.status.port}/api/v1/auth/exchange`,
        {
          method: "POST",
          headers: { origin: originFor(handle), authorization: `StartupToken ${prefixed}` },
        },
      );
      expect(prefixResponse.status).toBe(200);
    } finally {
      await handle.close();
    }
  });

  it("无凭据请求（文档未宣称合法）被真实路由拒绝", async () => {
    const handle = await startTestRuntime({ dataDirectory: tempDirectory("bellis-p4-oapi3-") });
    try {
      const response = await fetch(`http://127.0.0.1:${handle.status.port}/api/v1/auth/exchange`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: originFor(handle) },
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(400);
      expect(((await response.json()) as { code: string }).code).toBe("invalid_message");
    } finally {
      await handle.close();
    }
  });
});
