# Iris Memory Provider for Bellis

`@iris-memory/bellis-provider` 0.2.0 implements the `MemoryProvider` and
`PersonaSource` ports for Bellis Phase 4. The real A0/A1 probe consumes an isolated
Core 0.12.0 and 0.13.0 wheels (Schemas 14/15 / Contract 1.10.0), installed SDK 0.11.2, and
Bellis Decision Host/DB Worker. It verifies Recall, Persona, adoption-time Usage
and public Observe semantics. Stage-confirmed output and the Persona barrier slice
are implemented. Host policy generations and tombstones are also implemented;
their Core event/tool integration and complete Phase 4 recovery gates remain in progress. See the
[implementation record](../../docs/phase-4-implementation-status.md) and
[ADR 0009](../../docs/adr/0009-phase4-context-adoption.md).

The adapter preserves Core candidate IDs, revisions, hashes, placement, privacy
labels, source references and route degradation. Persona data remains structured
and is hash-verified before being cached. Observe and Usage await the remote
acknowledgment; the host's background Outbox owns durable retry, outside the
active reply path. Legacy queued rows are retained for recovery/reconciliation.

The default Runtime installation receives a scope-isolated state store through
`MemoryProviderContext.stateStore`, backed by the host DB Worker. Writes use revision
checks and bounded storage; stale writers cannot overwrite newer barriers. Standalone
use defaults to RAM, while an explicit `stateStore` preserves the caller's choice.
Persona invalidations survive recovery in a durable store and block all offline
fallbacks until a valid live publication resolves them. Network calls have a
4-second default deadline (`backgroundTimeoutMs`, maximum 30000); timed-out operations
retain their concurrency permit until the underlying call settles. See
[ADR 0012](../../docs/adr/0012-phase4-provider-state-and-persona-barriers.md).

The host stamps Context/Observe with durable policy generations, rejects obsolete
adoption and effects, and retains suppression audit for historical deliveries.
Iris candidates now include their own canonical resource reference even when
separate provenance references exist, enabling precise tombstone matching.
Controlled Forget now has durable host coordination and real Core evidence; external invalidations still need wiring;
see [ADR 0013](../../docs/adr/0013-phase4-memory-policy-transactions.md).

Bellis ADR 0007 narrows the required Memory response to version, provider/request identity and bounded blocks. Iris continues returning its real mapping, route, watermark and persona metadata via `IrisContextContribution`; other retrieval providers can omit that metadata and do not need to fabricate a persona revision. PersonaSource remains an independent port.

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
[`compatibility-matrix.json`](./compatibility-matrix.json). The default Schema 14–15 window and Surface `off` have real-service evidence with the frozen SDK 0.11.2 archive. Schema 20 is an explicitly configured candidate with its own wheel digest and narrower evidence; the matrix does not imply support for untested builds.

## Running the gates

This directory remains outside the root pnpm workspace and installs standalone.
The SDK dependency uses the immutable `vendor/iris-memory-sdk-0.11.2.tgz` package
with lockfile integrity; no registry publication or local Verdaccio is required.
Ordinary development dependencies use the default registry. See
[ADR 0044](../../docs/adr/0044-phase4-installed-checkpoint-sdk.md).

```bash
# Run from the Bellis repository root.
pnpm install --frozen-lockfile
pnpm --filter @bellis/testkit... build
pnpm --dir providers/memory-iris install --frozen-lockfile
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
The host Context/Manifest/Usage and trusted input Observe paths are connected.
Observe batches are capped at 100, successful HTTP bodies are bounded before SDK
parsing, and durable ACK coverage is checked before success. Stage-confirmed Observe
has a real Chromium/Core integration probe. Persistent privacy/recovery boundaries
and controlled memory tools remain Phase 4 work.

When the SDK moves to public npm, this file, `.npmrc` and `pnpm-workspace.yaml`
go away, `link:` becomes `workspace:*`, and the gates above run in host CI.

## Real Core and host probe

Build/install a fixed Core wheel in a separate Python environment, then run:

```sh
IRIS_CORE_PYTHON=/absolute/isolated-venv/bin/python pnpm test:memory:iris
```

The probe provisions temporary loopback Core API/Worker services with the trusted
Core CLI (including its resolved actor identity ID), consumes public SDK/HTTP only,
and cleans them up. Installed Core files are compared with their wheel contents.
The host probe also sends and replays a trusted user observation via its DB Outbox. It uses the explicit
development SQLite override. Missing environment is a failed/unexecuted gate
(exit 2), never a successful skip. Optional `IRIS_PROBE_REPORT` saves a sanitized
artifact/acceptance summary. Credentials are created mode 0600 in a temporary
directory and never written into the report.

`IRIS_CORE_PYTHON=/absolute/isolated-venv/bin/python pnpm demo:phase4:iris`
also runs real Chromium against that same Core API/Worker. It verifies four actual
output observations across three cycles, complete/partial proofs, cancellation,
three Usage ACKs, the Core source cursor, and a trusted host privacy interruption
that advances the durable generation to 1 during playback. Credentials are supplied to the
Runtime through an owner-only temporary file, never the page. This short probe
does not satisfy the 100-cycle or crash-window acceptance gates.

## Tool transport (A3, incomplete)

`IrisToolBoundary` and `freezeIrisToolRequest` provide bounded, cancellable public SDK transport for search/remember/correct/forget. They require a trusted host to authorize and persist the actual request before invocation; they are not model tool registration or a confirmation bypass. A dispatched write with an unknown response throws `IrisToolOutcomeUnknown`; reconcile the frozen request with its original key.

`registerIrisTools(runtime, options)` registers the four closed model schemas through `@bellis/tool-runtime`. Configuration supplies the trusted agent/space/Core Session mapping and a required `IrisToolAuthority`: authorize a user request and target, recheck the saved grant, establish and resolve durable Forget barriers, and filter results against current privacy. No authority method defaults to allow. Writes require confirmation and use host-generated stable keys; model scope/evidence/revision/selector fields are rejected. The application can compose this through `RuntimeOptions.tools.register`, which receives the active MemoryHost. Production target-grant rules remain separate work; do not implement them by echoing model arguments into a grant. The durable host Forget coordinator is described below. See [ADR 0017](../../docs/adr/0017-phase4-iris-tool-registration.md).

`pnpm test:memory:iris:tools` passes its public API gate on the recorded Core 0.13/schema 15 wheel, initialized by trusted `init --initialize-search`. Search finds the remembered claim and excludes it after Forget. The retained Core 0.12 profile still exits 2 because its CLI cannot initialize a ready search generation. Real remember/correct/forget and original-key replay are verified. A trusted remember fixture also exercises host durable preparation, confirmation, unknown write outcome, Worker restart and reconciliation using the saved request/key. Production target authorization, complete privacy recovery, Legal Hold and the full host tool matrix remain open. See [ADR 0015](../../docs/adr/0015-phase4-iris-tool-transport-outcomes.md) and [ADR 0016](../../docs/adr/0016-phase4-prepared-tool-requests.md).

The host now provides `MemoryHost.beginForget(prepared)` and `completeForget(prepared, receipt)` for the authority hooks. They commit barrier ownership and receipt/tombstone transitions atomically through the DB Worker. Map Core request ID and target/erased/protected/held counts explicitly; never call completion on an unknown response. Retained targets stay blocked, and late completion cannot release a newer privacy barrier. The real probe verifies registered Forget and restart recovery for its own claim; actual Legal Hold/protected targets and crash windows remain open. See [ADR 0018](../../docs/adr/0018-phase4-forget-coordination.md).

The 0.13 search and Chromium evidence, independent wheel identity, and rollback tests for trusted initialization are recorded in [ADR 0019](../../docs/adr/0019-phase4-core13-search-initialization.md). The probe verifies fresh databases; existing Core data requires its own offline backup/migration procedure.

`correct` and `forget` version 2 independently read the public target before preparation and after confirmation. Configure a trusted `selfEntityId` for self grants; an arbitrary claim cannot establish the agent’s identity. Subject, scope, revision, privacy and content are bound into the saved confirmation. Host authority is checked again after target I/O. Core Forget lacks an `expected_revision` condition, so these reads do not provide an atomic cross-writer guarantee. See [ADR 0020](../../docs/adr/0020-phase4-iris-tool-target-verification.md).

The host now filters pending Signals and Tool Results against durable admission/adoption policy before Prompt, actor mapping, and Recall. Unstamped legacy input is not promoted into the current generation. Complete authorized batch ranges preserve aggregates; mixed old ranges suppress them. Unknown write outcomes remain explicit after content suppression. See [ADR 0021](../../docs/adr/0021-phase4-local-input-privacy.md); this does not replace the required trusted authority and result-visibility hooks.

Public resource invalidations are persisted before the trusted host callback and the SSE cursor advances only after the host acknowledges its policy transaction and effect cancellation. Pending failures block Recall across restart; in-flight older Recall results are rejected. Legacy pending deliveries are retained for reconciliation and quarantined after invalidation. The Core CLI application credential must grant `events.sse.v1`; existing credentials are not changed automatically. See [ADR 0022](../../docs/adr/0022-phase4-resource-invalidations.md). This proves received deletion events, not history-gap recovery or ordinary correction notifications.

`pnpm test:memory:iris:continuous` from the repository root runs 100 cycles through one real Runtime/DB Worker, installed Core API/Worker, and Chromium session. Each cycle audits the persisted Manifest against the actual model request, Recall provenance/Persona revision, budget and Core-acknowledged Usage sets. The recorded run passed 100 cycles and 101 actual output observations. See [continuous validation](../../docs/phase-4-continuous-validation.md); crash, capacity and resource-growth gates remain separate.

`pnpm test:memory:iris:recovery` exercises durable SSE pending and policy-commit boundaries with real Runtime/Core API/Core Worker SIGKILL and restart. The remaining crash and capacity windows are explicit in the report; until the whole recovery matrix is implemented, the command reports `incomplete` and exits 2. See [recovery validation](../../docs/phase-4-recovery-validation.md).

The recovery command now also tests Manifest/adoption and Usage ACK/delivered boundaries: 180 new cases plus the 120 SSE cases pass across the real Runtime, Core API and Core Worker. Adopted-cycle restart preserves the original Manifest without another model request; pending unconsumed input after a pre-adoption crash uses a new cycle. Original-key Usage replay and a test-only second key resolve to the same Core report ID. Full recovery still reports `incomplete`; [evidence](../../docs/evidence/phase4-cycle-recovery-probe.json).

Observation HTTP recovery adds 180 cases to the same command (480 combined). A fixed loopback proxy holds publication or actual Core response delivery; tests distinguish remote cursor null from committed cursor 1 before local settlement. Runtime replay preserves the wire-body digest and batch key. Fresh-batch/original-record-key replay returns the same Canonical ID without new facts or jobs. See [Observation recovery evidence](../../docs/evidence/phase4-observe-recovery-probe.json); active Stage/effect, snapshot and capacity gates remain open.

Host assembly now requires `scope: { kind: "space", acknowledgeCrossSession: true }` in `RuntimeOptions.memory`. This explicitly accepts remote memory shared across Bellis Sessions. The host persists local Session scope before provider startup and rejects unverified Core Session/group configuration. Restored Observe targets must match the configured agent/space and carry no Session/group; incompatible records are retained as failed deliveries without retargeting. The standalone tool adapter’s low-level `coreSessionId` option does not establish host Session support. See [ADR 0023](../../docs/adr/0023-phase4-explicit-memory-scope.md).

Host persistence now checks actual database/WAL usage before new admission and exposes cancellable `readDiskStatus()`. Runtime readiness reflects disk pressure; previously admitted effect confirmation and exact retries retain their existing paths. Default high water is 512 MiB with an 8 MiB admission margin and a 160 MiB filesystem free-space floor. This is not a hard quota or proof of worst-case confirmation reservation. See [ADR 0024](../../docs/adr/0024-phase4-disk-admission.md) and [validation](../../docs/evidence/phase4-disk-admission-probe.json).

The host also applies SQLite page limits to every state/telemetry connection (`stateMaxBytes`: 1 GiB by default; `telemetryMaxBytes`: 64 MiB). Actual limits and page usage appear under `readDiskStatus().capacity`. A full database does not overwrite saved barriers, and a restart with a limit below existing allocation is refused. These limits do not cap WAL length or reserve completion space. See [ADR 0025](../../docs/adr/0025-phase4-database-page-limits.md).

The host additionally fences subsequent writes when either WAL reaches `walHighWaterBytes` (64 MiB by default) and a checkpoint cannot reclaim it. Background Provider state writes are included; committed state remains readable and readiness can recover after the reader releases its snapshot. This is a transaction-boundary fence, with single-transaction overshoot and completion reservations still open. See [ADR 0026](../../docs/adr/0026-phase4-wal-write-fence.md).

The host now disables cache spill and enforces a connection-local pager-cache budget at SQLite commit (`transactionCacheMaxBytes`, default 8 MiB, configurable from 4 to 64 MiB). Oversized transactions roll back with a safe capacity error. Build the host with a C compiler before running the Provider probes; the extension uses Node’s embedded SQLite, and its compiled artifact is required at startup. This bounds the single-commit contribution to WAL under the current Worker; protected completion space and whole-directory resource acceptance remain open. See [ADR 0027](../../docs/adr/0027-phase4-transaction-capacity.md).

The host now persists per-Scene completion credits and prevents ordinary state/telemetry writes from consuming them. Confirmed text, per-target Observe/Outbox rows and credit consumption commit atomically. The maximum four-plan/32-segment/eight-target case passes with a pinned WAL reader; two local confirmation windows each pass 20 real process kills. OS-level space preallocation, actual ENOSPC and the complete Core/Stage recovery matrix remain separate gates. See [ADR 0028](../../docs/adr/0028-phase4-completion-reservations.md).


An event request returning public `history_unavailable` / HTTP 410 now creates a persistent history-gap receipt. The adapter saves the original checkpoint and notifies the trusted host; either failure retains the same gap for retry without requesting new SSE events. Host ACK does not release the gap. Persona/cache fallback, Recall, Observe, Usage and legacy delivery remain paused across restart. A checkpoint-capable Core also requires explicit revalidation of legacy positive cursors without an event identity. The production SDK is now the frozen local 0.11.2 package; the real Core 410 → Provider → host/Worker path uses its persisted pair without probe option rewriting (ADR 0044). Full public revalidation, safe release and the complete old-backup matrix remain unfinished. See [ADR 0030](../../docs/adr/0030-phase4-history-gap-barrier.md).


### 历史缺口的维护核验

`IrisRecallVerifier` 是独立的只读恢复通道，可在普通 `IrisMemoryProvider`/MemoryHost 因缺口停止后使用。明确配置 origin、凭据、agent/space 和经过验证的 Core Schema 范围；每批通过已安装 SDK negotiation 检查 `recall.revalidate.v1` 后调用公开 HTTP。默认范围不因新增类而放宽。配合 Runtime 导出的 `Phase4HistoryRevalidator`，可从 DB Worker 清单读取获准发送的完整原请求，分批保存结论并在重启后继续原 run。维护装配应先停止普通宿主，并在隐私变更前取消核验。

该流程始终返回 incomplete，不会恢复 Context、Outbox 或 SSE。旧策略代际请求保留未核验，完整覆盖、自动恢复装配及安全解除仍待完成。使用与边界见 [ADR 0037](../../docs/adr/0037-phase4-recall-revalidation-coordinator.md)。


维护装配现在可以通过 `memoryHost.historyRevalidator(verifier).resume(signal)` 从 DB Worker 发现当前缺口和原 runId。宿主会在隐私、资源失效或关闭前取消该调度器；跨代际需由宿主创建新实例。普通宿主已经因启动失败关闭时，使用新的、未启动普通 Provider 的维护宿主实例，不重启旧生命周期。持久发现和取消归属见 [ADR 0038](../../docs/adr/0038-phase4-history-recovery-discovery.md)。可信维护装配可调用 `memoryHost.startHistoryRecovery(verifier, options)` 启动受控后台轮询：暂时失败重试，明确不可重试错误停在 attention，关闭清除定时器，在途工作未结束不启动替代任务。自动启动恢复模式和安全解除尚未接入，见 [ADR 0039](../../docs/adr/0039-phase4-background-history-recovery.md)。

可信 Runtime 装配可将独立 `IrisRecallVerifier` 放入 `memory.historyRecovery.verifiers`（每个已注册 Provider 恰好一个），并配置 `intervalMs` / `timeoutMs`。宿主会在正常启动后自动维护；持久缺口重启则跳过普通 Provider、Persona 和决策宿主，保留 live 与维护任务，ready 和新会话交换返回 503。运行期缺口关闭决策管道并保持屏障；配置错误与无缺口的凭据失败继续清理并拒绝启动。见 [ADR 0040](../../docs/adr/0040-phase4-runtime-history-recovery.md)。核验端口的身份、凭据和 Core 能力支持仍由可信装配确定，不能从 Stage 或模型参数构造。

已提供 `pnpm start:iris --config /absolute/config.json` 固定安装入口：配置只含环境/文件凭据引用，单个 Iris 实例拥有 MemoryProvider/PersonaSource，禁用时不加载 Provider，SIGINT/SIGTERM 统一关闭。安装、可信身份、读取范围和历史恢复配置见 [运行说明](../../docs/iris-runtime-operations.md)；写工具授权与凭据轮换仍未由此入口完成。

明确的 401/403 或 404/access_denied 会锁定当前实例：取消其他在途调用、停用后台重试、持久记录 Persona 屏障并通知 Host；缓存与静态人格不能恢复服务。修复后须显式停止并启动新生命周期。Runtime readiness 现与已观察到的人格/隐私屏障一致，真实公开凭据撤销证据见 [ADR 0042](../../docs/adr/0042-phase4-memory-readiness.md)。

零重叠轮换已通过真实 Core 公开接口与配置加载路径验证：前任凭据拒绝后显式关闭，原子替换私有凭据文件，以原业务身份和数据目录启动；原请求/Manifest/Usage 保留，继任凭据接受原 Usage 重放。步骤见 [运维说明](../../docs/iris-runtime-operations.md) 与 [ADR 0043](../../docs/adr/0043-phase4-credential-rotation.md)。

正式 Provider 现从已安装 SDK 0.11.2 发送协商后的游标/事件身份；保存失败和重启保留原配对值。公开探针核对四个安装文件且不再使用独立候选 SDK 路径或代写检查点。`pnpm --dir providers/memory-iris check` 运行完整独立检查，CI 已配置同一安装路径；详见 [ADR 0044](../../docs/adr/0044-phase4-installed-checkpoint-sdk.md)。

`pnpm test:memory:iris:snapshots` now verifies two actual Core cold-restore paths with the frozen schema20 installation: a missing saved anchor and a reused cursor with a different event identity. The original positive backup anchor and Core Usage identity remain valid; the host cancels Context and restarts in maintenance without changing original local facts. See [ADR 0045](../../docs/adr/0045-phase4-core-snapshot-restore.md); these two runs do not complete the full snapshot/crash or history-release gates.

The snapshots command also restores an actual closed Bellis directory from before a Core Claim deletion. Live Recall excludes the former canary before event catch-up; original Recall/remember replay returns 409/404. Catch-up reinstates the permanent tombstone and blocks old Usage; the next restart preserves both generation and checkpoint. All three host/Core cases pass together; offline Core, pending Observe and simultaneous rollback remain separate. See [combined evidence](../../docs/evidence/phase4-host-snapshot-restore-probe.json).

The snapshots command now includes three actual Observe cold rollbacks: before publication, Core commit before HTTP ACK, and SDK ACK before host delivered. The older directory is restored after a newer host has already completed delivery; original bytes/keys still converge on one Canonical ID. All six snapshot cases pass. The current frozen SDK 0.11.2/schema20 combination also passes all 480 implemented recovery cases (24 combinations × 20); full recovery remains incomplete/exit 2. See [current evidence](../../docs/evidence/phase4-observe-snapshot-restore-probe.json).

`pnpm test:memory:iris:stage-recovery` exercises real Chromium Worklet receipts at the effect transaction's pre-COMMIT and post-COMMIT/pre-Stage-ACK boundaries. It kills the isolated Runtime and reopens its database, then verifies confirmed history and original Observation identity through the installed SDK and public Core API. See [ADR 0046](../../docs/adr/0046-phase4-stage-effect-crash-recovery.md). These Runtime cases do not complete the active-Stage Core/HTTP-ACK or capacity matrix.
