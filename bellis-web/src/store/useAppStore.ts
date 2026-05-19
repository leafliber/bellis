import { create } from "zustand";

interface AppStore {
  isAgentRunning: boolean;
  wsConnected: boolean;
  theme: "dark" | "light";
  setAgentRunning: (running: boolean) => void;
  setWsConnected: (connected: boolean) => void;
  toggleTheme: () => void;
  setTheme: (theme: "dark" | "light") => void;
}

export const useAppStore = create<AppStore>((set) => ({
  isAgentRunning: false,
  wsConnected: false,
  theme: "dark",
  setAgentRunning: (running) => set({ isAgentRunning: running }),
  setWsConnected: (connected) => set({ wsConnected: connected }),
  toggleTheme: () =>
    set((state) => ({ theme: state.theme === "dark" ? "light" : "dark" })),
  setTheme: (theme) => set({ theme }),
}));
