import { create } from "zustand";
import type { GUIState, GUIResponse } from "@/types";
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
