import { expect, it } from "vitest";
import { MemoryHistoryGapSchema } from "../src/memory/history-gap.js";

it("bounds the trusted gap receipt and refuses unknown fields and malformed checkpoint identities", () => {
  const gap = {
    schemaVersion: 1,
    providerId: "iris",
    agentId: "agent",
    gapId: "a".repeat(64),
    reason: "history_unavailable",
    cursor: "7",
    eventId: "event:7",
  };
  expect(MemoryHistoryGapSchema.parse(gap)).toEqual(gap);
  for (const change of [
    { cursor: "07" },
    { cursor: "-1" },
    { cursor: "9".repeat(31) },
    { eventId: "event\n7" },
    { eventId: "x".repeat(513) },
    { providerId: "x".repeat(129) },
    { agentId: "x".repeat(257) },
    { gapId: "x".repeat(64) },
    { reason: "privacy_revoked" },
    { clear: true },
  ])
    expect(MemoryHistoryGapSchema.safeParse({ ...gap, ...change }).success).toBe(false);
  const { eventId: _eventId, ...legacy } = gap;
  expect(
    MemoryHistoryGapSchema.parse({ ...legacy, reason: "checkpoint_missing" }),
  ).not.toHaveProperty("eventId");
});
