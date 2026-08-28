import { describe, expect, it } from "vitest";
import { VirtualClock } from "@bellis/testkit";
import { createDeterministicIdSource } from "@bellis/testkit";
import { ClockOffsetEstimator } from "@bellis/transport/browser";
import { CueTimeline } from "../../src/timeline/cue-timeline.js";

/** Timeline 纯逻辑：映射、迟到容忍、取消与关闭（VirtualClock 驱动）。 */

function estimate(offsetUs: bigint) {
  const estimator = new ClockOffsetEstimator();
  // 通过一个 RTT=0 样本注入已知偏移：c0=0, r1=offset, r2=offset, c3=0。
  estimator.add({ c0: 0n, r1: offsetUs, r2: offsetUs, c3: 0n });
  return estimator.current()!;
}

describe("CueTimeline", () => {
  it("Runtime 时刻经 Offset Estimate 映射为本地时刻", () => {
    const clock = new VirtualClock();
    const timeline = new CueTimeline(clock);
    const est = estimate(250_000n);
    expect(timeline.mapRuntimeToLocal(1_000_000n, est)).toBe(750_000n);
  });

  it("目标时刻到达触发；critical 迟到仍触发并标记，非 critical 超容忍丢弃", async () => {
    const clock = new VirtualClock();
    const timeline = new CueTimeline(clock, { lateToleranceUs: 50_000n });
    const events: string[] = [];
    timeline.schedule("scene-1", 1_000_000n, [
      { lane: "audio", critical: true, fire: (info) => events.push(`audio:${info.late}`) },
      { lane: "subtitle", critical: false, fire: (info) => events.push(`subtitle:${info.late}`) },
    ]);
    // 一次推进到容忍窗口内：两者都正常触发。
    clock.advanceBy(1_040_000n);
    await Promise.resolve();
    expect(events).toEqual(["audio:false", "subtitle:false"]);
    expect(timeline.droppedLateCues).toBe(0);

    const events2: string[] = [];
    timeline.schedule("scene-2", 2_000_000n, [
      { lane: "audio", critical: true, fire: (info) => events2.push(`audio:${info.late}`) },
      { lane: "subtitle", critical: false, fire: (info) => events2.push(`subtitle:${info.late}`) },
    ]);
    // 长任务：越过容忍窗口。critical 触发且 late=true；非 critical 丢弃不补播。
    clock.advanceBy(1_200_000n);
    await Promise.resolve();
    await Promise.resolve();
    expect(events2).toEqual(["audio:true"]);
    expect(timeline.droppedLateCues).toBe(1);
  });

  it("整组取消后不触发；关闭后拒绝新调度并取消全部在途项", async () => {
    const clock = new VirtualClock();
    const timeline = new CueTimeline(clock);
    const fired: string[] = [];
    const scheduled = timeline.schedule("scene-3", 1_000_000n, [
      { lane: "audio", critical: true, fire: () => fired.push("audio") },
    ]);
    scheduled.cancel();
    clock.advanceBy(1_100_000n);
    await Promise.resolve();
    expect(fired).toEqual([]);

    timeline.schedule("scene-4", 2_000_000n, [
      { lane: "subtitle", critical: false, fire: () => fired.push("subtitle") },
    ]);
    timeline.close();
    clock.advanceBy(2_100_000n);
    await Promise.resolve();
    expect(fired).toEqual([]);
    expect(() =>
      timeline.schedule("scene-5", 3_000_000n, [
        { lane: "audio", critical: true, fire: () => fired.push("late") },
      ]),
    ).toThrow(/cue_timeline_closed/);
  });

  it("单 Scene 调度项有上限", () => {
    const clock = new VirtualClock();
    const timeline = new CueTimeline(clock, { maxItemsPerScene: 2 });
    const items = [0, 1, 2].map((i) => ({
      lane: `lane-${i}`,
      critical: false,
      fire: () => {},
    }));
    expect(() => timeline.schedule("scene-6", 1n, items)).toThrow(/item_limit_reached/);
  });
});

describe("确定性 ID 源冒烟（测试装配）", () => {
  it("同种子同序列", () => {
    const a = createDeterministicIdSource("seed");
    const b = createDeterministicIdSource("seed");
    expect(a.uuid()).toBe(b.uuid());
  });
});
