import type { ContextBlock, ContextCategory, MemoryQuery } from "@bellis/contracts/memory";
import type { RecallCandidate, RecallResponse } from "@iris-memory/sdk";

export const MAPPING_VERSION = 1;
export const PRIORITY_DERIVATION_VERSION = 1;

/**
 * Core publishes `RecallCandidate.category` as `candidate.category or candidate.route`
 * (`application/recall.py` `_rank_and_trim`), so a single wire field carries four
 * unrelated Core vocabularies: claim categories, focus item kinds, note kinds, and —
 * for the two routes that leave `category` unset — the route name itself.
 *
 * That makes `category` alone an unsafe mapping key: `question` is both a focus kind
 * and a note kind, and the union has 23 members against the host's 5. Keying on
 * `resource_ref.resource_type` instead gives a small, structural, stable vocabulary
 * that disambiguates the collisions. `category` is retained verbatim in
 * `providerCategory` so the host keeps the full source semantics.
 */
export const CORE_RESOURCE_TYPES = [
  "claim",
  "episode",
  "focus_item",
  "note",
  "observation",
  "relation",
  "state_record",
  "task",
] as const;

/** Every `category` value Core 0.11.0 can put on the wire, grouped by its origin. */
export const CORE_CATEGORY_VOCABULARY: Readonly<Record<string, readonly string[]>> = {
  // ClaimView.category
  claim: [
    "identity",
    "preference",
    "relationship",
    "fact",
    "community",
    "procedure",
    "self_narrative",
  ],
  // FocusView.kind
  focus_item: ["goal", "question", "entity", "clue", "concern", "affect", "pending_input"],
  // NoteView.kind
  note: ["important", "idea", "follow_up", "promise", "question", "observation"],
  episode: ["episode"],
  task: ["task"],
  relation: ["relationship"],
  // Routes that leave `category` unset fall back to the route name.
  observation: ["recent_context"],
  state_record: ["state"],
};

/**
 * `resource_type` -> host category. Deterministic and total over
 * `CORE_RESOURCE_TYPES`; the single per-category exception is the `relationship`
 * claim, which the host models as its own bucket rather than a plain fact.
 *
 * `viewer` is intentionally never produced: deciding that a block is about the
 * current viewer requires resolving `subject_entity_id` against the host identity
 * domain, which ADR-0020 §3 keeps at the audit boundary and Bellis ADR 0005 §2.4
 * reserves to the host. Guessing it from a claim category would mislabel identity
 * facts about third parties, so the adapter leaves that refinement to the host.
 */
const RESOURCE_TYPE_CATEGORY: Readonly<Record<string, ContextCategory>> = {
  claim: "fact",
  episode: "episode",
  focus_item: "fact",
  note: "fact",
  observation: "episode",
  relation: "relationship",
  state_record: "fact",
  task: "task",
};

export function deriveContextCategory(
  resourceType: string,
  category: string,
  overrides: Readonly<Record<string, ContextCategory>> = {},
): ContextCategory | undefined {
  const override = overrides[category];
  if (override !== undefined) return override;
  if (resourceType === "claim" && category === "relationship") return "relationship";
  return RESOURCE_TYPE_CATEGORY[resourceType];
}

function timestampMs(value: string | null | undefined): number | undefined {
  if (value == null) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function earliestTimestampMs(...values: Array<string | null | undefined>): number | undefined {
  const parsed = values.map(timestampMs).filter((item): item is number => item !== undefined);
  return parsed.length === 0 ? undefined : Math.min(...parsed);
}

function sourceRefUrn(ref: Readonly<Record<string, unknown>>): string | undefined {
  const type = ref.resource_type;
  const id = ref.resource_id;
  const revision = ref.revision;
  if (typeof type !== "string" || type.length === 0 || typeof id !== "string" || id.length === 0) {
    return undefined;
  }
  return `iris:${encodeURIComponent(type)}:${encodeURIComponent(id)}${
    Number.isInteger(revision) && Number(revision) >= 1 ? `@${String(revision)}` : ""
  }`;
}

export interface CandidateMappingResult {
  readonly block?: ContextBlock;
  readonly dropped: boolean;
  /** Set when the block was kept but its `category` is outside the known vocabulary. */
  readonly unknownProviderCategory?: string;
}

export function mapRecallCandidate(
  candidate: RecallCandidate,
  index: number,
  candidateCount: number,
  query: MemoryQuery,
  response: RecallResponse,
  categoryOverrides: Readonly<Record<string, ContextCategory>> = {},
): CandidateMappingResult {
  const resourceType = candidate.resource_ref.resource_type;
  const category = deriveContextCategory(resourceType, candidate.category, categoryOverrides);
  // Fail closed on an unknown *resource type*: nothing structural is left to map
  // it by, and guessing from the text is forbidden. An unknown `category` under a
  // known resource type still maps, and is surfaced to audit instead of dropped —
  // Core adds categories additively, and dropping them would silently lose recall.
  if (category === undefined) return { dropped: true };
  const known = CORE_CATEGORY_VOCABULARY[resourceType]?.includes(candidate.category) ?? false;
  const sourceRefs = candidate.source_refs
    .map(sourceRefUrn)
    .filter((item): item is string => item !== undefined);
  if (sourceRefs.length === 0) {
    sourceRefs.push(
      `iris:${encodeURIComponent(resourceType)}:${encodeURIComponent(candidate.resource_ref.resource_id)}@${candidate.resource_ref.revision}`,
    );
  }
  const expiresAt = earliestTimestampMs(candidate.expires_at, response.cache_until);
  const block: ContextBlock = {
    id: candidate.candidate_id,
    revision: String(candidate.resource_ref.revision),
    contentHash: candidate.content_hash,
    text: candidate.text,
    category,
    providerCategory: candidate.category,
    placement: candidate.placement,
    priority: candidateCount - index,
    tokenEstimate: candidate.token_estimate,
    privacyScope: query.privacyScope,
    privacyLabels: [...candidate.privacy_labels],
    sourceRefs,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(candidate.conflict_state == null ? {} : { conflictHint: candidate.conflict_state }),
  };
  return {
    block,
    dropped: false,
    ...(known ? {} : { unknownProviderCategory: candidate.category }),
  };
}

export function selectWithinBudget(
  blocks: readonly ContextBlock[],
  tokenBudget: number,
): readonly ContextBlock[] {
  const selected: ContextBlock[] = [];
  let used = 0;
  for (const block of blocks) {
    if (used + block.tokenEstimate > tokenBudget) continue;
    selected.push(block);
    used += block.tokenEstimate;
  }
  return selected;
}
