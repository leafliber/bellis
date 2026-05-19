import type { EmotionType, EventSource } from "@/types";

export const EMOTION_ICONS: Record<EmotionType, string> = {
  happy: "😊",
  excited: "🤩",
  calm: "😌",
  shy: "😳",
  angry: "😠",
  sad: "😢",
  surprised: "😲",
  neutral: "😐",
};

export const EMOTION_COLORS: Record<EmotionType, string> = {
  happy: "#a6e3a1",
  excited: "#f9e2af",
  calm: "#89b4fa",
  shy: "#f5c2e7",
  angry: "#f38ba8",
  sad: "#89dceb",
  surprised: "#fab387",
  neutral: "#a6adc8",
};

export const SOURCE_COLORS: Record<EventSource, string> = {
  danmaku: "#89b4fa",
  gift: "#f9e2af",
  command: "#f38ba8",
  rag: "#89b4fa",
  system: "#6c7086",
};

export const SOURCE_LABELS: Record<EventSource, string> = {
  danmaku: "弹幕",
  gift: "礼物",
  command: "指令",
  rag: "RAG",
  system: "系统",
};

export const MAX_EVENTS = 200;

// Catppuccin Mocha theme colors
export const THEME = {
  dark: {
    background: "#1e1e2e",
    surface: "#313244",
    overlay: "#45475a",
    primary: "#89b4fa",
    secondary: "#a6adc8",
    accent: "#f5c2e7",
    error: "#f38ba8",
    warning: "#fab387",
    success: "#a6e3a1",
    text: "#cdd6f4",
    textMuted: "#6c7086",
  },
  light: {
    background: "#eff1f5",
    surface: "#ccd0da",
    overlay: "#bcc0cc",
    primary: "#1e66f5",
    secondary: "#6c6f85",
    accent: "#ea76cb",
    error: "#d20f39",
    warning: "#fe640b",
    success: "#40a02b",
    text: "#4c4f69",
    textMuted: "#9ca0b0",
  },
};
