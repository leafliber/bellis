import { useState } from "react";
import TracePanel from "@/components/observability/TracePanel";
import MetricsPanel from "@/components/observability/MetricsPanel";
import SnapshotPanel from "@/components/observability/SnapshotPanel";
import { useObservabilityStore } from "@/store/useObservabilityStore";
import { Activity, BarChart3, Camera } from "lucide-react";
import { cn } from "@/lib/utils";

const tabs = [
  { id: "traces", label: "Traces", icon: Activity },
  { id: "metrics", label: "Metrics", icon: BarChart3 },
  { id: "snapshots", label: "Snapshots", icon: Camera },
] as const;

type TabId = (typeof tabs)[number]["id"];

export default function Observability() {
  const [activeTab, setActiveTab] = useState<TabId>("traces");
  const { traces, metrics, snapshots, addSnapshot } = useObservabilityStore();

  const handleTakeSnapshot = () => {
    addSnapshot({
      _snapshot_time: new Date().toLocaleString("zh-CN"),
      state_version: metrics.state_version,
    });
  };

  return (
    <div className="flex flex-col h-full p-6">
      <div className="max-w-4xl mx-auto w-full flex flex-col h-full">
        {/* Tabs */}
        <div className="flex items-center gap-1 border-b border-[var(--border)] mb-6">
          {tabs.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className={cn(
                "flex items-center gap-2 px-4 py-3 text-sm font-medium transition-all border-b-2 -mb-px",
                activeTab === id
                  ? "text-[var(--primary)] border-[var(--primary)]"
                  : "text-[var(--text-muted)] border-transparent hover:text-[var(--text)]"
              )}
            >
              <Icon className="w-4 h-4" />
              {label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="flex-1 overflow-y-auto">
          {activeTab === "traces" && <TracePanel traces={traces} />}
          {activeTab === "metrics" && <MetricsPanel metrics={metrics} />}
          {activeTab === "snapshots" && (
            <SnapshotPanel snapshots={snapshots} onTakeSnapshot={handleTakeSnapshot} />
          )}
        </div>
      </div>
    </div>
  );
}
