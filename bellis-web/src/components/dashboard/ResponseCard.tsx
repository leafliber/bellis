import { useStateStore } from "@/store/useStateStore";
import { MessageSquare } from "lucide-react";
import { EMOTION_ICONS } from "@/utils/constants";

export default function ResponseCard() {
  const response = useStateStore((s) => s.response);

  if (!response) {
    return (
      <div className="rounded-xl bg-[var(--surface)] border border-[var(--border)] p-4">
        <div className="flex items-center gap-2 mb-2">
          <MessageSquare className="w-4 h-4 text-[var(--primary)]" />
          <h2 className="text-sm font-semibold text-[var(--text)]">最新回复</h2>
        </div>
        <p className="text-xs text-[var(--text-muted)]">等待回复...</p>
      </div>
    );
  }

  return (
    <div className="rounded-xl bg-[var(--surface)] border border-[var(--border)] overflow-hidden gradient-border">
      <div className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <MessageSquare className="w-4 h-4 text-[var(--primary)]" />
          <h2 className="text-sm font-semibold text-[var(--text)]">最新回复</h2>
        </div>
        <p className="text-sm text-[var(--text)] mb-3 leading-relaxed">{response.text}</p>
        <div className="flex flex-wrap items-center gap-2 text-[10px]">
          <span className="px-2 py-0.5 rounded-full bg-[var(--primary)]/15 text-[var(--primary)]">
            {EMOTION_ICONS[response.emotion]} {response.emotion}
          </span>
          <span className="px-2 py-0.5 rounded-full bg-[var(--accent)]/15 text-[var(--accent)]">
            {response.motion}
          </span>
          <span className="px-2 py-0.5 rounded-full bg-[var(--overlay)]/50 text-[var(--text-muted)] font-mono">
            {response.tts_speed.toFixed(1)}x
          </span>
          <span className="px-2 py-0.5 rounded-full bg-[var(--overlay)]/50 text-[var(--text-muted)] font-mono">
            {response.motion_duration.toFixed(1)}s
          </span>
          {response.target_user && (
            <span className="px-2 py-0.5 rounded-full bg-[var(--warning)]/15 text-[var(--warning)]">
              @{response.target_user}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
