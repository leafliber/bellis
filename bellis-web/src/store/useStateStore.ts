import { create } from "zustand";
import type { GUIState, GUIResponse } from "@/types";
import { DEFAULT_STATE } from "@/utils/mock";

interface StateStore {
  state: GUIState;
  response: GUIResponse | null;
  updateState: (state: GUIState) => void;
  updateResponse: (response: GUIResponse) => void;
}

export const useStateStore = create<StateStore>((set) => ({
  state: DEFAULT_STATE,
  response: null,
  updateState: (state) => set({ state }),
  updateResponse: (response) => set({ response }),
}));
