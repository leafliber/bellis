import { create } from "zustand";
import type { GUIEvent, ServerMessage, ClientMessage } from "@/types";
import { MAX_EVENTS } from "@/utils/constants";
import { createMockEvent } from "@/utils/mock";
import { useStateStore } from "@/store/useStateStore";
import { useObservabilityStore } from "@/store/useObservabilityStore";
import { useConfigStore } from "@/store/useConfigStore";

interface EventState {
  events: GUIEvent[];
  addEvent: (event: GUIEvent) => void;
  clearEvents: () => void;
  startMockStream: () => void;
  stopMockStream: () => void;
  connectWS: (url?: string) => void;
  disconnectWS: () => void;
  sendWS: (msg: ClientMessage) => void;
  wsConnected: boolean;
}

let mockInterval: ReturnType<typeof setInterval> | null = null;
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
      case "config":
        useConfigStore.getState().updateConfig(msg.payload);
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
  startMockStream: () => {
    if (mockInterval) return;
    mockInterval = setInterval(() => {
      const event = createMockEvent();
      useEventStore.getState().addEvent(event);
    }, 800 + Math.random() * 1200);
  },
  stopMockStream: () => {
    if (mockInterval) {
      clearInterval(mockInterval);
      mockInterval = null;
    }
  },
  connectWS: (url = "ws://localhost:8765") => {
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
