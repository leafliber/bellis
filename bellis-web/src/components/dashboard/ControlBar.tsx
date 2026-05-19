import { useState } from "react";
import { Play, Square, Send, ChevronDown, Wifi, WifiOff } from "lucide-react";
import { useAppStore } from "@/store/useAppStore";
import { useConfigStore } from "@/store/useConfigStore";
import { useEventStore } from "@/store/useEventStore";
import { useStateStore, handleStateWSMessage } from "@/store/useStateStore";
import { useObservabilityStore } from "@/store/useObservabilityStore";
import { cn } from "@/lib/utils";

let _ws: WebSocket | null = null;

export default function ControlBar() {
  const { isAgentRunning, setAgentRunning, wsConnected, setWsConnected } = useAppStore();
  const { config, switchPersona } = useConfigStore();
  const { startMockStream, stopMockStream, connectWS, disconnectWS, wsConnected: eventWsConnected } = useEventStore();
  const { startMockPolling: startStatePolling, stopMockPolling: stopStatePolling } = useStateStore();
  const { startMockPolling: startObsPolling, stopMockPolling: stopObsPolling } = useObservabilityStore();
  const [command, setCommand] = useState("");
  const [personaOpen, setPersonaOpen] = useState(false);

  const handleStart = () => {
    setAgentRunning(true);
    startMockStream();
    startStatePolling();
    startObsPolling();
  };

  const handleStop = () => {
    setAgentRunning(false);
    stopMockStream();
    stopStatePolling();
    stopObsPolling();
  };

  const handleConnectWS = () => {
    if (_ws) {
      _ws.close();
      _ws = null;
      setWsConnected(false);
      disconnectWS();
      return;
    }

    const url = "ws://localhost:8765";
    _ws = new WebSocket(url);

    _ws.onopen = () => {
      setWsConnected(true);
      setAgentRunning(true);
      connectWS(url);
      console.log("[WS] Connected to backend");
    };

    _ws.onmessage = (e) => {
      if (typeof e.data !== "string") return;
      // 分发给各 store
      handleStateWSMessage(e.data);
      // event store 的消息由 connectWS 内部处理
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "event") {
          useEventStore.getState().addEvent(msg.payload);
        }
      } catch {
        // ignore
      }
    };

    _ws.onclose = () => {
      setWsConnected(false);
      disconnectWS();
      _ws = null;
      console.log("[WS] Disconnected");
    };

    _ws.onerror = () => {
      _ws?.close();
    };
  };

  const handleCommand = () => {
    if (!command.trim()) return;
    if (_ws && _ws.readyState === WebSocket.OPEN) {
      _ws.send(JSON.stringify({ type: "command", payload: { command } }));
    } else {
      console.log("Command (mock):", command);
    }
    setCommand("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleCommand();
    }
  };

  return (
    <div className="flex items-center gap-3 px-4 py-3 bg-[var(--surface)] border-t border-[var(--border)]">
      {/* Start/Stop buttons */}
      <button
        onClick={handleStart}
        disabled={isAgentRunning && !wsConnected}
        className={cn(
          "flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium transition-all",
          isAgentRunning && !wsConnected
            ? "bg-[var(--overlay)]/30 text-[var(--text-muted)] cursor-not-allowed"
            : "bg-[var(--success)]/20 text-[var(--success)] hover:bg-[var(--success)]/30 glow-success"
        )}
      >
        <Play className="w-3.5 h-3.5" />
        Mock
      </button>
      <button
        onClick={handleStop}
        disabled={!isAgentRunning}
        className={cn(
          "flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium transition-all",
          !isAgentRunning
            ? "bg-[var(--overlay)]/30 text-[var(--text-muted)] cursor-not-allowed"
            : "bg-[var(--error)]/20 text-[var(--error)] hover:bg-[var(--error)]/30 glow-error"
        )}
      >
        <Square className="w-3.5 h-3.5" />
        停止
      </button>

      {/* WebSocket 连接按钮 */}
      <button
        onClick={handleConnectWS}
        className={cn(
          "flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium transition-all",
          wsConnected
            ? "bg-[var(--primary)]/20 text-[var(--primary)] hover:bg-[var(--primary)]/30"
            : "bg-[var(--warning)]/20 text-[var(--warning)] hover:bg-[var(--warning)]/30"
        )}
      >
        {wsConnected ? <Wifi className="w-3.5 h-3.5" /> : <WifiOff className="w-3.5 h-3.5" />}
        {wsConnected ? "已连接" : "连接后端"}
      </button>

      {/* Persona selector */}
      <div className="relative">
        <button
          onClick={() => setPersonaOpen(!personaOpen)}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium bg-[var(--overlay)]/30 text-[var(--text)] hover:bg-[var(--overlay)]/50 transition-all"
        >
          {config.active_persona}
          <ChevronDown className="w-3 h-3" />
        </button>
        {personaOpen && (
          <div className="absolute bottom-full left-0 mb-1 w-40 rounded-lg bg-[var(--surface)] border border-[var(--border)] shadow-xl z-50 overflow-hidden">
            {Object.keys(config.personas).map((name) => (
              <button
                key={name}
                onClick={() => {
                  switchPersona(name);
                  setPersonaOpen(false);
                }}
                className={cn(
                  "w-full text-left px-3 py-2 text-xs transition-colors",
                  name === config.active_persona
                    ? "bg-[var(--primary)]/15 text-[var(--primary)]"
                    : "text-[var(--text)] hover:bg-[var(--overlay)]/30"
                )}
              >
                {name}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Command input */}
      <div className="flex-1 flex items-center gap-2">
        <input
          type="text"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="发送弹幕..."
          className="flex-1 px-3 py-2 rounded-lg bg-[var(--background)] border border-[var(--border)] text-xs text-[var(--text)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--primary)] transition-colors"
        />
        <button
          onClick={handleCommand}
          disabled={!command.trim()}
          className={cn(
            "flex items-center gap-1 px-3 py-2 rounded-lg text-xs font-medium transition-all",
            command.trim()
              ? "bg-[var(--primary)]/20 text-[var(--primary)] hover:bg-[var(--primary)]/30"
              : "bg-[var(--overlay)]/30 text-[var(--text-muted)] cursor-not-allowed"
          )}
        >
          <Send className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
