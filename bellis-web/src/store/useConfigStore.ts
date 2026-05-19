import { create } from "zustand";
import type { GUIConfig, GUIPersonaConfig } from "@/types";
import { MOCK_CONFIG } from "@/utils/mock";

interface ConfigStore {
  config: GUIConfig;
  updateConfig: (config: GUIConfig) => void;
  switchPersona: (name: string) => void;
  registerPersona: (persona: GUIPersonaConfig) => void;
  updateModelConfig: (updates: Partial<GUIConfig["model"]>) => void;
  updatePlatformConfig: (updates: Partial<GUIConfig["platform"]>) => void;
  reloadConfig: () => void;
}

export const useConfigStore = create<ConfigStore>((set) => ({
  config: MOCK_CONFIG,
  updateConfig: (config) => set({ config }),
  switchPersona: (name) =>
    set((state) => ({
      config: { ...state.config, active_persona: name },
    })),
  registerPersona: (persona) =>
    set((state) => ({
      config: {
        ...state.config,
        personas: { ...state.config.personas, [persona.name]: persona },
      },
    })),
  updateModelConfig: (updates) =>
    set((state) => ({
      config: { ...state.config, model: { ...state.config.model, ...updates } },
    })),
  updatePlatformConfig: (updates) =>
    set((state) => ({
      config: { ...state.config, platform: { ...state.config.platform, ...updates } },
    })),
  reloadConfig: () => {
    // In production, this would call the API
    set({ config: MOCK_CONFIG });
  },
}));
