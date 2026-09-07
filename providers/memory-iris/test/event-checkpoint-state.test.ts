import { expect, it } from "vitest";
import { parseAdapterState } from "../src/state-store.js";

const empty = { version: 1, sourceCursors: {}, personaCache: {}, pending: [] };
it("validates paired event checkpoints while retaining legacy cursor-only state without invented identity", () => {
  expect(parseAdapterState({ ...empty, eventCursor: "9" })).not.toHaveProperty("eventId");
  expect(parseAdapterState({ ...empty, eventCursor: "9", eventId: "event:9" })).toMatchObject({
    eventCursor: "9",
    eventId: "event:9",
  });
  for (const checkpoint of [
    { eventId: "event" },
    { eventCursor: "0", eventId: "event" },
    { eventCursor: "9", eventId: "" },
    { eventCursor: "9", eventId: "\n" },
    { eventCursor: "9", eventId: "a".repeat(513) },
    { eventCursor: "9223372036854775808", eventId: "event" },
  ])
    expect(() => parseAdapterState({ ...empty, ...checkpoint })).toThrow("recovery state");
});

it("requires a persisted history gap to describe the exact saved checkpoint and Iris provider", () => {
  const gap = {
    schemaVersion: 1,
    providerId: "iris",
    agentId: "agent",
    gapId: "a".repeat(64),
    reason: "history_unavailable",
    cursor: "9",
    eventId: "event:9",
  };
  const state = { ...empty, eventCursor: "9", eventId: "event:9", historyGap: gap };
  expect(parseAdapterState(state).historyGap).toEqual(gap);
  for (const change of [{ cursor: "8" }, { eventId: "different" }, { providerId: "other" }])
    expect(() => parseAdapterState({ ...state, historyGap: { ...gap, ...change } })).toThrow();
});
