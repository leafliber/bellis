import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { ActionFrame, StageCapabilities } from "@bellis/contracts";
import { PHASE_2_PCM_CONTENT_TYPE } from "@bellis/contracts";
import { compileActionFrame, validateScenePlan } from "../../src/index.js";

/** 性质测试（docs/archive/phase-2/development-guide.md §6.4）：
 * - 相同输入重放结果一致（确定性编译）；
 * - 编译产物恒通过 ScenePlanSchema；
 * - noop 帧恒为 noop，不伪造 Scene。
 */

const CAPABILITIES: StageCapabilities = {
  schemaVersion: 1,
  audio: { contentTypes: [PHASE_2_PCM_CONTENT_TYPE], maxBufferedUs: "2000000" },
  subtitle: { supported: true },
  avatar: { adapter: "fake", motions: ["nod_agree", "wave"], expressions: ["happy"] },
};

const speechArb = fc.record({
  schemaVersion: fc.constant(1),
  text: fc.string({ minLength: 1, maxLength: 60 }),
  purpose: fc.constantFrom("answer", "tool_notice", "aside", "reaction"),
  interruptible: fc.boolean(),
});

const avatarArb = fc
  .record({
    schemaVersion: fc.constant(1),
    intentId: fc.uuid(),
    motion: fc.constantFrom("nod_agree", "wave"),
    channels: fc.constantFrom(["head", "body"], ["expression"]),
    priority: fc.integer({ min: 0, max: 100 }),
    durationMs: fc.integer({ min: 0, max: 60_000 }),
    interruptible: fc.boolean(),
    exclusive: fc.boolean(),
    mutexTags: fc.constant<string[]>([]),
  })
  .map((base) => ({
    ...base,
    channels: [...base.channels],
  }));

const frameArb: fc.Arbitrary<ActionFrame> = fc
  .record({
    speech: fc.option(speechArb, { nil: undefined }),
    avatar: fc.option(fc.array(avatarArb, { minLength: 1, maxLength: 8 }), { nil: undefined }),
    interruptibleAll: fc.boolean(),
  })
  .filter((seed) => seed.speech !== undefined || seed.avatar !== undefined)
  .map((seed) => {
    const frame: Record<string, unknown> = {
      schemaVersion: 1,
      sync: {
        schemaVersion: 1,
        hardLanes: seed.speech !== undefined ? ["audio", "subtitle", "avatar"] : [],
      },
    };
    if (seed.speech !== undefined) {
      frame.speech = seed.interruptibleAll ? seed.speech : { ...seed.speech, interruptible: false };
    }
    if (seed.avatar !== undefined) {
      frame.avatar = seed.interruptibleAll
        ? seed.avatar
        : seed.avatar.map((intent) => ({ ...intent, interruptible: false }));
    }
    return frame as ActionFrame;
  });

class CounterSource {
  #next = 0;
  nextId(): string {
    const id = this.#next;
    this.#next += 1;
    return `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`;
  }
}

describe("compileActionFrame 性质", () => {
  it("相同输入重放结果逐字节一致（确定性）", () => {
    fc.assert(
      fc.property(frameArb, (frame) => {
        const run = (): unknown =>
          compileActionFrame({
            frame,
            cycleId: "33333333-3333-4333-8333-333333333333",
            capabilities: CAPABILITIES,
            ids: {
              nextId: (() => {
                const source = new CounterSource();
                return () => source.nextId();
              })(),
            },
          });
        expect(JSON.stringify(run())).toBe(JSON.stringify(run()));
      }),
      { numRuns: 150 },
    );
  });

  it("编译产物恒通过 ScenePlanSchema 与结构不变量", () => {
    fc.assert(
      fc.property(frameArb, (frame) => {
        const result = compileActionFrame({
          frame,
          cycleId: "33333333-3333-4333-8333-333333333333",
          capabilities: CAPABILITIES,
          ids: {
            nextId: (() => {
              const source = new CounterSource();
              return () => source.nextId();
            })(),
          },
        });
        if (result.kind === "scene") {
          expect(validateScenePlan(result.plan).ok).toBe(true);
          expect(result.plan.cues.length).toBeGreaterThanOrEqual(1);
        }
        expect(["noop", "scene", "rejected"]).toContain(result.kind);
      }),
      { numRuns: 150 },
    );
  });

  it("noOp 帧恒为 noop", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1000 }), (seed) => {
        const result = compileActionFrame({
          frame: { schemaVersion: 1, sync: { schemaVersion: 1, hardLanes: [] }, noOp: true },
          cycleId: `seed-${seed}`,
          capabilities: CAPABILITIES,
          ids: { nextId: () => "x" },
        });
        expect(result.kind).toBe("noop");
      }),
      { numRuns: 50 },
    );
  });

  it("拒绝结果的 issue 码恒属于闭合集合", () => {
    fc.assert(
      fc.property(frameArb, (frame) => {
        const result = compileActionFrame({
          frame,
          cycleId: "33333333-3333-4333-8333-333333333333",
          capabilities: {
            ...CAPABILITIES,
            subtitle: { supported: false },
            avatar: { ...CAPABILITIES.avatar, motions: [] },
          },
          ids: { nextId: () => "x" },
        });
        if (result.kind === "rejected") {
          for (const issue of result.issues) {
            expect([
              "cue_limit_exceeded",
              "hard_lane_unsatisfiable",
              "capability_missing",
              "anchor_unresolved",
              "lane_conflict",
              "plan_invalid",
            ]).toContain(issue.code);
          }
        }
      }),
      { numRuns: 100 },
    );
  });
});
