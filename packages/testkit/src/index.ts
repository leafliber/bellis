/**
 * @bellis/testkit — 确定性测试设施（仅开发/测试依赖，生产包禁止引用）。
 *
 * Gate 1 冻结导出：VirtualClock。P3 只追加新导出，
 * 不得删除、重命名或改变既有行为（docs/reference/phase-1.md）。
 */
export { VirtualClock } from "./virtual-clock.js";
export { createDeterministicIdSource } from "./deterministic-ids.js";
export type { DeterministicIdSource } from "./deterministic-ids.js";
export { createDeterministicRandom } from "./deterministic-random.js";
export type { DeterministicRandom } from "./deterministic-random.js";
export { createTempDataDirectory, isSafeCleanupTarget } from "./temp-data-directory.js";
export type { TempDataDirectory } from "./temp-data-directory.js";
export { assertMemoryProviderConformance } from "./memory-provider-conformance.js";
export type { MemoryProviderConformanceCase } from "./memory-provider-conformance.js";
export {
  FIXTURE_CUE_ID,
  FIXTURE_CYCLE_ID,
  FIXTURE_FRAME_ID,
  FIXTURE_GROUP_ID,
  FIXTURE_MESSAGE_ID,
  FIXTURE_OUTBOX_ID,
  FIXTURE_RECORD_ID,
  FIXTURE_SCENE_ID,
  FIXTURE_SESSION_ID,
  FIXTURE_SPAN_ID,
  FIXTURE_STREAM_ID,
  FIXTURE_TRACE_ID,
  makeClientEnvelope,
  makeEnvelopeTrace,
  makeMediaFrameHeader,
  makeOutboxMessage,
  makeScene,
  makeServerEnvelope,
  makeSessionRecord,
  makeTraceContext,
} from "./protocol-fixtures.js";
