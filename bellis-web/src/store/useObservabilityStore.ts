import { create } from "zustand";
import type { GUITraceSpan, GUIMetrics, Snapshot } from "@/types";
import { MOCK_TRACES, MOCK_METRICS, MOCK_SNAPSHOTS } from "@/utils/mock";

interface ObservabilityStore {
  traces: GUITraceSpan[];
  metrics: GUIMetrics;
  snapshots: Snapshot[];
  updateTraces: (traces: GUITraceSpan[]) => void;
  updateMetrics: (metrics: GUIMetrics) => void;
  addSnapshot: (snapshot: Snapshot) => void;
  startMockPolling: () => void;
  stopMockPolling: () => void;
}

let obsInterval: ReturnType<typeof setInterval> | null = null;

export const useObservabilityStore = create<ObservabilityStore>((set) => ({
  traces: MOCK_TRACES,
  metrics: MOCK_METRICS,
  snapshots: MOCK_SNAPSHOTS,
  updateTraces: (traces) => set({ traces }),
  updateMetrics: (metrics) => set({ metrics }),
  addSnapshot: (snapshot) =>
    set((state) => ({ snapshots: [...state.snapshots, snapshot] })),
  startMockPolling: () => {
    if (obsInterval) return;
    obsInterval = setInterval(() => {
      set((state) => ({
        metrics: {
          ...state.metrics,
          event_queue_size: Math.floor(Math.random() * 30),
          tts_queue_size: Math.floor(Math.random() * 8),
          state_version: state.metrics.state_version + 1,
          events_per_minute: Math.round((15 + Math.random() * 20) * 10) / 10,
        },
      }));
    }, 2000);
  },
  stopMockPolling: () => {
    if (obsInterval) {
      clearInterval(obsInterval);
      obsInterval = null;
    }
  },
}));
