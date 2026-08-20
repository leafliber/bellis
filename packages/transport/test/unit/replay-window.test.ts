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
});
