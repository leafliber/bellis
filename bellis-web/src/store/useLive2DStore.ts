import { create } from "zustand";
import type { Live2DCommand } from "@/types/live2d";

/** 默认 Live2D 测试模型（Haru — Cubism 4，来自 pixi-live2d-display 仓库） */
const DEFAULT_MODEL_URL =
  "https://cdn.jsdelivr.net/gh/guansss/pixi-live2d-display/test/assets/haru/haru_greeter_t03.model3.json";

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
}));
