import { create } from "zustand";
import type { GUITraceSpan, GUIMetrics, Snapshot } from "@/types";

interface ObservabilityStore {
  traces: GUITraceSpan[];
  metrics: GUIMetrics;
  snapshots: Snapshot[];
  updateTraces: (traces: GUITraceSpan[]) => void;
  updateMetrics: (metrics: GUIMetrics) => void;
  addSnapshot: (snapshot: Snapshot) => void;
}

const DEFAULT_METRICS: GUIMetrics = {
  event_queue_size: 0,
  tts_queue_size: 0,
  circuit_breaker_state: "closed",
  state_version: 0,
  events_per_minute: 0,
};

export const useObservabilityStore = create<ObservabilityStore>((set) => ({
  traces: [],
  metrics: DEFAULT_METRICS,
  snapshots: [],
  updateTraces: (traces) => set({ traces }),
  updateMetrics: (metrics) => set({ metrics }),
  addSnapshot: (snapshot) =>
    set((state) => ({ snapshots: [...state.snapshots, snapshot] })),
}));
