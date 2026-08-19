import { z } from "zod";
import { UuidSchema } from "../common/ids.js";
import { CueLaneSchema } from "../scene/cue.js";
import { SyncLevelSchema } from "../scene/scene.js";

/**
 * SpeechIntent：唯一发言来源的内容（architecture-plan.md §7.3）。
 * TTS、字幕和口型读取同一份 SpeechIntent，不另存副本。
 */
export const SpeechIntentSchema = z.object({
  schemaVersion: z.literal(1),
  text: z.string().min(1).max(2000),
  purpose: z.enum(["answer", "tool_notice", "aside", "reaction"]),
  interruptible: z.boolean(),
  emotion: z.string().min(1).max(64).optional(),
});

/**
 * AvatarIntent：LLM 只产生语义动作名与通道声明，不生成帧级参数
 * （architecture-plan.md §11.3）。模型缺少某个动作时由插件按语义标签
 * 寻找替代或安全忽略。
 */
export const AvatarChannelSchema = z.enum(["head", "eyes", "body", "mouth", "expression"]);

export const AvatarIntentSchema = z
  .object({
    schemaVersion: z.literal(1),
    intentId: UuidSchema,
    motion: z.string().min(1).max(128).optional(),
    expression: z.string().min(1).max(128).optional(),
    channels: z.array(AvatarChannelSchema).min(1).max(8),
    priority: z.number().int().min(0).max(100),
    durationMs: z.number().int().nonnegative(),
    fadeInMs: z.number().int().nonnegative().optional(),
    fadeOutMs: z.number().int().nonnegative().optional(),
    interruptible: z.boolean(),
    exclusive: z.boolean(),
    mutexTags: z.array(z.string().min(1).max(64)).max(16),
  })
  .refine((intent) => intent.motion !== undefined || intent.expression !== undefined, {
    message: "avatar intent requires a semantic motion or expression name",
  });

/**
 * GameIntent：LLM 只选择语义技能，不生成逐帧输入（architecture-plan.md §12.3）。
 * timeRelation 声明与表达的并行时间关系；at_speech_word 必须给出 wordIndex。
 */
export const GameTimeRelationSchema = z.enum([
  "at_scene_start",
  "at_speech_word",
  "after_speech",
  "independent",
]);

export const GameIntentSchema = z
  .object({
    schemaVersion: z.literal(1),
    intentId: UuidSchema,
    skillId: z.string().min(1).max(128),
    timeRelation: GameTimeRelationSchema,
    wordIndex: z.number().int().nonnegative().optional(),
    arguments: z.record(z.string(), z.unknown()),
  })
  .refine((intent) => intent.timeRelation !== "at_speech_word" || intent.wordIndex !== undefined, {
    message: "at_speech_word requires wordIndex",
  });

/**
 * OverlayIntent：字幕、状态与互动图层的最小意图。
 * Phase 1 仅固定身份与生命周期字段，内容由 Overlay 插件解释。
 */
export const OverlayIntentSchema = z.object({
  schemaVersion: z.literal(1),
  intentId: UuidSchema,
  kind: z.string().min(1).max(64),
  content: z.unknown().optional(),
  durationMs: z.number().int().nonnegative().optional(),
});

/**
 * SyncPolicy：ActionFrame 的同步策略。
 * hardLanes 列出必须整组对齐才开始（或整体降级）的 Lane；
 * softTimeoutMs 限制软同步项的最长等待。
 */
export const SyncPolicySchema = z.object({
  schemaVersion: z.literal(1),
  hardLanes: z.array(CueLaneSchema).max(8),
  softTimeoutMs: z.number().int().nonnegative().optional(),
});

export type SpeechIntent = z.infer<typeof SpeechIntentSchema>;
export type AvatarChannel = z.infer<typeof AvatarChannelSchema>;
export type AvatarIntent = z.infer<typeof AvatarIntentSchema>;
export type GameTimeRelation = z.infer<typeof GameTimeRelationSchema>;
export type GameIntent = z.infer<typeof GameIntentSchema>;
export type OverlayIntent = z.infer<typeof OverlayIntentSchema>;
export type SyncPolicy = z.infer<typeof SyncPolicySchema>;

/** 仅供测试与文档引用的同步等级别名，避免 decision 域直接依赖 scene 内部路径。 */
export type ActionSyncLevel = z.infer<typeof SyncLevelSchema>;
