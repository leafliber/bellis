import { request as httpRequest } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RuntimeHandle } from "../../src/index.js";
import {
  cleanupTempDataDirectory,
  createTempDataDirectory,
  exchangeToken,
  originFor,
  startTestRuntime,
} from "../helpers.js";

let handle: RuntimeHandle;
let dataDirectory: string;

beforeAll(async () => {
  dataDirectory = createTempDataDirectory("bellis-p4-rest-");
  handle = await startTestRuntime({ dataDirectory });
});

afterAll(async () => {
  await handle.close();
  cleanupTempDataDirectory(dataDirectory);
});

function base(): string {
  return `http://127.0.0.1:${handle.status.port}`;
}

async function get(path: string, headers?: Record<string, string>): Promise<Response> {
  return fetch(`${base()}${path}`, { headers: { origin: originFor(handle), ...headers } });
}

describe("REST /health /version /openapi", () => {
  it("live 返回 200 且只含状态", async () => {
    const response = await get("/api/v1/health/live");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string };
    expect(body.status).toBe("live");
  });

  it("ready 返回 200", async () => {
    const response = await get("/api/v1/health/ready");
    expect(response.status).toBe(200);
    expect(((await response.json()) as { status: string }).status).toBe("ready");
  });

  it("version 返回应用/协议版本与 InstanceID，不含 Token/路径", async () => {
    const response = await get("/api/v1/version");
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.version).toBe("0.1.0-test");
    expect(body.protocol).toEqual({ control: 1, media: 1 });
    expect(typeof body.runtimeInstanceId).toBe("string");
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("dataDirectory");
    expect(serialized).not.toContain(dataDirectory);
    expect(serialized).not.toContain("token");
  });

  it("openapi 3.1 文档与实际注册的 REST 路由一致", async () => {
    const response = await get("/api/v1/openapi.json");
    expect(response.status).toBe(200);
    const doc = (await response.json()) as {
      openapi: string;
      paths: Record<string, unknown>;
      components: { schemas: Record<string, unknown> };
    };
    expect(doc.openapi).toBe("3.1.0");
    expect(Object.keys(doc.paths).toSorted()).toEqual([
      "/api/v1/auth/exchange",
      "/api/v1/health/live",
      "/api/v1/health/ready",
      "/api/v1/openapi.json",
      "/api/v1/version",
    ]);
    // ErrorEnvelope 组件来自 contracts 生成物（不复制手写 Schema）。
    const errorEnvelope = doc.components.schemas.ErrorEnvelope as Record<string, unknown>;
    expect(errorEnvelope).toBeDefined();
    expect(JSON.stringify(errorEnvelope)).toContain("invalid_message");
    // WebSocket 不伪装成 REST，通过扩展指向协议文档。
    const serialized = JSON.stringify(doc);
    expect(serialized).toContain("/ws/v1/control");
    expect(serialized).toContain("docs/protocols/control-websocket.md");
  });

  it("未知路由返回 404 ErrorEnvelope", async () => {
    const response = await get("/api/v1/nope");
    expect(response.status).toBe(404);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe("invalid_message");
  });
});

describe("Host / Origin 边界", () => {
  it("非法 Host 被拒绝（裸 HTTP 注入欺骗 Host 头）", async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        {
          host: "127.0.0.1",
          port: handle.status.port,
          path: "/api/v1/health/live",
          headers: { host: "evil.example.com", origin: originFor(handle) },
        },
        (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode ?? 0));
        },
      );
      request.on("error", reject);
      request.end();
    });
    expect(status).toBe(403);
  });

  it("缺失 Origin 默认被拒绝；显式配置后允许", async () => {
    const response = await fetch(`${base()}/api/v1/health/live`);
    expect(response.status).toBe(403);

    const missingAllowedDir = createTempDataDirectory("bellis-p4-origin-");
    const missingAllowed = await startTestRuntime({
      dataDirectory: missingAllowedDir,
      allowMissingOrigin: true,
    });
    try {
      const ok = await fetch(`http://127.0.0.1:${missingAllowed.status.port}/api/v1/health/live`);
      expect(ok.status).toBe(200);
    } finally {
      await missingAllowed.close();
      cleanupTempDataDirectory(missingAllowedDir);
    }
  });

  it("非允许 Origin 被拒绝（跨站伪造）", async () => {
    const response = await fetch(`${base()}/api/v1/health/live`, {
      headers: { origin: "http://127.0.0.1:9999" },
    });
    expect(response.status).toBe(403);
  });

  it("允许列表内的 localhost Origin 通过", async () => {
    const response = await get("/api/v1/health/live", {
      origin: `http://localhost:${handle.status.port}`,
    });
    expect(response.status).toBe(200);
  });
});

describe("Startup Token 交换", () => {
  it("成功一次：签发 Cookie（HttpOnly/SameSite=Strict/Path）并创建 Session", async () => {
    const issued = handle.issueStartupToken();
    const first = await fetch(`${base()}/api/v1/auth/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: originFor(handle) },
      body: JSON.stringify({ startupToken: issued.token }),
    });
    expect(first.status).toBe(200);
    const body = (await first.json()) as { sessionId: string };
    expect(body.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    const setCookie = first.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).not.toContain(issued.token);
  });

  it("同一 Token 第二次交换失败且不泄露原因", async () => {
    const issued = handle.issueStartupToken();
    const first = await exchangeToken(handle, issued.token);
    expect(first.status).toBe(200);
    const second = await exchangeToken(handle, issued.token);
    expect(second.status).toBe(401);
    const body = second.body as { code: string; message: string };
    expect(body.code).toBe("unauthorized");
    expect(body.message).not.toContain("expired");
    expect(body.message).not.toContain("used");
  });

  it("过期与未知 Token 统一 unauthorized", async () => {
    const shortTtlDir = createTempDataDirectory("bellis-p4-ttl-");
    const shortTtl = await startTestRuntime({
      dataDirectory: shortTtlDir,
      startupTokenTtlMs: 50,
    });
    try {
      const issued = shortTtl.issueStartupToken();
      await new Promise((resolve) => setTimeout(resolve, 120));
      const expired = await exchangeToken(shortTtl, issued.token);
      expect(expired.status).toBe(401);
      const unknown = await exchangeToken(shortTtl, "totally-unknown-token");
      expect(unknown.status).toBe(401);
    } finally {
      await shortTtl.close();
      cleanupTempDataDirectory(shortTtlDir);
    }
  });

  it("缺少 Token 的请求返回 invalid_message；错误 Host/Origin 的交换被边界拒绝", async () => {
    const noToken = await fetch(`${base()}/api/v1/auth/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: originFor(handle) },
      body: JSON.stringify({}),
    });
    expect(noToken.status).toBe(400);
    expect(((await noToken.json()) as { code: string }).code).toBe("invalid_message");

    const badOrigin = await fetch(`${base()}/api/v1/auth/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://evil.example.com" },
      body: JSON.stringify({ startupToken: handle.issueStartupToken().token }),
    });
    expect(badOrigin.status).toBe(403);
  });

  it("Token 绝不出现在 URL Query（Query 携带不生效）", async () => {
    const issued = handle.issueStartupToken();
    const response = await fetch(
      `${base()}/api/v1/auth/exchange?startupToken=${encodeURIComponent(issued.token)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json", origin: originFor(handle) },
        body: JSON.stringify({}),
      },
    );
    expect(response.status).toBe(400);
    // 该 Token 从未被消耗，Body 交换仍可用：
    const viaBody = await exchangeToken(handle, issued.token);
    expect(viaBody.status).toBe(200);
  });
});
