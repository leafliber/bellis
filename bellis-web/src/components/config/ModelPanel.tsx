import { useState, useEffect } from "react";
import { useConfigStore } from "@/store/useConfigStore";
import { Save } from "lucide-react";

export default function ModelPanel() {
  const { config, updateModelConfig } = useConfigStore();
  const [primary, setPrimary] = useState(config.model.primary_model);
  const [fallback, setFallback] = useState(config.model.fallback_model);
  const [retries, setRetries] = useState(String(config.model.max_retries));
  const [temperature, setTemperature] = useState(String(config.model.temperature));

  useEffect(() => {
    setPrimary(config.model.primary_model);
    setFallback(config.model.fallback_model);
    setRetries(String(config.model.max_retries));
    setTemperature(String(config.model.temperature));
  }, [config.model]);

  const handleSave = () => {
    updateModelConfig({
      primary_model: primary,
      fallback_model: fallback,
      max_retries: parseInt(retries || "3"),
      temperature: parseFloat(temperature || "0.7"),
    });
  };

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-xs font-medium text-[var(--text-muted)] mb-1.5">主模型</label>
        <input
          type="text"
          value={primary}
          onChange={(e) => setPrimary(e.target.value)}
          placeholder="openai:gpt-4o"
          className="w-full px-3 py-2 rounded-lg bg-[var(--background)] border border-[var(--border)] text-sm text-[var(--text)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--primary)] transition-colors font-mono"
        />
      </div>
      <div>
        <label className="block text-xs font-medium text-[var(--text-muted)] mb-1.5">降级模型</label>
        <input
          type="text"
          value={fallback}
          onChange={(e) => setFallback(e.target.value)}
          placeholder="openai:gpt-4o-mini"
          className="w-full px-3 py-2 rounded-lg bg-[var(--background)] border border-[var(--border)] text-sm text-[var(--text)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--primary)] transition-colors font-mono"
        />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-xs font-medium text-[var(--text-muted)] mb-1.5">最大重试次数</label>
          <input
            type="number"
            value={retries}
            onChange={(e) => setRetries(e.target.value)}
            placeholder="3"
            className="w-full px-3 py-2 rounded-lg bg-[var(--background)] border border-[var(--border)] text-sm text-[var(--text)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--primary)] transition-colors font-mono"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-[var(--text-muted)] mb-1.5">Temperature</label>
          <input
            type="number"
            step="0.1"
            value={temperature}
            onChange={(e) => setTemperature(e.target.value)}
            placeholder="0.7"
            className="w-full px-3 py-2 rounded-lg bg-[var(--background)] border border-[var(--border)] text-sm text-[var(--text)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--primary)] transition-colors font-mono"
          />
        </div>
      </div>
      <button
        onClick={handleSave}
        className="flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-medium bg-[var(--primary)]/20 text-[var(--primary)] hover:bg-[var(--primary)]/30 transition-all"
      >
        <Save className="w-3.5 h-3.5" />
        保存模型配置
      </button>
    </div>
  );
}
