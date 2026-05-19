import type { Snapshot } from "@/types";
import { Camera, Clock } from "lucide-react";

interface SnapshotPanelProps {
  snapshots: Snapshot[];
  onTakeSnapshot: () => void;
}

export default function SnapshotPanel({ snapshots, onTakeSnapshot }: SnapshotPanelProps) {
  return (
    <div className="space-y-4">
      <button
        onClick={onTakeSnapshot}
        className="flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-medium bg-[var(--primary)]/20 text-[var(--primary)] hover:bg-[var(--primary)]/30 transition-all"
      >
        <Camera className="w-3.5 h-3.5" />
        拍摄快照
      </button>

      {snapshots.length === 0 ? (
        <div className="text-sm text-[var(--text-muted)] py-4 text-center">暂无快照</div>
      ) : (
        <div className="space-y-2">
          {[...snapshots].reverse().map((snap, i) => (
            <div
              key={i}
              className="flex items-center gap-3 px-3 py-2 rounded-lg bg-[var(--background)] border border-[var(--border)]"
            >
              <Clock className="w-3.5 h-3.5 text-[var(--text-muted)]" />
              <span className="text-xs text-[var(--text)]">
                #{snapshots.length - i} v{snap.state_version}
              </span>
              <span className="text-[10px] font-mono text-[var(--text-muted)] ml-auto">
                {snap._snapshot_time}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
