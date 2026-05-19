import type { GUIActionRecord } from "@/types";
import { EMOTION_ICONS } from "@/utils/constants";

interface ActionListProps {
  actions: GUIActionRecord[];
}

export default function ActionList({ actions }: ActionListProps) {
  if (actions.length === 0) {
    return (
      <div className="px-4 py-3 text-xs text-[var(--text-muted)]">暂无行为记录</div>
    );
  }

  return (
    <div className="px-4 py-2 space-y-1.5">
      {actions.map((action, i) => (
        <div key={i} className="flex items-start gap-2 text-xs">
          <span className="shrink-0">{EMOTION_ICONS[action.emotion] || "😐"}</span>
          <span className="text-[var(--text-muted)]">•</span>
          <span className="text-[var(--text)]">{action.description}</span>
        </div>
      ))}
    </div>
  );
}
