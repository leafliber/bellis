/** Live2D 控制命令类型 — 与后端 Live2DCommandType 一一对应 */

export type Live2DCommandType =
  | "set_emotion"
  | "play_motion"
  | "set_parameter"
  | "set_parameters"
  | "set_expression"
  | "set_lip_sync";

/** Live2D 控制命令 — 与后端 Live2DCommand 模型对应 */
export interface Live2DCommand {
  type: Live2DCommandType;
  emotion?: string;
  intensity?: number;
  group?: string;
  index?: number;
  param_id?: string;
  value?: number;
  parameters?: Record<string, number>;
  expression_name?: string;
  mouth_open?: number;
}

/** 情绪类型 — 与后端 EmotionEnum 对齐（含新增的 think/awkward/question/curious） */
export type EmotionType =
  | "happy"
  | "excited"
  | "calm"
  | "shy"
  | "angry"
  | "sad"
  | "surprised"
  | "neutral"
  | "think"
  | "awkward"
  | "question"
  | "curious";

/** 动作类型 — 与后端 MotionEnum 对齐 */
export type MotionType =
  | "idle"
  | "wave"
  | "nod"
  | "shake_head"
  | "bow"
  | "clap"
  | "point"
  | "think"
  | "cheer";
