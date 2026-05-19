import type {
  GUIEvent,
  GUIState,
  GUIResponse,
  GUIConfig,
  GUITraceSpan,
  GUIMetrics,
  Snapshot,
} from "@/types";
import { EMOTION_ICONS, EMOTION_COLORS } from "./constants";

const MOCK_USERS = ["小明", "大白猫", "星辰", "流光", "月影", "风铃", "彩虹", "云端"];
const MOCK_DANMAKU = [
  "主播好厉害！",
  "哈哈哈笑死我了",
  "今天天气真好",
  "加油加油！",
  "这个好有趣",
  "666666",
  "主播唱首歌吧",
  "第一次来，关注了",
  "太可爱了吧",
  "下次什么时候直播",
];
const MOCK_GIFTS = ["小心心", "火箭", "小电视", "辣条", "粉丝团灯牌", "银瓜子"];

function randomItem<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function createMockEvent(): GUIEvent {
  const sources: Array<"danmaku" | "gift" | "command" | "system"> = ["danmaku", "danmaku", "danmaku", "gift", "command", "system"];
  const source = randomItem(sources);
  let displayText = "";
  let userName = "";

  switch (source) {
    case "danmaku":
      userName = randomItem(MOCK_USERS);
      displayText = randomItem(MOCK_DANMAKU);
      break;
    case "gift":
      userName = randomItem(MOCK_USERS);
      displayText = `送出了 ${randomItem(MOCK_GIFTS)}`;
      break;
    case "command":
      userName = "管理员";
      displayText = randomItem(["切换话题", "强制回复", "切换人格", "中断当前回复"]);
      break;
    case "system":
      displayText = randomItem(["智能体已启动", "配置已更新", "连接已恢复", "弹幕采样率调整"]);
      break;
  }

  return {
    display_text: displayText,
    source,
    color_tag: source,
    user_name: userName,
    timestamp: new Date().toISOString(),
    priority_name: source === "command" ? "HIGH" : source === "system" ? "CRITICAL" : "NORMAL",
    metadata: {},
  };
}

export const MOCK_STATE: GUIState = {
  emotion: {
    current: "happy",
    intensity: 0.75,
    icon: EMOTION_ICONS.happy,
    color: EMOTION_COLORS.happy,
  },
  scene: {
    stream_title: "深夜闲聊局",
    streamer_name: "Bellis",
    viewer_count: randomInt(500, 5000),
    topic: "日常闲聊",
    phase: "streaming",
  },
  recent_actions: [
    { action_type: "reply", description: "回复了弹幕「主播好厉害」", emotion: "happy", motion: "wave" },
    { action_type: "emotion", description: "情感从 neutral 变为 happy", emotion: "happy", motion: "idle" },
    { action_type: "reply", description: "感谢礼物「小心心」", emotion: "excited", motion: "cheer" },
    { action_type: "reply", description: "回应了话题切换请求", emotion: "calm", motion: "nod" },
    { action_type: "idle", description: "等待新事件...", emotion: "neutral", motion: "idle" },
  ],
  state_version: 42,
  interrupt_flag: false,
  event_queue_size: randomInt(0, 20),
  tts_queue_size: randomInt(0, 5),
};

export const MOCK_RESPONSE: GUIResponse = {
  text: "谢谢你的小心心！超级开心的～",
  emotion: "happy",
  motion: "cheer",
  tts_speed: 1.0,
  target_user: "小明",
  motion_duration: 2.5,
};

export const MOCK_CONFIG: GUIConfig = {
  personas: {
    default: {
      name: "default",
      system_prompt: "你是一个活泼可爱的直播助手，善于与观众互动。",
      tts_voice: "default",
    },
    gentle: {
      name: "gentle",
      system_prompt: "你是一个温柔知性的直播助手，说话轻声细语。",
      tts_voice: "gentle",
    },
    funny: {
      name: "funny",
      system_prompt: "你是一个幽默风趣的直播助手，喜欢讲笑话。",
      tts_voice: "funny",
    },
  },
  active_persona: "default",
  model: {
    primary_model: "openai:gpt-4o",
    fallback_model: "openai:gpt-4o-mini",
    max_retries: 3,
    temperature: 0.7,
  },
  platform: {
    danmaku_ws_uri: "ws://localhost:8080/danmaku",
    command_ws_uri: "ws://localhost:8080/command",
    max_queue_size: 1000,
    danmaku_qps_limit: 50,
    tts_queue_limit: 20,
  },
};

export const MOCK_TRACES: GUITraceSpan[] = [
  {
    name: "process_danmaku",
    duration_ms: 156.3,
    input_summary: "弹幕: 主播好厉害！",
    output_summary: "生成回复: 谢谢夸奖～",
    children: [
      { name: "perception", duration_ms: 23.1, input_summary: "原始事件", output_summary: "结构化输入", children: [] },
      { name: "decision", duration_ms: 89.4, input_summary: "上下文+事件", output_summary: "回复策略", children: [] },
      { name: "execution", duration_ms: 43.8, input_summary: "回复策略", output_summary: "LiveResponse", children: [] },
    ],
  },
  {
    name: "process_gift",
    duration_ms: 210.7,
    input_summary: "礼物: 小心心 x1",
    output_summary: "生成感谢回复",
    children: [
      { name: "perception", duration_ms: 18.2, input_summary: "礼物事件", output_summary: "礼物信息", children: [] },
      { name: "decision", duration_ms: 142.5, input_summary: "礼物+上下文", output_summary: "感谢策略", children: [] },
      { name: "execution", duration_ms: 50.0, input_summary: "感谢策略", output_summary: "LiveResponse", children: [] },
    ],
  },
];

export const MOCK_METRICS: GUIMetrics = {
  event_queue_size: randomInt(0, 30),
  tts_queue_size: randomInt(0, 8),
  circuit_breaker_state: "closed",
  state_version: 42,
  events_per_minute: 23.5,
};

export const MOCK_SNAPSHOTS: Snapshot[] = [
  { _snapshot_time: "2026-05-19 20:00:00", state_version: 42 },
  { _snapshot_time: "2026-05-19 19:45:00", state_version: 38 },
  { _snapshot_time: "2026-05-19 19:30:00", state_version: 35 },
];
