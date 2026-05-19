import { useStateStore } from "@/store/useStateStore";
import EmotionDisplay from "./EmotionDisplay";
import SceneDisplay from "./SceneDisplay";
import ActionList from "./ActionList";
import { Cpu } from "lucide-react";

export default function StatePanel() {
  const state = useStateStore((s) => s.state);

  return (
    <div className="flex flex-col rounded-xl bg-[var(--surface)] border border-[var(--border)] overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--border)]">
        <Cpu className="w-4 h-4 text-[var(--accent)]" />
        <h2 className="text-sm font-semibold text-[var(--text)]">智能体状态</h2>
        <span className="ml-auto text-[10px] font-mono text-[var(--text-muted)]">
          v{state.state_version}
        </span>
      </div>
      <EmotionDisplay emotion={state.emotion} />
      <div className="border-t border-[var(--border)]" />
      <SceneDisplay scene={state.scene} />
      <div className="border-t border-[var(--border)]" />
      <div className="px-4 py-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
          最近行为
        </span>
      </div>
      <ActionList actions={state.recent_actions} />
    </div>
  );
}
