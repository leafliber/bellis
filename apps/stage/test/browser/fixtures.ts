import { fork, spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test as base } from "@playwright/test";

/**
 * 浏览器 E2E 环境装配（仅测试）：真实 Runtime 子进程（phase2 启用、
 * 固定端口、Vite 源加入 Origin 允许列表）+ 真实 Vite dev server
 * （/api、/ws 代理到 Runtime，Cookie/Origin 同源）。teardown 逆序释放。
 */

const STAGE_DIR = fileURLToPath(new URL("../..", import.meta.url));
const REPO_ROOT = resolve(STAGE_DIR, "../..");
const DEMO_CHILD = join(REPO_ROOT, "scripts", "phase-2-demo-child.mjs");

/** 挑选一个空闲 TCP 端口（listen 后立即释放，交给子进程/服务使用）。 */
function freePort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolvePromise(port));
    });
  });
}

interface RpcMessage {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface StageEnvironment {
  readonly runtimePort: number;
  readonly vitePort: number;
  readonly pageUrl: (token: string) => string;
  /** IPC 请求：issue-token / submit / interrupt / state / shutdown。 */
  rpc(message: Record<string, unknown>): void;
  expectRpc(type: string, timeoutMs?: number): Promise<RpcMessage>;
  /** 签发一次性 startup token（不消费——消费发生在页面 exchange）。 */
  issueToken(): Promise<string>;
}

export const test = base.extend<{ stageEnv: StageEnvironment }>({
  /* oxlint-disable-next-line no-empty-pattern -- Playwright fixture 签名要求解构 */
  stageEnv: async ({}, run) => {
    const runtimePort = await freePort();
    const vitePort = await freePort();
    const viteOrigin = `http://127.0.0.1:${vitePort}`;
    const dataDirectory = mkdtempSync(join(tmpdir(), "bellis-stage-e2e-"));

    const child = fork(DEMO_CHILD, [dataDirectory], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: {
        ...process.env,
        BELLIS_E2E_PORT: String(runtimePort),
        BELLIS_E2E_ORIGINS: viteOrigin,
      },
    });
    const childLogs: string[] = [];
    for (const stream of [child.stdout, child.stderr]) {
      if (stream !== null) {
        stream.on("data", (chunk: Buffer) => {
          childLogs.push(chunk.toString("utf8"));
          if (childLogs.length > 400) {
            childLogs.shift();
          }
        });
      }
    }
    const pending: RpcMessage[] = [];
    child.on("message", (message: RpcMessage) => {
      pending.push(message);
    });

    const vite = spawn(
      "node",
      [
        join(STAGE_DIR, "node_modules", "vite", "bin", "vite.js"),
        "--port",
        String(vitePort),
        "--strictPort",
        "--host",
        "127.0.0.1",
      ],
      {
        cwd: STAGE_DIR,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          BELLIS_RUNTIME_PROXY: `http://127.0.0.1:${runtimePort}`,
        },
      },
    );
    const viteLogs: string[] = [];
    for (const stream of [vite.stdout, vite.stderr]) {
      if (stream !== null) {
        stream.on("data", (chunk: Buffer) => viteLogs.push(chunk.toString("utf8")));
      }
    }

    const expectRpc = (type: string, timeoutMs = 20_000): Promise<RpcMessage> =>
      new Promise((resolvePromise, reject) => {
        const startedAt = Date.now();
        const poll = (): void => {
          const index = pending.findIndex((message) => message.type === type);
          if (index !== -1) {
            resolvePromise(pending.splice(index, 1)[0]!);
            return;
          }
          if (Date.now() - startedAt > timeoutMs) {
            reject(new Error(`timeout waiting for ipc ${type}`));
            return;
          }
          setTimeout(poll, 50);
        };
        poll();
      });

    const environment: StageEnvironment = {
      runtimePort,
      vitePort,
      pageUrl: (token: string) => `${viteOrigin}/stage/e2e?token=${encodeURIComponent(token)}`,
      rpc: (message) => {
        child.send(message);
      },
      expectRpc,
      issueToken: async () => {
        child.send({ type: "issue-token" });
        const { token } = (await expectRpc("token")) as unknown as { token: string };
        return token;
      },
    };

    try {
      await expectRpc("ready", 30_000);
      const viteDeadline = Date.now() + 30_000;
      for (;;) {
        const reachable = await fetch(`${viteOrigin}/stage/e2e`)
          .then((response) => response.status)
          .catch(() => 0);
        if (reachable === 200) {
          // 代理探针：经 Vite 访问 Runtime 的 /api（502 = 代理不可达）。
          const probe = await fetch(`${viteOrigin}/api/v1/auth/exchange`, {
            method: "POST",
            headers: { "content-type": "application/json", origin: viteOrigin },
            body: "{}",
          }).catch((error: unknown) => `fetch-error:${String(error)}`);
          const probeStatus = typeof probe === "string" ? probe : probe.status;
          if (probeStatus === 502) {
            throw new Error(
              `vite proxy cannot reach runtime (runtime=${runtimePort}):
${viteLogs.join("").slice(-800)}`,
            );
          }
          break;
        }
        if (Date.now() > viteDeadline) {
          throw new Error(`vite dev server not reachable: ${viteLogs.join("").slice(-500)}`);
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
      }
      await run(environment);
    } finally {
      child.send({ type: "shutdown" });
      await new Promise<void>((resolvePromise) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolvePromise();
        }, 10_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolvePromise();
        });
      });
      vite.kill("SIGTERM");
      await new Promise<void>((resolvePromise) => {
        const timer = setTimeout(resolvePromise, 5000);
        vite.once("exit", () => {
          clearTimeout(timer);
          resolvePromise();
        });
      });
      rmSync(dataDirectory, { recursive: true, force: true });
    }
  },
});

export { expect } from "@playwright/test";
