import type { GUIEmotionState } from "@/types";

interface EmotionDisplayProps {
  emotion: GUIEmotionState;
}

export default function EmotionDisplay({ emotion }: EmotionDisplayProps) {
  const percent = Math.round(emotion.intensity * 100);

  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <span className="text-2xl">{emotion.icon}</span>
      <div className="flex-1">
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: emotion.color }}>
            {emotion.current}
          </span>
          <span className="text-[10px] font-mono text-[var(--text-muted)]">{percent}%</span>
        </div>
        <div className="h-1.5 rounded-full bg-[var(--overlay)]/50 overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{
              width: `${percent}%`,
              backgroundColor: emotion.color,
              boxShadow: `0 0 8px ${emotion.color}40`,
            }}
          />
        </div>
      </div>
    </div>
  );
}
