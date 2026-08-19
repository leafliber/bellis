import { z } from "zod";
import { UuidSchema } from "../common/ids.js";
import { JsonValueSchema } from "../common/json-value.js";

/** Scene 输出的五条 Lane（architecture-plan.md §9.1）。 */
export const CueLaneSchema = z.enum(["audio", "subtitle", "avatar", "game", "overlay"]);

/**
 * Cue：Scene 中具有时间锚点的最小输出单位。
 * anchor 是语义锚点名（scene_start / speech_start / speech.word:<index> 等）；
 * offsetMs 可为负（相对锚点提前）。intent 必须是 JSON 值，
 * 由各 Lane 的意图 Schema 约束。
 */
export const CueSchema = z.looseObject({
  schemaVersion: z.literal(1),
  cueId: UuidSchema,
  lane: CueLaneSchema,
  anchor: z.string().min(1).max(128),
  offsetMs: z.number().int(),
  intent: JsonValueSchema,
});

export type CueLane = z.infer<typeof CueLaneSchema>;
export type Cue = z.infer<typeof CueSchema>;
