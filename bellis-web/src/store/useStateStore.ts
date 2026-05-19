import { create } from "zustand";
import type { GUIState, GUIResponse, ServerMessage } from "@/types";
import { MOCK_STATE, MOCK_RESPONSE } from "@/utils/mock";

interface StateStore {
  state: GUIState;
  response: GUIResponse | null;
  updateState: (state: GUIState) => void;
  updateResponse: (response: GUIResponse) => void;
  startMockPolling: () => void;
  stopMockPolling: () => void;
}

let stateInterval: ReturnType<typeof setInterval> | null = null;

// 全局 WebSocket 引用，供 store 使用
let _ws: WebSocket | null = null;

export function setStateWS(ws: WebSocket | null) {
  _ws = ws;
}

export function handleStateWSMessage(data: string) {
  try {
    const msg: ServerMessage = JSON.parse(data);
    if (msg.type === "state") {
      useStateStore.getState().updateState(msg.payload);
    } else if (msg.type === "response") {
      useStateStore.getState().updateResponse(msg.payload);
    }
  } catch {
    // ignore
  }
}

export const useStateStore = create<StateStore>((set) => ({
  state: MOCK_STATE,
  response: MOCK_RESPONSE,
  updateState: (state) => set({ state }),
  updateResponse: (response) => set({ response }),
  startMockPolling: () => {
    if (stateInterval) return;
    stateInterval = setInterval(() => {
      const state = useStateStore.getState().state;
      set({
        state: {
          ...state,
          scene: {
            ...state.scene,
            viewer_count: Math.max(0, state.scene.viewer_count + Math.floor(Math.random() * 20 - 8)),
          },
          state_version: state.state_version + 1,
          event_queue_size: Math.floor(Math.random() * 30),
          tts_queue_size: Math.floor(Math.random() * 8),
        },
      });
    }, 2000);
  },
  stopMockPolling: () => {
    if (stateInterval) {
      clearInterval(stateInterval);
      stateInterval = null;
    }
  },
}));
