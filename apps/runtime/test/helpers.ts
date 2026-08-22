import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { PersistenceClient, PersistenceWorkerOptions } from "@bellis/persistence";
import { createPersistenceClient } from "@bellis/persistence";
import type { RuntimeHandle } from "../src/index.js";
import { startRuntime } from "../src/index.js";

/** 共享测试夹具：临时目录、TS Worker 注入与最小 Runtime 装配。 */

export function createTempDataDirectory(prefix = "bellis-p4-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function cleanupTempDataDirectory(directory: string): void {
  rmSync(directory, { recursive: true, force: true });
}

/** TS 源码 DB Worker 注入（经 @bellis/persistence 公开 Worker Options）。 */
export const WORKER_FIXTURE: PersistenceWorkerOptions = {
  url: pathToFileURL(
    join(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "packages",
      "persistence",
      "src",
      "worker",
      "entry.ts",
    ),
  ),
  execArgv: [
    "--import",
    pathToFileURL(join(import.meta.dirname, "fixtures", "ts-worker-resolve.mjs")).href,
  ],
};

/** 子进程 harness 的 resolve hook（fork execArgv 注入）。 */
export const RESOLVE_HOOK_URL = pathToFileURL(
  join(import.meta.dirname, "fixtures", "ts-worker-resolve.mjs"),
).href;

export interface TestRuntimeOptions {
  readonly dataDirectory: string;
  readonly port?: number;
  readonly allowMissingOrigin?: boolean;
  readonly startupTokenTtlMs?: number;
  readonly replayWindowCapacity?: number;
  readonly maxTotalStreams?: number;
  readonly persistenceClient?: PersistenceClient;
}

/** 启动测试 Runtime（随机空闲端口、TS Worker、无检查点观察器）。 */
export async function startTestRuntime(options: TestRuntimeOptions): Promise<RuntimeHandle> {
  return startRuntime({
    config: {
      dataDirectory: options.dataDirectory,
      runtimeVersion: "0.1.0-test",
      port: options.port ?? 0,
      ...(options.allowMissingOrigin === undefined
        ? {}
        : { allowMissingOrigin: options.allowMissingOrigin }),
      ...(options.startupTokenTtlMs === undefined
        ? {}
        : { startupTokenTtlMs: options.startupTokenTtlMs }),
      ...(options.replayWindowCapacity === undefined && options.maxTotalStreams === undefined
        ? {}
        : {
            limits: {
              ...(options.replayWindowCapacity === undefined
                ? {}
                : { replayWindowCapacity: options.replayWindowCapacity }),
              ...(options.maxTotalStreams === undefined
                ? {}
                : { maxTotalStreams: options.maxTotalStreams }),
            },
          }),
    },
    persistenceWorker: WORKER_FIXTURE,
    ...(options.persistenceClient === undefined
      ? {}
      : { persistenceClient: options.persistenceClient }),
  });
}

/** 创建并迁移基础客户端（包装注入用）。 */
export async function createMigratedBaseClient(dataDirectory: string): Promise<PersistenceClient> {
  const client = createPersistenceClient({ dataDirectory, worker: WORKER_FIXTURE });
  await client.migrate();
  return client;
}

/** 用覆盖方法包装基础客户端（延迟/失败注入）。 */
export function wrapPersistenceClient(
  base: PersistenceClient,
  overrides: Partial<PersistenceClient>,
): PersistenceClient {
  return { ...base, ...overrides };
}

/** 测试用 Origin 头（与默认推导的允许列表一致）。 */
export function originFor(handle: RuntimeHandle, port: number = handle.status.port): string {
  return `http://127.0.0.1:${port}`;
}

export interface ExchangeResult {
  readonly sessionId: string;
  readonly cookie: string;
}

/** Token 交换 → Session Cookie（测试客户端路径）。 */
export async function exchangeToken(
  handle: RuntimeHandle,
  token: string,
  options?: { origin?: string },
): Promise<{ status: number; body: unknown; cookie: string | null; sessionId: string | null }> {
  const response = await fetch(`http://127.0.0.1:${handle.status.port}/api/v1/auth/exchange`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: options?.origin ?? originFor(handle),
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({}),
  });
  const setCookie = response.headers.get("set-cookie");
  const cookie = setCookie === null ? null : (/^([^=]+=[^;]+)/.exec(setCookie)?.[1] ?? null);
  const body: unknown = await response.json().catch(() => null);
  const sessionId =
    body !== null && typeof body === "object" && "sessionId" in body
      ? String((body as { sessionId: unknown }).sessionId)
      : null;
  return { status: response.status, body, cookie, sessionId };
}

/** 交换并断言成功；失败时抛出带状态码的错误。 */
export async function mustExchange(handle: RuntimeHandle, token: string): Promise<ExchangeResult> {
  const result = await exchangeToken(handle, token);
  if (result.status !== 200 || result.cookie === null || result.sessionId === null) {
    throw new Error(
      `auth exchange failed: status=${result.status} body=${JSON.stringify(result.body)}`,
    );
  }
  return { sessionId: result.sessionId, cookie: result.cookie };
}
