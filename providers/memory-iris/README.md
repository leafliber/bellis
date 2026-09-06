# Iris Memory Provider for Bellis

`@iris-memory/bellis-provider` is the Phase 11 in-process adapter. It implements
Bellis `MemoryProvider` and `PersonaSource` while depending only on
`@bellis/contracts/memory` and the published `@iris-memory/sdk`.

The adapter preserves Core candidate IDs, revisions, hashes, placement, privacy
labels, source references and route degradation. Persona data remains structured
and is hash-verified before being cached. Observe and Usage await the remote
acknowledgment; the host's background Outbox owns durable retry, outside the
active reply path. Legacy queued rows are retained for recovery/reconciliation.

## Category mapping

Core publishes `RecallCandidate.category` as `candidate.category or candidate.route`,
so that one field carries four unrelated vocabularies — claim categories, focus
kinds, note kinds, and two route names — 23 values in total, with `question`
appearing in two of them. The mapping is therefore keyed on
`resource_ref.resource_type` (8 structural values) and not on `category`; see
ADR-0020 §12.1 in the Core repository.

- Unknown `resource_type` fails closed: the block is dropped and audited.
- An unknown `category` under a **known** `resource_type` still maps. Core adds
  categories additively, so dropping them would silently lose recall. It is
  reported in `audit.unknownProviderCategories` instead.
- The raw Core value is always preserved in `providerCategory`.
- `viewer` is never derived — deciding a block is about the current viewer needs
  the host identity domain, which the adapter must not enter.
- `categoryMap` lets an operator override a single Core category without a code
  change.

`test/mapping.test.ts` pins Core's vocabulary independently of `src/mapping.ts`
and asserts that nothing in it goes unmapped. Re-verify it against Core before
widening `compatibility-matrix.json`.

## Compatibility

The supported Core/Schema/Contract/SDK window is versioned in
[`compatibility-matrix.json`](./compatibility-matrix.json). Schema 11 is the
only frozen Phase 11 schema, so the minimum/current/maximum schema fixtures are
the same contract with different compatibility roles.

## Running the gates

During the documented registry transition (ADR-0020 §11.2) this directory is
intentionally not part of the root pnpm workspace, so it installs and validates
standalone. `.npmrc` points the `@iris-memory` scope at the local Verdaccio;
everything else resolves through the default registry.

```bash
# Run from the Bellis repository root; the configured private registry must be reachable.
pnpm install --frozen-lockfile
pnpm --filter @bellis/testkit... build
pnpm --dir providers/memory-iris install --ignore-workspace --frozen-lockfile
pnpm --dir providers/memory-iris lint
pnpm --dir providers/memory-iris format:check
pnpm --dir providers/memory-iris typecheck
pnpm --dir providers/memory-iris test
pnpm --dir providers/memory-iris build
```

`@iris-memory/sdk` is deliberately **not** aliased in `tsconfig.json` or
`vitest.config.ts`: it is a cross-repo dependency, and typecheck and tests only
prove anything if they run against the package as a consumer would install it.
The `@bellis/*` dependencies use same-repo `link:` resolution. TypeScript reads
built declarations in contracts/testkit `dist`, so rebuild those packages after
host contract edits. Only Vitest aliases these packages to source. Passing tests
alone does not prove that the declaration build is current.

`observe` and `reportUsage` resolve only after the remote operation succeeds;
errors and Abort propagate to the host, which owns durable retry. They must be
called by the host's background Outbox, not a foreground Cycle. New deliveries
are not acknowledged by a second in-memory queue. Legacy persisted `pending`
rows can still be retried after restart; expired rows are retained with an
`outbox.expired_requires_reconciliation` diagnostic, never silently deleted.
The host Memory/Persona integration remains a Phase 4 deliverable.

When the SDK moves to public npm, this file, `.npmrc` and `pnpm-workspace.yaml`
go away, `link:` becomes `workspace:*`, and the gates above run in host CI.
