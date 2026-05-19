export type EventSource = "danmaku" | "gift" | "command" | "rag" | "system";
export type EmotionType = "happy" | "excited" | "calm" | "shy" | "angry" | "sad" | "surprised" | "neutral";
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

export interface GUIPersonaConfig {
  name: string;
  system_prompt: string;
  tts_voice: string;
}

export interface GUIModelConfig {
  primary_model: string;
  fallback_model: string;
  max_retries: number;
  temperature: number;
}

export interface GUIPlatformConfig {
  danmaku_ws_uri: string;
  command_ws_uri: string;
  max_queue_size: number;
  danmaku_qps_limit: number;
  tts_queue_limit: number;
}

export interface GUIConfig {
  personas: Record<string, GUIPersonaConfig>;
  active_persona: string;
  model: GUIModelConfig;
  platform: GUIPlatformConfig;
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
  | { type: "command"; payload: { command: string } }
  | { type: "start_agent" }
  | { type: "stop_agent" }
  | { type: "switch_persona"; payload: { name: string } };

export type ServerMessage =
  | { type: "event"; payload: GUIEvent }
  | { type: "state"; payload: GUIState }
  | { type: "response"; payload: GUIResponse }
  | { type: "metrics"; payload: GUIMetrics }
  | { type: "config"; payload: GUIConfig };
