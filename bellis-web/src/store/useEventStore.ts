import { create } from "zustand";
import type { GUIEvent, ServerMessage, ClientMessage } from "@/types";
import { MAX_EVENTS } from "@/utils/constants";
import { useStateStore } from "@/store/useStateStore";
import { useObservabilityStore } from "@/store/useObservabilityStore";
import { useConfigStore } from "@/store/useConfigStore";
import { useLive2DStore } from "@/store/useLive2DStore";

interface EventState {
  events: GUIEvent[];
  addEvent: (event: GUIEvent) => void;
  clearEvents: () => void;
  connectWS: (url: string) => void;
  disconnectWS: () => void;
  sendWS: (msg: ClientMessage) => void;
  wsConnected: boolean;
}

let ws: WebSocket | null = null;

function handleWSMessage(data: string) {
  try {
    const msg: ServerMessage = JSON.parse(data);
    switch (msg.type) {
      case "event":
        useEventStore.getState().addEvent(msg.payload);
        break;
      case "state":
        useStateStore.getState().updateState(msg.payload);
        break;
      case "response":
        useStateStore.getState().updateResponse(msg.payload);
        break;
      case "metrics":
        useObservabilityStore.getState().updateMetrics(msg.payload);
        break;
      case "trace":
        useObservabilityStore.getState().updateTraces(msg.payload.spans);
        break;
      case "config":
        useConfigStore.getState().updateConfig(msg.payload);
        // 同步 Live2D 配置到 Live2D Store
        useLive2DStore.getState().syncFromConfig();
        break;
      case "live2d":
        useLive2DStore.getState().enqueueCommand(msg.payload);
        break;
    }
  } catch {
    // ignore
  }
}

export const useEventStore = create<EventState>((set, get) => ({
  events: [],
  wsConnected: false,
  addEvent: (event) =>
    set((state) => {
      const events = [...state.events, event];
      if (events.length > MAX_EVENTS) {
        return { events: events.slice(-MAX_EVENTS) };
      }
      return { events };
    }),
  clearEvents: () => set({ events: [] }),
  connectWS: (url: string) => {
    if (ws) return;
    ws = new WebSocket(url);
    ws.onopen = () => {
      set({ wsConnected: true });
      console.log("[WS] Connected to", url);
    };
    ws.onmessage = (e) => {
      if (typeof e.data === "string") {
        handleWSMessage(e.data);
      }
    };
    ws.onclose = () => {
      set({ wsConnected: false });
      ws = null;
      console.log("[WS] Disconnected");
    };
    ws.onerror = () => {
      ws?.close();
    };
  },
  disconnectWS: () => {
    if (ws) {
      ws.close();
      ws = null;
    }
    set({ wsConnected: false });
  },
  sendWS: (msg) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  },
}));
