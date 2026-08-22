import { fork } from "node:child_process";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseDecimalString } from "@bellis/contracts";
import type { ServerControlEnvelope } from "@bellis/contracts";
import { cleanupTempDataDirectory, createTempDataDirectory, RESOLVE_HOOK_URL } from "../helpers.js";
import { clientEnvelope } from "../ws-client.js";
import { ControlWsClient } from "../ws-client.js";

/**
 * 真实子进程重启恢复回归（P4 修复 1）：
 * 崩溃前 Control 连接推进 Seq → SIGKILL → 同一数据目录重启 →
 * `resumeSessionId` 重新挂载旧逻辑 Session → 从 P2 latestServerSeq 构造
 * resume：断言 (a) 快照路径在缺 Replay 内容时正确触发；(b) 重启后首条
 * 新消息 Seq 严格大于旧水位（跨重启不复用 Seq）。
 */

const HARNESS = join(import.meta.dirname, "..", "fixtures", "runtime-crash-harness.ts");

interface HarnessMessage {
  readonly type: string;
  readonly [key: string]: unknown;
}

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    cleanupTempDataDirectory(directory);
  }
});

function forkHarness(dataDirectory: string): Promise<{
  send: (message: Record<string, unknown>) => void;
  next: () => Promise<HarnessMessage>;
  exchangeToken: () => Promise<string>;
  kill: () => Promise<void>;
  closeGracefully: () => Promise<void>;
  port: number;
}> {
  const child = fork(HARNESS, [dataDirectory, "production"], {
    execArgv: ["--import", RESOLVE_HOOK_URL],
    stdio: ["inherit", "inherit", "inherit", "ipc"],
  });
  const pending: HarnessMessage[] = [];
  const waiters: Array<(message: HarnessMessage) => void> = [];
  child.on("message", (message: unknown) => {
    const event = message as HarnessMessage;
    const waiter = waiters.shift();
    if (waiter === undefined) {
      pending.push(event);
    } else {
      waiter(event);
    }
  });
  const exited = new Promise<never>((_, reject) => {
    child.once("exit", (code) => reject(new Error(`harness exited early (code=${code})`)));
  });
  const next = (): Promise<HarnessMessage> => {
    const buffered = pending.shift();
    if (buffered !== undefined) {
      return Promise.resolve(buffered);
    }
    return Promise.race([new Promise<HarnessMessage>((resolve) => waiters.push(resolve)), exited]);
  };
  return (async () => {
    const ready = await next();
    if (ready.type !== "ready") {
      throw new Error(`expected ready, got ${JSON.stringify(ready)}`);
    }
    return {
      send: (message) => child.send(message),
      next,
      port: ready.port as number,
      exchangeToken: async () => {
        child.send({ type: "issue-token" });
        const reply = await next();
        if (reply.type !== "token") {
          throw new Error(`expected token, got ${JSON.stringify(reply)}`);
        }
        return reply.token as string;
      },
      kill: async () => {
        const dead = new Promise<void>((resolve) => child.once("exit", () => resolve()));
        child.kill("SIGKILL");
        await dead;
      },
      closeGracefully: async () => {
        const closed = new Promise<void>((resolve) => child.once("exit", () => resolve()));
        child.send({ type: "close" });
        await closed;
      },
    };
  })();
}

async function exchange(
  port: number,
  token: string,
  resumeSessionId?: string,
): Promise<{ status: number; sessionId: string | null; cookie: string | null }> {
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/auth/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: `http://127.0.0.1:${port}` },
    body: JSON.stringify({
      startupToken: token,
      ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
    }),
  });
  const setCookie = response.headers.get("set-cookie") ?? "";
  const cookie = /^([^=]+=[^;]+)/.exec(setCookie)?.[1] ?? null;
  const body = response.status === 200 ? ((await response.json()) as { sessionId: string }) : null;
  return { status: response.status, sessionId: body?.sessionId ?? null, cookie };
}

function controlClient(
  port: number,
  cookie: string,
  sessionId: string,
  lastAck?: bigint,
): ControlWsClient {
  const client = new ControlWsClient({
    port,
    path: "/ws/v1/control",
    cookie,
    origin: `http://127.0.0.1:${port}`,
  });
  void client.opened().then(() => {
    client.send(
      clientEnvelope({
        sessionId,
        type: "client.hello",
        payload: {
          protocolVersion: 1,
          clientType: "test-client",
          ...(lastAck === undefined ? {} : { lastAck: lastAck.toString() }),
        },
      }),
    );
  });
  return client;
}

describe("跨重启 Control Seq 恢复（P4 修复 1）", () => {
  it("resumeSessionId 挂载：快照触发 + 首条新消息 Seq 严格大于旧水位", async () => {
    const directory = createTempDataDirectory("bellis-p4-restart-");
    directories.push(directory);

    // 实例 1：建立 Control 连接并推进 Seq。
    const first = await forkHarness(directory);
    const token1 = await first.exchangeToken();
    const exchanged1 = await exchange(first.port, token1);
    expect(exchanged1.status).toBe(200);
    const sessionId = exchanged1.sessionId as string;
    const cookie1 = exchanged1.cookie as string;
    const client1 = controlClient(first.port, cookie1, sessionId);
    const ready1 = await client1.waitForType("server.ready");
    expect(ready1.seq).toBe("2");
    for (let index = 0; index < 3; index += 1) {
      client1.send(
        clientEnvelope({ sessionId, type: "clock.ping", payload: { c0: String(index) } }),
      );
      await client1.waitFor(
        (envelope) =>
          envelope.type === "clock.pong" &&
          (envelope.payload as { c0: string }).c0 === String(index),
        5_000,
      );
    }
    const lastMessage = client1.received.at(-1) as ServerControlEnvelope;
    const oldWatermark = parseDecimalString(lastMessage.seq);
    expect(oldWatermark).toBeGreaterThanOrEqual(5n);

    // 读取崩溃前持久化水位（作为对照），然后 SIGKILL（真实崩溃）。
    first.send({ type: "recovery", sessionId });
    const recovery1 = await first.next();
    expect(recovery1.type).toBe("recovery");
    const persistedWatermark = parseDecimalString(recovery1.latestServerSeq as string);
    expect(persistedWatermark).toBe(oldWatermark);
    await first.kill();
    client1.close();

    // 实例 2：同一数据目录；resumeSessionId 重新挂载旧逻辑 Session。
    const second = await forkHarness(directory);
    try {
      const token2 = await second.exchangeToken();
      // 未知 resume 目标：统一 401。
      const unknown = await exchange(second.port, token2, "99999999-9999-4999-8999-999999999999");
      expect(unknown.status).toBe(401);

      const token3 = await second.exchangeToken();
      const exchanged2 = await exchange(second.port, token3, sessionId);
      expect(exchanged2.status).toBe(200);
      expect(exchanged2.sessionId).toBe(sessionId);
      const resumed = controlClient(second.port, exchanged2.cookie as string, sessionId, 0n);

      // 缺少 Replay 内容（跨重启窗口为空）：lastAck=0 → Replay Gap 快照。
      const snapshot = await resumed.waitForType("session.snapshot");
      const snapshotPayload = (snapshot.payload as { snapshot: { latestServerSeq: string } })
        .snapshot;
      expect(snapshotPayload.latestServerSeq).toBe(persistedWatermark.toString());
      const ready = await resumed.waitForType("server.ready");
      expect(resumed.received.findIndex((envelope) => envelope === snapshot)).toBeLessThan(
        resumed.received.findIndex((envelope) => envelope === ready),
      );

      // 重启后首条新消息 Seq 严格大于旧水位（不复用 Seq）。
      resumed.send(
        clientEnvelope({ sessionId, type: "clock.ping", payload: { c0: String(Date.now()) } }),
      );
      const pong = await resumed.waitForType("clock.pong");
      const newSeq = parseDecimalString(pong.seq);
      expect(newSeq).toBeGreaterThan(persistedWatermark);
      expect(newSeq).toBeGreaterThan(oldWatermark);
      resumed.close();
    } finally {
      await second.closeGracefully();
    }
  });

  it("resumeSessionId + lastAck=旧水位：无缺口时不发快照，直接 up-to-date 继续", async () => {
    const directory = createTempDataDirectory("bellis-p4-restart2-");
    directories.push(directory);

    const first = await forkHarness(directory);
    const token1 = await first.exchangeToken();
    const exchanged1 = await exchange(first.port, token1);
    const sessionId = exchanged1.sessionId as string;
    const client1 = controlClient(first.port, exchanged1.cookie as string, sessionId);
    await client1.waitForType("server.ready");
    client1.send(clientEnvelope({ sessionId, type: "clock.ping", payload: { c0: "1" } }));
    await client1.waitForType("clock.pong");
    const lastSeq = parseDecimalString((client1.received.at(-1) as ServerControlEnvelope).seq);
    await first.kill();
    client1.close();

    const second = await forkHarness(directory);
    try {
      const token2 = await second.exchangeToken();
      const exchanged2 = await exchange(second.port, token2, sessionId);
      expect(exchanged2.status).toBe(200);
      const resumed = controlClient(second.port, exchanged2.cookie as string, sessionId, lastSeq);
      // lastAck=旧水位：无缺口，不应出现 session.snapshot。
      await resumed.waitForType("server.ready");
      expect(resumed.received.some((envelope) => envelope.type === "session.snapshot")).toBe(false);
      resumed.send(clientEnvelope({ sessionId, type: "clock.ping", payload: { c0: "2" } }));
      const pong = await resumed.waitForType("clock.pong");
      // resume 后 hello/ready 消耗 Seq：首条业务消息只需严格大于旧水位。
      expect(parseDecimalString(pong.seq)).toBeGreaterThan(lastSeq);
      resumed.close();
    } finally {
      await second.closeGracefully();
    }
  });
});
