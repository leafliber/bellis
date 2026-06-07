import { useState } from "react";
import { Play, Square, Send, ChevronDown, Wifi, WifiOff, AlertCircle } from "lucide-react";
import { useAppStore } from "@/store/useAppStore";
import { useConfigStore } from "@/store/useConfigStore";
import { useEventStore } from "@/store/useEventStore";
import { cn } from "@/lib/utils";

export default function ControlBar() {
  const { isAgentRunning, setAgentRunning } = useAppStore();
  const { config, switchPersona } = useConfigStore();
  const { connectWS, disconnectWS, sendWS, wsConnected } = useEventStore();
  const [command, setCommand] = useState("");
  const [personaOpen, setPersonaOpen] = useState(false);
  const [wsUrl, setWsUrl] = useState("ws://localhost:8765");
  const [disconnectedWarning, setDisconnectedWarning] = useState(false);

  const handleStart = () => {
    if (!wsConnected) {
      setDisconnectedWarning(true);
      setTimeout(() => setDisconnectedWarning(false), 3000);
      return;
    }
    setAgentRunning(true);
    sendWS({ type: "start_agent" });
  };

  const handleStop = () => {
    setAgentRunning(false);
    if (wsConnected) {
      sendWS({ type: "stop_agent" });
    }
  };

  const handleConnectWS = () => {
    if (wsConnected) {
      disconnectWS();
      return;
    }
    if (wsUrl.trim()) {
      connectWS(wsUrl.trim());
    }
  };

  const handleCommand = () => {
    if (!command.trim()) return;
    if (wsConnected) {
      sendWS({ type: "command", payload: { command, user_name: "你" } });
    }
    setCommand("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleCommand();
    }
  };

  const handleSwitchPersona = (name: string) => {
    switchPersona(name);
    setPersonaOpen(false);
    if (wsConnected) {
      sendWS({ type: "switch_persona", payload: { name } });
    }
  };

  return (
    <div className="flex items-center gap-3 px-4 py-3 bg-[var(--surface)] border-t border-[var(--border)] relative">
      {/* 未连接提示 */}
      {disconnectedWarning && (
        <div className="absolute -top-10 left-1/2 -translate-x-1/2 flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--warning)]/20 text-[var(--warning)] text-xs font-medium whitespace-nowrap animate-pulse">
          <AlertCircle className="w-3.5 h-3.5" />
          请先连接后端
        </div>
      )}
      {/* Start/Stop buttons */}
      <button
        onClick={handleStart}
        disabled={isAgentRunning}
        className={cn(
          "flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium transition-all",
          isAgentRunning
            ? "bg-[var(--overlay)]/30 text-[var(--text-muted)] cursor-not-allowed"
            : "bg-[var(--success)]/20 text-[var(--success)] hover:bg-[var(--success)]/30 glow-success"
        )}
      >
        <Play className="w-3.5 h-3.5" />
        启动
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

      {/* WebSocket 连接 */}
      <div className="flex items-center gap-1.5">
        <input
          type="text"
          value={wsUrl}
          onChange={(e) => setWsUrl(e.target.value)}
          placeholder="ws://host:port"
          className="w-36 px-2 py-1.5 rounded-lg bg-[var(--background)] border border-[var(--border)] text-xs text-[var(--text)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--primary)] transition-colors"
        />
        <button
          onClick={handleConnectWS}
          className={cn(
            "flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-all",
            wsConnected
              ? "bg-[var(--primary)]/20 text-[var(--primary)] hover:bg-[var(--primary)]/30"
              : "bg-[var(--warning)]/20 text-[var(--warning)] hover:bg-[var(--warning)]/30"
          )}
        >
          {wsConnected ? <Wifi className="w-3.5 h-3.5" /> : <WifiOff className="w-3.5 h-3.5" />}
          {wsConnected ? "已连接" : "连接"}
        </button>
      </div>

      {/* Persona selector */}
      <div className="relative">
        <button
          onClick={() => setPersonaOpen(!personaOpen)}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium bg-[var(--overlay)]/30 text-[var(--text)] hover:bg-[var(--overlay)]/50 transition-all"
        >
          {config.active_persona || "人设"}
          <ChevronDown className="w-3 h-3" />
        </button>
        {personaOpen && (
          <div className="absolute bottom-full left-0 mb-1 w-40 rounded-lg bg-[var(--surface)] border border-[var(--border)] shadow-xl z-50 overflow-hidden">
            {Object.keys(config.personas).map((name) => (
              <button
                key={name}
                onClick={() => {
                  handleSwitchPersona(name);
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
