/** 默认空值 — 所有 mock 数据已移除，初始状态等待后端推送真实数据。 */

import type {
  GUIState,
  GUIResponse,
  GUIConfig,
} from "@/types";
import { EMOTION_ICONS, EMOTION_COLORS } from "./constants";

/** 默认空 GUI 状态，等待后端推送。 */
export const DEFAULT_STATE: GUIState = {
  emotion: {
    current: "neutral",
    intensity: 0,
    icon: EMOTION_ICONS.neutral,
    color: EMOTION_COLORS.neutral,
  },
  scene: {
    stream_title: "",
    streamer_name: "",
    viewer_count: 0,
    topic: "",
    phase: "idle",
  },
  recent_actions: [],
  state_version: 0,
  interrupt_flag: false,
  event_queue_size: 0,
  tts_queue_size: 0,
};

/** 默认空 GUI 回复，等待后端推送。 */
export const DEFAULT_RESPONSE: GUIResponse = {
  text: "",
  emotion: "neutral",
  motion: "idle",
  tts_speed: 1.0,
  target_user: null,
  motion_duration: 0,
};

/** 默认空 GUI 配置，等待后端推送。 */
export const DEFAULT_CONFIG: GUIConfig = {
  personas: {},
  active_persona: "",
  model: {
    primary_model: "",
    fallback_model: "",
    max_retries: 3,
    base_delay: 1.0,
    max_delay: 30.0,
    base_url: null,
    api_key: null,
    compat_mode: false,
  },
  platform: {
    danmaku_ws_uri: "",
    command_ws_uri: "",
    callback_secret: "",
    max_queue_size: 1000,
    danmaku_qps_limit: 50,
    tts_queue_limit: 20,
    idle_threshold: 5,
    idle_monitor_interval: 2.0,
  },
  plugins: {},
  plugin_schemas: {},
};
