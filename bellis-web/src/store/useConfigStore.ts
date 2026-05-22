import { create } from "zustand";
import type { GUIConfig, GUIPersonaConfig, ClientMessage } from "@/types";
import { DEFAULT_CONFIG } from "@/utils/mock";
import { useEventStore } from "./useEventStore";

interface ConfigStore {
  config: GUIConfig;
  updateConfig: (config: GUIConfig) => void;
  switchPersona: (name: string) => void;
  registerPersona: (persona: GUIPersonaConfig) => void;
  updateModelConfig: (updates: Partial<GUIConfig["model"]>) => void;
  updatePlatformConfig: (updates: Partial<GUIConfig["platform"]>) => void;
  updatePluginConfig: (pluginName: string, updates: Record<string, unknown>) => void;
  reloadConfig: () => void;
}

function sendToBackend(msg: ClientMessage) {
  const { wsConnected, sendWS } = useEventStore.getState();
  if (wsConnected) {
    sendWS(msg);
  }
}

export const useConfigStore = create<ConfigStore>((set) => ({
  config: DEFAULT_CONFIG,
  updateConfig: (config) => set({ config }),
  switchPersona: (name) => {
    set((state) => ({
      config: { ...state.config, active_persona: name },
    }));
    sendToBackend({ type: "switch_persona", payload: { name } });
  },
  registerPersona: (persona) => {
    set((state) => ({
      config: {
        ...state.config,
        personas: { ...state.config.personas, [persona.name]: persona },
      },
    }));
    sendToBackend({
      type: "update_config",
      payload: { personas: { [persona.name]: persona } },
    });
  },
  updateModelConfig: (updates) => {
    set((state) => ({
      config: { ...state.config, model: { ...state.config.model, ...updates } },
    }));
    sendToBackend({
      type: "update_config",
      payload: { model: updates },
    });
  },
  updatePlatformConfig: (updates) => {
    set((state) => ({
      config: { ...state.config, platform: { ...state.config.platform, ...updates } },
    }));
    sendToBackend({
      type: "update_config",
      payload: { platform: updates },
    });
  },
  updatePluginConfig: (pluginName, updates) => {
    set((state) => ({
      config: {
        ...state.config,
        plugins: { ...state.config.plugins, [pluginName]: updates },
      },
    }));
    sendToBackend({
      type: "update_config",
      payload: { plugins: { [pluginName]: updates } },
    });
  },
  reloadConfig: () => {
    sendToBackend({ type: "reload_config" });
  },
}));
