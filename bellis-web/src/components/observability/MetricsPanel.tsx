import type { GUIMetrics } from "@/types";
import { Package, Volume2, Zap, RefreshCw, BarChart3 } from "lucide-react";

interface MetricsPanelProps {
  metrics: GUIMetrics;
}

const metricItems = [
  { key: "event_queue_size" as const, label: "事件队列", icon: Package, color: "var(--primary)", bgColor: "rgba(137,180,250,0.15)" },
  { key: "tts_queue_size" as const, label: "TTS 队列", icon: Volume2, color: "var(--accent)", bgColor: "rgba(245,194,231,0.15)" },
  { key: "circuit_breaker_state" as const, label: "熔断器", icon: Zap, color: "var(--warning)", bgColor: "rgba(250,179,135,0.15)" },
  { key: "state_version" as const, label: "状态版本", icon: RefreshCw, color: "var(--success)", bgColor: "rgba(166,227,161,0.15)" },
  { key: "events_per_minute" as const, label: "事件速率", icon: BarChart3, color: "var(--danmaku)", bgColor: "rgba(137,180,250,0.15)" },
];

export default function MetricsPanel({ metrics }: MetricsPanelProps) {
  return (
    <div className="grid grid-cols-2 gap-3">
      {metricItems.map(({ key, label, icon: Icon, color, bgColor }) => {
        const value = metrics[key];
        const displayValue = typeof value === "number"
          ? key === "events_per_minute"
            ? `${value.toFixed(1)}/min`
            : String(value)
          : String(value);

        return (
          <div
            key={key}
            className="flex items-center gap-3 p-3 rounded-lg bg-[var(--background)] border border-[var(--border)]"
          >
            <div
              className="flex items-center justify-center w-8 h-8 rounded-lg"
              style={{ backgroundColor: bgColor }}
            >
              <Icon className="w-4 h-4" style={{ color }} />
            </div>
            <div>
              <p className="text-[10px] text-[var(--text-muted)]">{label}</p>
              <p className="text-sm font-mono font-semibold" style={{ color }}>
                {displayValue}
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
