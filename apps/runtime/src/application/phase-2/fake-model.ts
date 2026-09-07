import { DecisionPacketSchema, type DecisionPacket } from "@bellis/contracts";

/**
 * Fake Model（docs/archive/phase-2/development-guide.md §9.1）。
 *
 * - 返回经 DecisionPacketSchema 运行期校验的**固定** DecisionPacket
 *  （Fixture 携带 sessionId/turnId/cycleId/sceneId/traceId，确定性重放）；
 * - 场景可配置：normal（Speech+Avatar）、silent（noOp）、invalid（返回
 *  非法包，服务按 rejected 处理）——不模拟真实 Provider 延迟；
 * - 不默认暴露生产 Fault Route：Fixture 由进程内 Demo/测试装配注入。
 */

export type FakeModelScenario = "normal" | "silent" | "invalid";

export interface FakeModelFixture {
  readonly cycleId: string;
  readonly traceId: string;
  readonly scenario: FakeModelScenario;
  readonly speech?: {
    readonly text: string;
    readonly purpose: DecisionPacket["action"]["sync"] extends never
      ? never
      : "answer" | "tool_notice" | "aside" | "reaction";
  };
  readonly motion?: string;
}

export interface FakeModelResult {
  readonly packet: DecisionPacket | null;
  readonly rejected: boolean;
}

const BASE_PACKET = {
  schemaVersion: 1,
  toolCalls: [],
  next: "finish",
} as const;

export function runFakeModel(fixture: FakeModelFixture): FakeModelResult {
  if (fixture.scenario === "invalid") {
    // 返回非法包（缺 action）：由 Schema 校验拒绝，不进入编译。
    const invalid = { ...BASE_PACKET, cycleId: fixture.cycleId } as unknown;
    const check = DecisionPacketSchema.safeParse(invalid);
    if (check.success) {
      return { packet: null, rejected: true };
    }
    return { packet: null, rejected: true };
  }
  if (fixture.scenario === "silent") {
    const packet = {
      ...BASE_PACKET,
      cycleId: fixture.cycleId,
      action: {
        schemaVersion: 1,
        sync: { schemaVersion: 1, hardLanes: [] },
        noOp: true,
      },
    };
    const check = DecisionPacketSchema.safeParse(packet);
    return check.success
      ? { packet: check.data, rejected: false }
      : { packet: null, rejected: true };
  }
  const speech = fixture.speech ?? {
    text: "我看看现在的任务进度",
    purpose: "tool_notice" as const,
  };
  const packet = {
    ...BASE_PACKET,
    cycleId: fixture.cycleId,
    action: {
      schemaVersion: 1,
      sync: { schemaVersion: 1, hardLanes: ["audio", "subtitle", "avatar"], softTimeoutMs: 100 },
      speech: {
        schemaVersion: 1,
        text: speech.text,
        purpose: speech.purpose,
        interruptible: true,
      },
      avatar: [
        {
          schemaVersion: 1,
          intentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          motion: fixture.motion ?? "nod_agree",
          channels: ["head", "body"],
          priority: 80,
          durationMs: 1200,
          interruptible: true,
          exclusive: false,
          mutexTags: [],
        },
      ],
    },
  };
  const check = DecisionPacketSchema.safeParse(packet);
  return check.success ? { packet: check.data, rejected: false } : { packet: null, rejected: true };
}
