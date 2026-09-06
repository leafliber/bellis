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

export const test = base.extend<{ stageEnv: StageEnvironment; phase: 2 | 3 }>({
  phase: [2, { option: true }],
  stageEnv: async ({ phase }, run) => {
    const runtimePort = await freePort();
    const vitePort = await freePort();
    const viteOrigin = `http://127.0.0.1:${vitePort}`;
    const dataDirectory = mkdtempSync(join(tmpdir(), "bellis-stage-e2e-"));

    const child = fork(
      join(REPO_ROOT, "scripts", `phase-${phase}-demo-child.mjs`),
      [dataDirectory],
      {
        cwd: REPO_ROOT,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        env: {
          ...process.env,
          BELLIS_E2E_PORT: String(runtimePort),
          BELLIS_E2E_ORIGINS: viteOrigin,
        },
      },
    );
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
      process.execPath,
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

    // Teardown 严格化：优雅关闭是 Gate 断言的一部分——超时被迫 SIGKILL
    // 的 Runtime / 退不出的 Vite / 非零退出码都记为失败。清理无条件执行
    //（setup 失败同样回收子进程）；teardown 问题优先于 run 的失败抛出。
    let runError: unknown = null;
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
    } catch (error) {
      runError = error;
    }
    const teardownProblems: string[] = [];
    child.send({ type: "shutdown" });
    await new Promise<void>((resolvePromise) => {
      const timer = setTimeout(() => {
        teardownProblems.push("runtime graceful shutdown timed out (SIGKILL forced)");
        child.kill("SIGKILL");
        resolvePromise();
      }, 10_000);
      child.once("exit", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          teardownProblems.push(`runtime exited with code ${String(code)}`);
        }
        resolvePromise();
      });
    });
    vite.kill("SIGTERM");
    await new Promise<void>((resolvePromise) => {
      const timer = setTimeout(() => {
        teardownProblems.push("vite dev server did not exit within 5s");
        vite.kill("SIGKILL");
        resolvePromise();
      }, 5000);
      vite.once("exit", () => {
        clearTimeout(timer);
        resolvePromise();
      });
    });
    rmSync(dataDirectory, { recursive: true, force: true });
    if (teardownProblems.length > 0) {
      throw new Error(
        `stage e2e teardown was not clean: ${teardownProblems.join("; ")}
runtime-tail: ${childLogs.join("").slice(-600)}`,
      );
    }
    if (runError !== null) {
      throw runError;
    }
  },
});

export { expect } from "@playwright/test";
