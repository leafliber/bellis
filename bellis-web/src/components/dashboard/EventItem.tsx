import type { GUIEvent } from "@/types";
import { SOURCE_LABELS } from "@/utils/constants";
import { cn } from "@/lib/utils";

interface EventItemProps {
  event: GUIEvent;
}

const sourceColorMap: Record<string, string> = {
  danmaku: "var(--danmaku)",
  gift: "var(--gift)",
  command: "var(--command)",
  rag: "var(--primary)",
  system: "var(--system)",
};

export default function EventItem({ event }: EventItemProps) {
  const time = new Date(event.timestamp).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const color = sourceColorMap[event.source] || "var(--text-muted)";

  return (
    <div className="flex items-start gap-2 px-3 py-1.5 hover:bg-[var(--overlay)]/20 transition-colors animate-slide-in">
      <span className="font-mono text-[11px] text-[var(--text-muted)] shrink-0 pt-0.5">
        {time}
      </span>
      <span
        className="text-[10px] font-medium px-1.5 py-0.5 rounded shrink-0"
        style={{
          color: color,
          backgroundColor: `color-mix(in srgb, ${color} 15%, transparent)`,
        }}
      >
        {SOURCE_LABELS[event.source]}
      </span>
      {event.user_name && (
        <span className="text-xs text-[var(--accent)] shrink-0">
          [{event.user_name}]
        </span>
      )}
      <span className="text-xs text-[var(--text)] truncate">{event.display_text}</span>
    </div>
  );
}
