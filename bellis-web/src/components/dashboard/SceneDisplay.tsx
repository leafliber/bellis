import type { GUISceneContext } from "@/types";
import { Tv, Users, MessageCircle, Clock } from "lucide-react";

interface SceneDisplayProps {
  scene: GUISceneContext;
}

export default function SceneDisplay({ scene }: SceneDisplayProps) {
  return (
    <div className="px-4 py-3 space-y-2">
      <div className="flex items-center gap-2">
        <Tv className="w-3.5 h-3.5 text-[var(--primary)]" />
        <span className="text-xs text-[var(--text)]">{scene.stream_title || "未设置"}</span>
      </div>
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-1.5">
          <Users className="w-3.5 h-3.5 text-[var(--accent)]" />
          <span className="text-xs text-[var(--text)]">{scene.streamer_name || "未知"}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <MessageCircle className="w-3.5 h-3.5 text-[var(--success)]" />
          <span className="text-xs font-mono text-[var(--text)]">{scene.viewer_count.toLocaleString()}</span>
        </div>
      </div>
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-[var(--text-muted)]">话题:</span>
          <span className="text-xs text-[var(--text)]">{scene.topic || "无"}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Clock className="w-3 h-3 text-[var(--warning)]" />
          <span className="text-xs text-[var(--text)]">{scene.phase}</span>
        </div>
      </div>
    </div>
  );
}
