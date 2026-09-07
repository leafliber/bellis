import type { ContextCategory } from "@bellis/contracts/memory";
import { describe, expect, it } from "vitest";

import {
  CORE_CATEGORY_VOCABULARY,
  CORE_RESOURCE_TYPES,
  deriveContextCategory,
} from "../src/mapping.js";

/**
 * Pinned independently of `src/mapping.ts` on purpose: this is the contract with
 * Core, not a restatement of our own table. Sources in iris_memory_core 0.11.0:
 *
 *   - claim        `ClaimView.category` enum (schemas/openapi/openapi.json)
 *   - focus_item   `FocusView.kind` enum
 *   - note         `NoteView.kind` enum
 *   - task         `application/recall.py` DueTaskRoute, literal "task"
 *   - relation     RelationsRoute / GraphRoute edges, literal "relationship"
 *   - episode      `_canonical_projection_row`, literal "episode"
 *   - observation  RecentContextRoute leaves `category` unset, so
 *                  `_rank_and_trim` falls back to the route name "recent_context"
 *   - state_record StateRoute likewise falls back to "state"
 *
 * Re-verify against Core before widening the compatibility matrix.
 */
const CORE_WIRE_CATEGORIES: Readonly<Record<string, readonly string[]>> = {
  claim: [
    "identity",
    "preference",
    "relationship",
    "fact",
    "community",
    "procedure",
    "self_narrative",
  ],
  episode: ["episode"],
  focus_item: ["goal", "question", "entity", "clue", "concern", "affect", "pending_input"],
  note: ["important", "idea", "follow_up", "promise", "question", "observation"],
  observation: ["recent_context"],
  relation: ["relationship"],
  state_record: ["state"],
  task: ["task"],
};

describe("Core candidate vocabulary", () => {
  it("declares exactly the resource types Core can emit", () => {
    expect([...CORE_RESOURCE_TYPES].toSorted()).toEqual(
      Object.keys(CORE_WIRE_CATEGORIES).toSorted(),
    );
  });

  it("mirrors Core's per-resource category vocabulary", () => {
    for (const [resourceType, categories] of Object.entries(CORE_WIRE_CATEGORIES)) {
      expect([...(CORE_CATEGORY_VOCABULARY[resourceType] ?? [])].toSorted()).toEqual(
        [...categories].toSorted(),
      );
    }
  });

  it("maps every value Core can emit — nothing is silently dropped", () => {
    const unmapped: string[] = [];
    for (const [resourceType, categories] of Object.entries(CORE_WIRE_CATEGORIES)) {
      for (const category of categories) {
        if (deriveContextCategory(resourceType, category) === undefined) {
          unmapped.push(`${resourceType}/${category}`);
        }
      }
    }
    expect(unmapped).toEqual([]);
  });

  it("splits relationship claims out of the plain fact bucket", () => {
    expect(deriveContextCategory("claim", "relationship")).toBe("relationship");
    expect(deriveContextCategory("claim", "identity")).toBe("fact");
    expect(deriveContextCategory("relation", "relationship")).toBe("relationship");
  });

  it("routes episodic sources to episode and due work to task", () => {
    expect(deriveContextCategory("observation", "recent_context")).toBe("episode");
    expect(deriveContextCategory("episode", "episode")).toBe("episode");
    expect(deriveContextCategory("task", "task")).toBe("task");
  });

  it("keeps mapping a known resource type whose category is new to us", () => {
    // Core adds categories additively; an unknown kind under a known resource
    // type must still reach the host, flagged rather than dropped.
    expect(deriveContextCategory("note", "kind_added_in_a_later_core")).toBe("fact");
  });

  it("fails closed only on an unknown resource type", () => {
    expect(deriveContextCategory("resource_type_added_later", "anything")).toBeUndefined();
  });

  it("does not let overrides admit unknown resources or manufacture viewer identity", () => {
    expect(deriveContextCategory("future", "fact", { fact: "fact" })).toBeUndefined();
    expect(deriveContextCategory("claim", "identity", { identity: "viewer" })).toBeUndefined();
    expect(deriveContextCategory("__proto__", "constructor")).toBeUndefined();
  });

  it("lets an operator override a single category without touching the table", () => {
    const overrides: Record<string, ContextCategory> = { follow_up: "task" };
    expect(deriveContextCategory("note", "follow_up", overrides)).toBe("task");
    expect(deriveContextCategory("note", "idea", overrides)).toBe("fact");
  });

  it("never derives viewer, which only the host identity domain can decide", () => {
    const produced = new Set<ContextCategory | undefined>();
    for (const [resourceType, categories] of Object.entries(CORE_WIRE_CATEGORIES)) {
      for (const category of categories) {
        produced.add(deriveContextCategory(resourceType, category));
      }
    }
    expect(produced.has("viewer")).toBe(false);
  });
});
