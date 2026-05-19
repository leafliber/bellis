import { useState } from "react";
import PersonaPanel from "@/components/config/PersonaPanel";
import ModelPanel from "@/components/config/ModelPanel";
import PlatformPanel from "@/components/config/PlatformPanel";
import { useConfigStore } from "@/store/useConfigStore";
import { RefreshCw, User, Cpu, Wifi } from "lucide-react";
import { cn } from "@/lib/utils";

const tabs = [
  { id: "persona", label: "Persona", icon: User },
  { id: "model", label: "Model", icon: Cpu },
  { id: "platform", label: "Platform", icon: Wifi },
] as const;

type TabId = (typeof tabs)[number]["id"];

export default function Config() {
  const [activeTab, setActiveTab] = useState<TabId>("persona");
  const { reloadConfig } = useConfigStore();

  return (
    <div className="flex flex-col h-full p-6">
      <div className="max-w-3xl mx-auto w-full flex flex-col h-full">
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
          {activeTab === "persona" && <PersonaPanel />}
          {activeTab === "model" && <ModelPanel />}
          {activeTab === "platform" && <PlatformPanel />}
        </div>

        {/* Reload button */}
        <div className="pt-4 border-t border-[var(--border)] mt-4">
          <button
            onClick={reloadConfig}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-medium bg-[var(--warning)]/20 text-[var(--warning)] hover:bg-[var(--warning)]/30 transition-all"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            重新加载配置 (YAML)
          </button>
        </div>
      </div>
    </div>
  );
}
