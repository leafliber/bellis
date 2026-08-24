import { describe, expect, it } from "vitest";
import { PrepareBarrier } from "../../src/index.js";
import type { SyncGroup } from "@bellis/contracts";

const GROUPS: readonly SyncGroup[] = [
  {
    schemaVersion: 1,
    groupId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    lanes: ["audio", "subtitle"],
    level: "hard",
  },
  {
    schemaVersion: 1,
    groupId: "dddddddd-dddd-4ddd-8ddd-ddddddddddde",
    lanes: ["avatar"],
    level: "soft",
  },
];

function makeBarrier(): PrepareBarrier {
  return new PrepareBarrier({ groups: GROUPS, softTimeoutUs: 500_000n });
}

describe("PrepareBarrier", () => {
  it("hard 未全部报告 → pending；soft 未报告不阻塞（超时后）", () => {
    const barrier = makeBarrier();
    barrier.reportLane({ lane: "audio", status: "ready", cueIds: [] });
    expect(barrier.judge(0n, 0n)).toEqual({ verdict: "pending" });
    // soft 超时但 hard 缺 subtitle：仍 pending。
    expect(barrier.judge(600_000n, 0n)).toEqual({ verdict: "pending" });
  });

  it("hard 全 ready → 等 soft 到超时后 ready；soft 缺席被记录", () => {
    const barrier = makeBarrier();
    barrier.reportLane({ lane: "audio", status: "ready", cueIds: [] });
    barrier.reportLane({ lane: "subtitle", status: "ready", cueIds: [] });
    // hard 全部就绪但 soft（avatar）未报告且未超时：继续等待。
    expect(barrier.judge(0n, 0n)).toEqual({ verdict: "pending" });
    // soft 超时后结算：缺席被记录，不阻塞。
    const verdict = barrier.judge(500_000n, 0n);
    expect(verdict.verdict).toBe("ready");
    if (verdict.verdict === "ready") {
      expect(verdict.absentLanes).toEqual(["avatar"]);
      expect(verdict.unavailable).toHaveLength(0);
    }
  });

  it("soft lane 全部报告：无需等到超时即可 ready", () => {
    const barrier = makeBarrier();
    barrier.reportLane({ lane: "audio", status: "ready", cueIds: [] });
    barrier.reportLane({ lane: "subtitle", status: "ready", cueIds: [] });
    barrier.reportLane({
      lane: "avatar",
      status: "unavailable",
      reason: "adapter_error",
      cueIds: [],
    });
    const verdict = barrier.judge(0n, 0n);
    expect(verdict.verdict).toBe("ready");
    if (verdict.verdict === "ready") {
      expect(verdict.absentLanes).toEqual(["avatar"]);
      expect(verdict.unavailable[0]?.lane).toBe("avatar");
    }
  });

  it("hard unavailable → hard_unavailable（整组失败，不因 soft 状态改变）", () => {
    const barrier = makeBarrier();
    barrier.reportLane({ lane: "audio", status: "ready", cueIds: [] });
    barrier.reportLane({
      lane: "subtitle",
      status: "unavailable",
      reason: "audio_not_armed",
      cueIds: [],
    });
    barrier.reportLane({ lane: "avatar", status: "ready", cueIds: [] });
    const verdict = barrier.judge(0n, 0n);
    expect(verdict.verdict).toBe("hard_unavailable");
    if (verdict.verdict === "hard_unavailable") {
      expect(verdict.lanes).toHaveLength(1);
      expect(verdict.lanes[0]?.lane).toBe("subtitle");
    }
  });

  it("force 判定：未报告的 hard lane 视为不可用（bulk 上报后）", () => {
    const barrier = makeBarrier();
    barrier.reportLane({ lane: "audio", status: "ready", cueIds: [] });
    const verdict = barrier.judge(0n, 0n, { force: true });
    expect(verdict.verdict).toBe("hard_unavailable");
    if (verdict.verdict === "hard_unavailable") {
      expect(verdict.missingHardLanes).toEqual(["subtitle"]);
    }
  });

  it("同一判定是纯函数：相同快照 + nowUs 恒同结果", () => {
    const barrier = makeBarrier();
    barrier.reportLane({ lane: "audio", status: "ready", cueIds: [] });
    barrier.reportLane({ lane: "subtitle", status: "ready", cueIds: [] });
    expect(barrier.judge(123n, 0n)).toEqual(barrier.judge(123n, 0n));
  });

  it("detached 组不参与等待；未知 Lane 上报被忽略", () => {
    const detached: readonly SyncGroup[] = [
      {
        schemaVersion: 1,
        groupId: "dddddddd-dddd-4ddd-8ddd-dddddddddddf",
        lanes: ["overlay"],
        level: "detached",
      },
    ];
    const barrier = new PrepareBarrier({ groups: detached, softTimeoutUs: 100n });
    // 无 hard/soft lane：立即结算，detached 未报告不阻塞。
    expect(barrier.judge(0n, 0n).verdict).toBe("ready");
    barrier.reportLane({ lane: "game", status: "ready", cueIds: [] });
    barrier.reportLane({ lane: "overlay", status: "unavailable", reason: "x", cueIds: [] });
    const verdict = barrier.judge(0n, 0n);
    expect(verdict.verdict).toBe("ready");
  });
});
