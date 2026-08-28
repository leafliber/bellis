import { describe, expect, it } from "vitest";
import type { IngestedSignal, Signal } from "@bellis/contracts";
import { clusterSignals, normalizeText } from "../../src/index.js";

function ingested(id: string, text: string, userId: string, sequence: number): IngestedSignal {
  const signal: Signal = {
    schemaVersion: 1,
    id,
    kind: "danmaku",
    source: "simulator",
    occurredAt: 0,
    priority: 100,
    payload: { text, userId },
  };
  return {
    schemaVersion: 1,
    signalId: id,
    sequence: sequence.toString(10),
    priorityClass: "normal",
    receivedAtMs: 0,
    signal,
  };
}

describe("normalizeText", () => {
  it("normalizes punctuation, case and whitespace deterministically", () => {
    expect(normalizeText("冲！")).toBe(normalizeText("冲"));
    expect(normalizeText("  GO  go  ")).toBe(normalizeText("go go"));
    expect(normalizeText("ＡＢＣ")).toBe(normalizeText("abc"));
  });
});

describe("clusterSignals", () => {
  it("groups by normalized key with counts, participants and examples", () => {
    const result = clusterSignals(
      [
        ingested("11111111-1111-4111-8111-111111111111", "冲！", "u1", 1),
        ingested("22222222-2222-4222-8222-222222222222", "冲", "u2", 2),
        ingested("33333333-3333-4333-8333-333333333333", "打龙", "u1", 3),
      ],
      { maxHighlights: 100, maxTopics: 32, maxExamples: 10 },
    );
    expect(result.topics[0]).toMatchObject({ count: 2, participants: 2 });
    expect(result.highlights.length).toBe(3);
    // 冲！/冲 同组：两条 highlight 的权重都反映组占比 2/3。
    expect(result.highlights[0]?.weight).toBeCloseTo(2 / 3);
    expect(result.tokenEstimate).toBeGreaterThan(0);
  });

  it("keeps spam as audit facts while weight reflects the group", () => {
    const signals = [
      ingested("11111111-1111-4111-8111-111111111111", "666", "u1", 1),
      ingested("22222222-2222-4222-8222-222222222222", "666", "u1", 2),
      ingested("33333333-3333-4333-8333-333333333333", "666", "u1", 3),
      ingested("44444444-4444-4444-8444-444444444444", "别的", "u2", 4),
    ];
    const result = clusterSignals(signals, {
      maxHighlights: 100,
      maxTopics: 32,
      maxExamples: 10,
    });
    expect(result.highlights.length).toBe(4);
    const spamTopic = result.topics.find((topic) => topic.label === "666");
    expect(spamTopic).toMatchObject({ count: 3, participants: 1 });
  });

  it("caps highlights deterministically (keeps earliest) and topics by count", () => {
    const signals = Array.from({ length: 10 }, (_, index) =>
      ingested(
        `${index.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`,
        index % 2 === 0 ? "甲" : "乙",
        `u${index}`,
        index + 1,
      ),
    );
    const result = clusterSignals(signals, {
      maxHighlights: 3,
      maxTopics: 1,
      maxExamples: 2,
    });
    expect(result.highlights.map((message) => message.signalId)).toEqual([
      "00000000-0000-4000-8000-000000000000",
      "00000001-0000-4000-8000-000000000000",
      "00000002-0000-4000-8000-000000000000",
    ]);
    expect(result.truncatedHighlights).toBe(7);
    expect(result.topics.length).toBe(1);
    expect(result.topics[0]?.examples.length).toBeLessThanOrEqual(2);
  });

  it("ignores signals without string payload.text (gifts etc.)", () => {
    const gift: IngestedSignal = {
      schemaVersion: 1,
      signalId: "11111111-1111-4111-8111-111111111111",
      sequence: "1",
      priorityClass: "normal",
      receivedAtMs: 0,
      signal: {
        schemaVersion: 1,
        id: "11111111-1111-4111-8111-111111111111",
        kind: "gift",
        source: "simulator",
        occurredAt: 0,
        priority: 100,
        payload: { gift: "rocket" },
      },
    };
    const result = clusterSignals([gift], { maxHighlights: 10, maxTopics: 10, maxExamples: 10 });
    expect(result.highlights).toEqual([]);
    expect(result.topics).toEqual([]);
  });
});
