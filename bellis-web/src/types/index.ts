export type EventSource = "danmaku" | "gift" | "command" | "rag" | "system";
export type EmotionType = "happy" | "excited" | "calm" | "shy" | "angry" | "sad" | "surprised" | "neutral" | "think" | "awkward" | "question" | "curious";
export type MotionType = "idle" | "wave" | "nod" | "shake_head" | "bow" | "clap" | "point" | "think" | "cheer";

export interface GUIEvent {
  display_text: string;
  source: EventSource;
  color_tag: string;
  user_name: string;
  timestamp: string;
  priority_name: string;
  metadata: Record<string, unknown>;
}

export interface GUIEmotionState {
  current: EmotionType;
  intensity: number;
  icon: string;
  color: string;
}

export interface GUISceneContext {
  stream_title: string;
  streamer_name: string;
  viewer_count: number;
  topic: string;
  phase: string;
}

export interface GUIActionRecord {
  action_type: string;
  description: string;
  emotion: EmotionType;
  motion: MotionType;
}

export interface GUIState {
  emotion: GUIEmotionState;
  scene: GUISceneContext;
  recent_actions: GUIActionRecord[];
  state_version: number;
  interrupt_flag: boolean;
  event_queue_size: number;
  tts_queue_size: number;
}

export interface GUIResponse {
  text: string;
  emotion: EmotionType;
  motion: MotionType;
  tts_speed: number;
  target_user: string | null;
  motion_duration: number;
}

/** 人格配置 — 对齐后端 PersonaConfig 全部字段 */
export interface GUIPersonaConfig {
  name: string;
  system_prompt: string;
  emotion_map: Record<string, EmotionType>;
  motion_map: Record<string, MotionType>;
  tts_voice: string;
  tts_speed_range: [number, number];
}

/** 模型配置 — 对齐后端 ModelConfig 全部字段 */
export interface GUIModelConfig {
  primary_model: string;
  fallback_model: string;
  max_retries: number;
  base_delay: number;
  max_delay: number;
  base_url: string | null;
  api_key: string | null;
  compat_mode: boolean;
}

/** 平台配置 — 对齐后端 PlatformConfig 全部字段 */
export interface GUIPlatformConfig {
  danmaku_ws_uri: string;
  command_ws_uri: string;
  callback_secret: string;
  max_queue_size: number;
  danmaku_qps_limit: number;
  tts_queue_limit: number;
  idle_threshold: number;
  idle_monitor_interval: number;
}

/** 插件配置字段描述 */
export interface PluginConfigField {
  type: "str" | "int" | "float" | "bool" | "enum";
  label: string;
  default: unknown;
  description: string;
  /** enum 类型专用：可选值列表 */
  options?: string[];
}

/** 插件配置 schema */
export interface PluginSchema {
  meta: {
    name: string;
    description: string;
    category: string;
  };
  fields: Record<string, PluginConfigField>;
}

export interface GUIConfig {
  personas: Record<string, GUIPersonaConfig>;
  active_persona: string;
  model: GUIModelConfig;
  platform: GUIPlatformConfig;
  plugins: Record<string, Record<string, unknown>>;
  plugin_schemas: Record<string, PluginSchema>;
}

export interface GUITraceSpan {
  name: string;
  duration_ms: number;
  input_summary: string;
  output_summary: string;
  children: GUITraceSpan[];
}

export interface GUIMetrics {
  event_queue_size: number;
  tts_queue_size: number;
  circuit_breaker_state: string;
  state_version: number;
  events_per_minute: number;
}

export interface Snapshot {
  _snapshot_time: string;
  state_version: number;
  [key: string]: unknown;
}

// WebSocket message types
export type ClientMessage =
  | { type: "command"; payload: { command: string; user_name?: string; user_level?: number; fan_badge?: string | null } }
  | { type: "start_agent" }
  | { type: "stop_agent" }
  | { type: "switch_persona"; payload: { name: string } }
  | { type: "update_config"; payload: Record<string, unknown> }
  | { type: "reload_config" };

export type ServerMessage =
  | { type: "event"; payload: GUIEvent }
  | { type: "state"; payload: GUIState }
  | { type: "response"; payload: GUIResponse }
  | { type: "metrics"; payload: GUIMetrics }
  | { type: "trace"; payload: { spans: GUITraceSpan[] } }
  | { type: "config"; payload: GUIConfig }
  | { type: "live2d"; payload: import("./live2d").Live2DCommand };
