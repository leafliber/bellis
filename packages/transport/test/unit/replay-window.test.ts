import { describe, expect, it } from "vitest";
import { ReplayWindow } from "../../src/index.js";
import type { ReplayMessage } from "../../src/index.js";
import { MESSAGE_ID, serverText } from "../helpers.js";

function entry(seq: bigint): ReplayMessage {
  const text = serverText({ type: "server.ready" }, { seq: seq.toString() });
  return {
    seq,
    messageId: `${MESSAGE_ID.slice(0, -1)}${seq % 10n}`,
    text,
    envelope: JSON.parse(text),
    persistable: true,
  };
}

describe("ReplayWindow", () => {
  it("窗口内命中：按原 Seq 顺序返回 lastAck 之后的消息", () => {
    const window = new ReplayWindow({ capacity: 8 });
    for (const seq of [1n, 2n, 3n, 4n]) {
      window.append(entry(seq));
    }
    const outcome = window.replayAfter(2n);
    expect(outcome.status).toBe("replay");
    if (outcome.status === "replay") {
      expect(outcome.messages.map((message) => message.seq)).toEqual([3n, 4n]);
    }
  });

  it("lastAck 等于最新 Seq → up_to_date", () => {
    const window = new ReplayWindow({ capacity: 8 });
    window.append(entry(1n));
    expect(window.replayAfter(1n).status).toBe("up_to_date");
    // 超过已分配最大 Seq（1）属于协议错误。
    expect(window.replayAfter(5n).status).toBe("invalid_ahead");
  });

  it("空窗口的 lastAck=0 → up_to_date", () => {
    const window = new ReplayWindow();
    expect(window.replayAfter(0n).status).toBe("up_to_date");
  });

  it("lastAck 超过已分配最大 Seq → invalid_ahead", () => {
    const window = new ReplayWindow({ capacity: 8 });
    window.append(entry(1n));
    window.append(entry(2n));
    expect(window.replayAfter(3n).status).toBe("invalid_ahead");
  });

  it("容量淘汰造成缺口 → snapshot_required", () => {
    const window = new ReplayWindow({ capacity: 3 });
    for (const seq of [1n, 2n, 3n, 4n, 5n]) {
      window.append(entry(seq));
    }
    expect(window.oldestSeq()).toBe(3n);
    expect(window.replayAfter(1n).status).toBe("snapshot_required");
    // lastAck=2 恰好衔接窗口最旧条目（3）→ 命中重放。
    expect(window.replayAfter(2n).status).toBe("replay");
    expect(window.replayAfter(3n).status).toBe("replay");
  });

  it("pruneThrough 清理已确认条目但 latestAssignedSeq 不回退", () => {
    const window = new ReplayWindow({ capacity: 8 });
    for (const seq of [1n, 2n, 3n]) {
      window.append(entry(seq));
    }
    expect(window.pruneThrough(2n)).toBe(2);
    expect(window.oldestSeq()).toBe(3n);
    expect(window.latestAssignedSeq()).toBe(3n);
    // 已确认到 2，窗口仍保留未确认的 3 → 可重放；确认到 3 才是 up_to_date。
    expect(window.replayAfter(2n).status).toBe("replay");
    expect(window.replayAfter(3n).status).toBe("up_to_date");
  });

  it("append 非严格递增 Seq 抛出", () => {
    const window = new ReplayWindow();
    window.append(entry(1n));
    expect(() => window.append(entry(1n))).toThrow(RangeError);
    expect(() => window.append(entry(0n))).toThrow(RangeError);
  });

  it("接受十进制字符串形式的 lastAck", () => {
    const window = new ReplayWindow({ capacity: 4 });
    for (const seq of [1n, 2n]) {
      window.append(entry(seq));
    }
    expect(window.replayAfter("1").status).toBe("replay");
  });

  it("恢复时内部缺口（transient 被过滤）→ 请求区间碰缺口即 snapshot_required", () => {
    // P4 只持久化 persistable 条目：Seq 2（瞬时）缺失，水位仍是 3。
    const window = new ReplayWindow({ capacity: 8, initialLatestSeq: 3n });
    window.restore([entry(1n), entry(3n)]);
    // lastAck=1 请求 (1,3]：缺 2 → 不能只回放 3，否则累计 ACK 无法推进。
    expect(window.replayAfter(1n).status).toBe("snapshot_required");
    expect(window.replayAfter(0n).status).toBe("snapshot_required");
    // lastAck=3 无需回放；lastAck=2 表示客户端重启前已收到瞬时 2。
    expect(window.replayAfter(3n).status).toBe("up_to_date");
    window.pruneThrough(2n);
    expect(window.replayAfter(2n).status).toBe("replay");
  });

  it("恢复时尾部缺口（水位高于最后条目）→ snapshot_required 而非空重放", () => {
    const window = new ReplayWindow({ capacity: 8, initialLatestSeq: 2n });
    window.restore([entry(1n)]);
    // 旧实现返回空 replay 列表；正确语义是缺口 → snapshot。
    expect(window.replayAfter(1n).status).toBe("snapshot_required");
    expect(window.replayAfter(2n).status).toBe("up_to_date");
    expect(window.replayAfter(3n).status).toBe("invalid_ahead");
  });

  it("pruneThrough 截断缺口：客户端确认覆盖缺口后可继续重放", () => {
    const window = new ReplayWindow({ capacity: 8, initialLatestSeq: 4n });
    window.restore([entry(1n), entry(2n), entry(4n)]);
    expect(window.replayAfter(2n).status).toBe("snapshot_required");
    // 确认到 3 = 重启前已完整收到 3（含瞬时消息），缺口不再是缺口。
    window.pruneThrough(3n);
    const outcome = window.replayAfter(3n);
    expect(outcome.status).toBe("replay");
    if (outcome.status === "replay") {
      expect(outcome.messages.map((message) => message.seq)).toEqual([4n]);
    }
  });

  it("append 跳号防御性记录缺口（正常路径不会发生）", () => {
    const window = new ReplayWindow({ capacity: 8 });
    window.append(entry(1n));
    window.append(entry(3n));
    expect(window.replayAfter(1n).status).toBe("snapshot_required");
    expect(window.replayAfter(2n).status).toBe("replay");
  });

  it("空恢复 + 水位：全部确认过的会话不误报", () => {
    const window = new ReplayWindow({ capacity: 8, initialLatestSeq: 5n });
    window.restore([]);
    expect(window.replayAfter(5n).status).toBe("up_to_date");
    expect(window.replayAfter(4n).status).toBe("snapshot_required");
  });
});
