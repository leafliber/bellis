import { create } from "zustand";
import type { Live2DCommand } from "@/types/live2d";
import { useConfigStore } from "./useConfigStore";

/** 默认 Live2D 模型 URL（与后端 Live2D 插件 config_schema 对齐） */
const DEFAULT_MODEL_URL = "/data/live2d/shizuku/shizuku.model3.json";

interface Live2DState {
  /** 是否启用 Live2D 渲染 */
  enabled: boolean;
  /** Live2D 模型 URL */
  modelUrl: string | null;
  /** 当前情绪 */
  currentEmotion: string;
  /** 当前动作组 */
  currentMotion: string;
  /** 待处理的命令队列 */
  pendingCommands: Live2DCommand[];
  // Actions
  setEnabled: (enabled: boolean) => void;
  setModelUrl: (url: string | null) => void;
  enqueueCommand: (cmd: Live2DCommand) => void;
  dequeueCommand: () => Live2DCommand | undefined;
  clearCommands: () => void;
  /** 从后端配置同步 Live2D 状态 */
  syncFromConfig: () => void;
}

export const useLive2DStore = create<Live2DState>((set, get) => ({
  enabled: true,
  modelUrl: DEFAULT_MODEL_URL,
  currentEmotion: "neutral",
  currentMotion: "Idle",
  pendingCommands: [],

  setEnabled: (enabled) => set({ enabled }),

  setModelUrl: (url) => set({ modelUrl: url }),

  enqueueCommand: (cmd) => {
    const state = get();
    // 更新当前情绪/动作状态
    const updates: Partial<Live2DState> = {
      pendingCommands: [...state.pendingCommands, cmd],
    };
    if (cmd.type === "set_emotion" && cmd.emotion) {
      updates.currentEmotion = cmd.emotion;
    }
    if (cmd.type === "play_motion" && cmd.group) {
      updates.currentMotion = cmd.group;
    }
    set(updates);
  },

  dequeueCommand: () => {
    const state = get();
    if (state.pendingCommands.length === 0) return undefined;
    const [first, ...rest] = state.pendingCommands;
    set({ pendingCommands: rest });
    return first;
  },

  clearCommands: () => set({ pendingCommands: [] }),

  syncFromConfig: () => {
    const { config } = useConfigStore.getState();
    const live2dConfig = config.plugins?.live2d as
      | { enabled?: boolean; model_url?: string }
      | undefined;
    if (live2dConfig) {
      const updates: Partial<Live2DState> = {};
      if (typeof live2dConfig.enabled === "boolean") {
        updates.enabled = live2dConfig.enabled;
      }
      if (live2dConfig.model_url) {
        updates.modelUrl = live2dConfig.model_url;
      }
      if (Object.keys(updates).length > 0) {
        set(updates);
      }
    }
  },
}));
