import { useState, useEffect } from "react";
import { useConfigStore } from "@/store/useConfigStore";
import { Save } from "lucide-react";

export default function ModelPanel() {
  const { config, updateModelConfig } = useConfigStore();
  const [primary, setPrimary] = useState(config.model.primary_model);
  const [fallback, setFallback] = useState(config.model.fallback_model);
  const [retries, setRetries] = useState(String(config.model.max_retries));
  const [baseDelay, setBaseDelay] = useState(String(config.model.base_delay));
  const [maxDelay, setMaxDelay] = useState(String(config.model.max_delay));
  const [baseUrl, setBaseUrl] = useState(config.model.base_url || "");
  const [apiKey, setApiKey] = useState(config.model.api_key || "");
  const [compatMode, setCompatMode] = useState(config.model.compat_mode);

  useEffect(() => {
    setPrimary(config.model.primary_model);
    setFallback(config.model.fallback_model);
    setRetries(String(config.model.max_retries));
    setBaseDelay(String(config.model.base_delay));
    setMaxDelay(String(config.model.max_delay));
    setBaseUrl(config.model.base_url || "");
    setApiKey(config.model.api_key || "");
    setCompatMode(config.model.compat_mode);
  }, [config.model]);

  const handleSave = () => {
    updateModelConfig({
      primary_model: primary,
      fallback_model: fallback,
      max_retries: parseInt(retries || "3"),
      base_delay: parseFloat(baseDelay || "1.0"),
      max_delay: parseFloat(maxDelay || "30.0"),
      base_url: baseUrl.trim() || null,
      api_key: apiKey.trim() || null,
      compat_mode: compatMode,
    });
  };

  return (
    <div className="space-y-4">
      {/* 模型选择 */}
      <div className="space-y-3">
        <h3 className="text-xs font-semibold text-[var(--text)] uppercase tracking-wider">模型</h3>
        <div>
          <label className="block text-xs font-medium text-[var(--text-muted)] mb-1.5">主模型</label>
          <input
            type="text"
            value={primary}
            onChange={(e) => setPrimary(e.target.value)}
            placeholder="openai:gpt-4o"
            className="w-full px-3 py-2 rounded-lg bg-[var(--background)] border border-[var(--border)] text-sm text-[var(--text)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--primary)] font-mono"
          />
          <p className="mt-1 text-[10px] text-[var(--text-muted)]">格式: provider:model_name</p>
        </div>
        <div>
          <label className="block text-xs font-medium text-[var(--text-muted)] mb-1.5">降级模型</label>
          <input
            type="text"
            value={fallback}
            onChange={(e) => setFallback(e.target.value)}
            placeholder="openai:gpt-4o-mini"
            className="w-full px-3 py-2 rounded-lg bg-[var(--background)] border border-[var(--border)] text-sm text-[var(--text)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--primary)] font-mono"
          />
        </div>
      </div>

      {/* 重试策略 */}
      <div className="space-y-3 pt-3 border-t border-[var(--border)]">
        <h3 className="text-xs font-semibold text-[var(--text)] uppercase tracking-wider">重试策略</h3>
        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="block text-xs font-medium text-[var(--text-muted)] mb-1.5">最大重试次数</label>
            <input
              type="number"
              value={retries}
              onChange={(e) => setRetries(e.target.value)}
              placeholder="3"
              className="w-full px-3 py-2 rounded-lg bg-[var(--background)] border border-[var(--border)] text-sm text-[var(--text)] focus:outline-none focus:border-[var(--primary)] font-mono"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-[var(--text-muted)] mb-1.5">基础延迟 (秒)</label>
            <input
              type="number"
              step="0.5"
              value={baseDelay}
              onChange={(e) => setBaseDelay(e.target.value)}
              placeholder="1.0"
              className="w-full px-3 py-2 rounded-lg bg-[var(--background)] border border-[var(--border)] text-sm text-[var(--text)] focus:outline-none focus:border-[var(--primary)] font-mono"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-[var(--text-muted)] mb-1.5">最大延迟 (秒)</label>
            <input
              type="number"
              step="1"
              value={maxDelay}
              onChange={(e) => setMaxDelay(e.target.value)}
              placeholder="30.0"
              className="w-full px-3 py-2 rounded-lg bg-[var(--background)] border border-[var(--border)] text-sm text-[var(--text)] focus:outline-none focus:border-[var(--primary)] font-mono"
            />
          </div>
        </div>
      </div>

      {/* API 连接 */}
      <div className="space-y-3 pt-3 border-t border-[var(--border)]">
        <h3 className="text-xs font-semibold text-[var(--text)] uppercase tracking-wider">API 连接</h3>
        <div>
          <label className="block text-xs font-medium text-[var(--text-muted)] mb-1.5">Base URL</label>
          <input
            type="text"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="留空使用默认地址"
            className="w-full px-3 py-2 rounded-lg bg-[var(--background)] border border-[var(--border)] text-sm text-[var(--text)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--primary)] font-mono"
          />
          <p className="mt-1 text-[10px] text-[var(--text-muted)]">自定义 API 基础地址，留空使用默认</p>
        </div>
        <div>
          <label className="block text-xs font-medium text-[var(--text-muted)] mb-1.5">API Key</label>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="留空从环境变量读取"
            className="w-full px-3 py-2 rounded-lg bg-[var(--background)] border border-[var(--border)] text-sm text-[var(--text)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--primary)] font-mono"
          />
          <p className="mt-1 text-[10px] text-[var(--text-muted)]">API 密钥，留空时从环境变量读取</p>
        </div>
        <div className="flex items-center gap-3">
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              checked={compatMode}
              onChange={(e) => setCompatMode(e.target.checked)}
              className="sr-only peer"
            />
            <div className="w-9 h-5 bg-[var(--overlay)] peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-[var(--text)] after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-[var(--primary)]"></div>
          </label>
          <span className="text-xs text-[var(--text)]">兼容模式</span>
          <span className="text-[10px] text-[var(--text-muted)]">用于非标准 OpenAI API</span>
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
