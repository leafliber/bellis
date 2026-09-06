import { describe, expect, it } from "vitest";
import type { AudienceBatch } from "@bellis/contracts";
import { DecisionTrigger, mergeBatches } from "../../src/index.js";
import type { TurnOwnerPort } from "../../src/index.js";

function batch(from: number, to: number, urgent = false): AudienceBatch {
  return {
    schemaVersion: 1,
    id: `${from.toString(16).padStart(8, "0")}-cccc-4ccc-8ccc-cccccccccccc`,
    watermarkFrom: from.toString(10),
    watermarkTo: to.toString(10),
    highlights: [
      {
        schemaVersion: 1,
        signalId: `${from.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`,
        userId: "u1",
        text: `msg-${from}`,
      },
    ],
    topics: [],
    urgentSignals: urgent
      ? [
          {
            schemaVersion: 1,
            id: `${to.toString(16).padStart(8, "0")}-2222-4222-8222-222222222222`,
            kind: "moderator_command",
            source: "simulator",
            occurredAt: 0,
            priority: 900,
            payload: { text: "紧急" },
          },
        ]
      : [],
    tokenEstimate: 10,
  };
}

interface OwnerState {
  idle: boolean;
  canMerge: boolean;
  started: { batch: AudienceBatch; trigger: string }[];
  cancelled: AudienceBatch[];
  startAccepts: boolean;
}

function makeOwner(state: OwnerState): TurnOwnerPort {
  return {
    isIdle: () => state.idle,
    cancelActiveTurn: () => {
      state.idle = true;
      return state.cancelled.splice(0);
    },
    startTurn: (b, trigger) => {
      state.started.push({ batch: b, trigger });
      if (state.startAccepts) {
        state.idle = false;
      }
      return state.startAccepts;
    },
    mergeIntoNextCycle: () => state.canMerge,
  };
}

describe("DecisionTrigger", () => {
  it("idle + normal batch starts a turn", () => {
    const state: OwnerState = {
      idle: true,
      canMerge: false,
      started: [],
      cancelled: [],
      startAccepts: true,
    };
    const trigger = new DecisionTrigger({ owner: makeOwner(state) });
    trigger.submit(batch(1, 3));
    expect(state.started).toHaveLength(1);
    expect(state.started[0]?.trigger).toBe("normal_batch");
    expect(state.started[0]?.batch.watermarkFrom).toBe("1");
  });

  it("busy owner with mergeable turn merges into next cycle", () => {
    const state: OwnerState = {
      idle: false,
      canMerge: true,
      started: [],
      cancelled: [],
      startAccepts: true,
    };
    const trigger = new DecisionTrigger({ owner: makeOwner(state) });
    trigger.submit(batch(1, 3));
    expect(state.started).toHaveLength(0);
    expect(trigger.mailboxSize).toBe(0);
  });

  it("busy owner without merge goes to bounded FIFO and drains one turn per idle", () => {
    const state: OwnerState = {
      idle: false,
      canMerge: false,
      started: [],
      cancelled: [],
      startAccepts: true,
    };
    const trigger = new DecisionTrigger({ owner: makeOwner(state) });
    trigger.submit(batch(1, 1));
    trigger.submit(batch(2, 2));
    expect(trigger.mailboxSize).toBe(2);
    state.idle = true;
    trigger.notifyOwnerIdle();
    // 一次只启动一个 Turn（单一 Loop 所有权）。
    expect(state.started.map((entry) => entry.trigger)).toEqual(["next_turn"]);
    expect(trigger.mailboxSize).toBe(1);
    state.idle = true;
    trigger.notifyOwnerIdle();
    expect(state.started.map((entry) => entry.trigger)).toEqual(["next_turn", "next_turn"]);
    expect(trigger.mailboxSize).toBe(0);
  });

  it("does not merge into next cycle while FIFO is non-empty (adoption order = seal order)", () => {
    const state: OwnerState = {
      idle: false,
      canMerge: false,
      started: [],
      cancelled: [],
      startAccepts: true,
    };
    const trigger = new DecisionTrigger({ owner: makeOwner(state) });
    trigger.submit(batch(1, 1));
    state.canMerge = true;
    trigger.submit(batch(2, 2));
    // FIFO 非空：即使 owner 可合并也必须排队。
    expect(trigger.mailboxSize).toBe(2);
    expect(state.started).toHaveLength(0);
  });

  it("mailbox overflow merges oldest batches keeping interval union", () => {
    const state: OwnerState = {
      idle: false,
      canMerge: false,
      started: [],
      cancelled: [],
      startAccepts: true,
    };
    const trigger = new DecisionTrigger({
      owner: makeOwner(state),
      config: { mailboxCapacity: 2 },
    });
    trigger.submit(batch(1, 1));
    trigger.submit(batch(2, 2));
    trigger.submit(batch(3, 3));
    expect(trigger.mailboxSize).toBe(2);
    const first = trigger.peekMailbox()[0] as AudienceBatch;
    // 容量 2 触发合并：最旧两个合并为 [1..2]，保留 newer 身份。
    expect(first.watermarkFrom).toBe("1");
    expect(first.watermarkTo).toBe("2");
  });

  it("interrupt reclaims unadopted batches and merges them with the urgent batch", () => {
    const state: OwnerState = {
      idle: false,
      canMerge: false,
      started: [],
      cancelled: [batch(1, 2)],
      startAccepts: true,
    };
    const owner = makeOwner(state);
    const trigger = new DecisionTrigger({ owner });
    trigger.submit(batch(3, 3)); // FIFO [3..3]
    trigger.submit(batch(4, 6, true)); // urgent
    expect(state.started).toHaveLength(1);
    const interrupt = state.started[0]!;
    expect(interrupt.trigger).toBe("interrupt");
    // 区间并集：owner 未采用 [1..2] + FIFO [3..3] + urgent [4..6]。
    expect(interrupt.batch.watermarkFrom).toBe("1");
    expect(interrupt.batch.watermarkTo).toBe("6");
    expect(interrupt.batch.urgentSignals.length).toBe(1);
    expect(trigger.mailboxSize).toBe(0);
    expect(state.idle).toBe(false);
  });

  it("close drops subsequent submissions", () => {
    const state: OwnerState = {
      idle: true,
      canMerge: false,
      started: [],
      cancelled: [],
      startAccepts: true,
    };
    const trigger = new DecisionTrigger({ owner: makeOwner(state) });
    trigger.close();
    trigger.submit(batch(1, 1));
    expect(state.started).toHaveLength(0);
  });
});

describe("mergeBatches", () => {
  it("unions intervals, sums tokens, keeps newest highlights first", () => {
    const merged = mergeBatches(batch(1, 2), batch(3, 4, true));
    expect(merged.watermarkFrom).toBe("1");
    expect(merged.watermarkTo).toBe("4");
    expect(merged.tokenEstimate).toBe(20);
    expect(merged.urgentSignals).toHaveLength(1);
    expect(merged.highlights[0]?.text).toBe("msg-3");
  });
});

it("keeps repeated interrupts in the mailbox until the cancelling owner releases", () => {
  const state: OwnerState = {
    idle: false,
    canMerge: false,
    started: [],
    cancelled: [batch(1, 2)],
    startAccepts: true,
  };
  const trigger = new DecisionTrigger({
    owner: {
      ...makeOwner(state),
      cancelActiveTurn: () => state.cancelled.splice(0),
    },
  });
  trigger.submit(batch(3, 4));
  trigger.submit(batch(5, 5, true));
  trigger.submit(batch(6, 6, true));
  expect(state.started).toHaveLength(0);
  expect(trigger.mailboxSize).toBe(1);
  state.idle = true;
  trigger.notifyOwnerIdle();
  expect(state.started).toHaveLength(1);
  expect(state.started[0]?.trigger).toBe("interrupt");
  expect(state.started[0]?.batch.watermarkFrom).toBe("1");
  expect(state.started[0]?.batch.watermarkTo).toBe("6");
  expect(trigger.mailboxSize).toBe(0);
});
