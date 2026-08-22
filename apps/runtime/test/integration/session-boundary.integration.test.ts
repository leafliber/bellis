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
import { clientEnvelope } from "../ws-client.js";

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

describe("OpenAPI 与 Auth 实际边界一致（二轮评审修复 11）", () => {
  it("auth/exchange 文档：Header 参数、可选 Body、实际状态码", async () => {
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
              parameters?: unknown[];
              requestBody?: { required?: boolean };
              responses?: Record<string, unknown>;
            };
          }
        >;
        components: { securitySchemes?: Record<string, unknown> };
      };
      const operation = doc.paths["/api/v1/auth/exchange"]?.post;
      expect(operation).toBeDefined();
      // Header-only 请求合法：Body 可选 + Authorization Header 参数。
      expect(operation?.requestBody?.required).toBe(false);
      const authHeader = operation?.parameters?.find(
        (parameter) =>
          typeof parameter === "object" &&
          parameter !== null &&
          (parameter as { name?: string }).name === "Authorization",
      );
      expect(authHeader).toBeDefined();
      // 实际可能返回的状态码全部列出（含 500/504）。
      const responses = Object.keys(operation?.responses ?? {});
      for (const status of ["200", "400", "401", "500", "503", "504"]) {
        expect(responses).toContain(status);
      }
      expect(doc.components.securitySchemes?.startupToken).toBeDefined();
    } finally {
      await handle.close();
    }
  });

  it("Header-only 交换（无 Body）端到端成功", async () => {
    const handle = await startTestRuntime({ dataDirectory: tempDirectory("bellis-p4-oapi2-") });
    try {
      const token = handle.issueStartupToken().token;
      const response = await fetch(`http://127.0.0.1:${handle.status.port}/api/v1/auth/exchange`, {
        method: "POST",
        headers: { origin: originFor(handle), authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("set-cookie")).toContain("HttpOnly");
      const body = (await response.json()) as { sessionId: string };
      expect(body.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      await handle.close();
    }
  });
});
