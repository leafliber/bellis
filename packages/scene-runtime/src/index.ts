/**
 * @bellis/scene-runtime — Action Compiler、Prepare Barrier 与 Scene Director
 *（Phase 2 / P1 交付，docs/phase-2-development-guide.md §6）。
 *
 * 公开边界约定：
 * - 依赖只限 @bellis/contracts 与 @bellis/observability；不依赖 Fastify、
 *   WebSocket、SQLite、React 或浏览器 API（依赖边界测试强制）。
 * - Compiler 是纯函数；Director 只通过注入 Port 与外界交互，
 *   时钟/日志/指标/墙钟显式注入。
 * - @bellis/testkit 只出现在 devDependencies（测试用 VirtualClock 与
 *   确定性 ID 源），生产依赖链不得引用。
 */

// ---- Compiler（纯函数）----
export { compileActionFrame } from "./compiler/action-compiler.js";
export type { CompileIdSource, CompileInput, CompileResult } from "./compiler/action-compiler.js";
export { COMPILE_ISSUE_CODES } from "./compiler/issues.js";
export type { CompileIssue, CompileIssueCode } from "./compiler/issues.js";
export { DEFAULT_COMPILE_POLICY, resolveCompilePolicy } from "./compiler/policy.js";
export type { CompilePolicy } from "./compiler/policy.js";
export { validateScenePlan } from "./compiler/plan-validator.js";
export {
  isKnownAnchor,
  parseAnchor,
  requiresSpeech,
  resolveAnchorBaseUs,
} from "./compiler/anchors.js";
export type { Anchor } from "./compiler/anchors.js";

// ---- Timeline（纯函数，Runtime 侧目标时刻）----
export { absoluteTargetUs, resolveCueTargets } from "./timeline/cue-targets.js";
export type { CueTarget, SpeechTimingContext } from "./timeline/cue-targets.js";

// ---- Director ----
export { PrepareBarrier } from "./director/barrier.js";
export type { BarrierVerdict, PrepareBarrierOptions } from "./director/barrier.js";
export { DurableCommitError, StageCommitAmbiguousError } from "./director/ports.js";
export type {
  CancelOutcome,
  DurableCommitResult,
  DurableSceneCommit,
  SceneLifecycleRecord,
  SceneRepositoryPort,
  StageLaneReady,
  StagePort,
  StageReady,
} from "./director/ports.js";
export { DEFAULT_DIRECTOR_POLICY, SceneDirector } from "./director/scene-director.js";
export type {
  DirectorInternalState,
  DirectorPolicy,
  LaneFinishReport,
  LaneStartReport,
  SceneDirectorOptions,
  SceneHandle,
  SceneOutcome,
  SubmitOptions,
} from "./director/scene-director.js";
