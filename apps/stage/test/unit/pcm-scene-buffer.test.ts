import { describe, expect, it } from "vitest";
import { PcmSceneBuffer } from "../../src/lanes/audio/pcm-scene-buffer.js";

/** PCM 场景缓冲：下越静音、代际原子切换、取消只清目标 Scene。 */

function samplesOf(value: number, count: number): Int16Array {
  const array = new Int16Array(count);
  array.fill(value);
  return array;
}

describe("PcmSceneBuffer", () => {
  it("Commit 前数据不发声（无活动 Scene 输出静音）", () => {
    const buffer = new PcmSceneBuffer();
    buffer.appendFrame("s1", samplesOf(1000, 480));
    const out = new Int16Array(960);
    buffer.pull(out, 960);
    expect(out.every((v) => v === 0)).toBe(true);
  });

  it("switchScene 后按序读取；读尽下越输出静音并计数，不复用旧样本", () => {
    const buffer = new PcmSceneBuffer();
    buffer.appendFrame("s1", samplesOf(1000, 480));
    buffer.appendFrame("s1", samplesOf(2000, 480));
    buffer.switchScene("s1");
    const out = new Int16Array(480);
    expect(buffer.pull(out, 480)).toBe(480);
    expect(out.every((v) => v === 1000)).toBe(true);
    expect(buffer.pull(out, 480)).toBe(480);
    expect(out.every((v) => v === 2000)).toBe(true);
    // 下越：静音 + 计数。
    expect(buffer.pull(out, 480)).toBe(480);
    expect(out.every((v) => v === 0)).toBe(true);
    expect(buffer.underrunCount("s1")).toBe(1);
    // 补充新帧后继续顺序读，不回头复读。
    buffer.appendFrame("s1", samplesOf(3000, 480));
    expect(buffer.pull(out, 480)).toBe(480);
    expect(out.every((v) => v === 3000)).toBe(true);
  });

  it("取消目标 Scene：淡出后静音；其他 Scene 不受影响", () => {
    const buffer = new PcmSceneBuffer();
    buffer.appendFrame("s1", samplesOf(1000, 4800));
    buffer.appendFrame("s2", samplesOf(5000, 4800));
    buffer.switchScene("s1");
    buffer.cancelScene("s1", 240);
    const out = new Int16Array(4800);
    buffer.pull(out, 4800);
    // 前 240 样本线性淡出（非满幅），其后静音。
    expect(out[0]!).toBe(1000); // factor=1 起点
    expect(out[120]!).toBeLessThan(1000);
    expect(out[240]!).toBe(0);
    // s2 完好：切换后正常读。
    buffer.switchScene("s2");
    const out2 = new Int16Array(4800);
    buffer.pull(out2, 4800);
    expect(out2.every((v) => v === 5000)).toBe(true);
  });

  it("容量上限：超限帧拒绝", () => {
    const buffer = new PcmSceneBuffer({ maxBufferedUs: 20_000n }); // 960 样本
    expect(buffer.appendFrame("s", samplesOf(1, 480))).toBe(true);
    expect(buffer.appendFrame("s", samplesOf(1, 480))).toBe(true);
    expect(buffer.appendFrame("s", samplesOf(1, 480))).toBe(false);
  });

  it("releaseScene 释放并复位活动指针", () => {
    const buffer = new PcmSceneBuffer();
    buffer.appendFrame("s1", samplesOf(1, 480));
    buffer.switchScene("s1");
    buffer.releaseScene("s1");
    expect(buffer.activeScene).toBeNull();
    const out = new Int16Array(480);
    buffer.pull(out, 480);
    expect(out.every((v) => v === 0)).toBe(true);
  });

  it("EOS：放完剩余样本后恰好一次报告耗尽，其后静音不计下越", () => {
    const buffer = new PcmSceneBuffer();
    buffer.appendFrame("s1", samplesOf(1000, 480));
    buffer.appendFrame("s1", samplesOf(2000, 480));
    buffer.switchScene("s1");
    // EOS 在第一帧已放、第二帧未放时到达：不立即耗尽。
    const out = new Int16Array(480);
    buffer.pull(out, 480);
    expect(buffer.endScene("s1")).toBe(false);
    expect(buffer.drainEndedScenes()).toEqual([]);
    // 放完第二帧：恰好一次耗尽报告。
    buffer.pull(out, 480);
    expect(out.every((v) => v === 2000)).toBe(true);
    expect(buffer.drainEndedScenes()).toEqual(["s1"]);
    // EOS 后静音是预期尾态：不累计下越、不重复报告。
    buffer.pull(out, 480);
    expect(out.every((v) => v === 0)).toBe(true);
    expect(buffer.underrunCount("s1")).toBe(0);
    expect(buffer.drainEndedScenes()).toEqual([]);
  });

  it("EOS：无样本或已放完 → 立即耗尽；EOS 后拒绝追加", () => {
    const buffer = new PcmSceneBuffer();
    expect(buffer.endScene("never-seen")).toBe(true); // 无样本
    buffer.appendFrame("s1", samplesOf(1000, 480));
    buffer.switchScene("s1");
    const out = new Int16Array(480);
    buffer.pull(out, 480);
    expect(buffer.endScene("s1")).toBe(true); // 已放完
    expect(buffer.drainEndedScenes()).toEqual(["s1"]);
    expect(buffer.appendFrame("s1", samplesOf(1, 480))).toBe(false); // EOS 后拒绝
  });
});
