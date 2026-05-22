import { useState, useEffect } from "react";
import { useConfigStore } from "@/store/useConfigStore";
import { Save, ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PluginConfigField, PluginSchema } from "@/types";

/** 根据 schema 字段类型渲染对应的输入控件 */
function FieldInput({
  field,
  value,
  onChange,
}: {
  fieldKey: string;
  field: PluginConfigField;
  value: unknown;
  onChange: (val: unknown) => void;
}) {
  switch (field.type) {
    case "bool":
      return (
        <label className="relative inline-flex items-center cursor-pointer">
          <input
            type="checkbox"
            checked={!!value}
            onChange={(e) => onChange(e.target.checked)}
            className="sr-only peer"
          />
          <div className="w-9 h-5 bg-[var(--overlay)] peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-[var(--text)] after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-[var(--primary)]"></div>
        </label>
      );
    case "int":
      return (
        <input
          type="number"
          step="1"
          value={value as number}
          onChange={(e) => onChange(parseInt(e.target.value) || 0)}
          className="w-full px-3 py-2 rounded-lg bg-[var(--background)] border border-[var(--border)] text-sm text-[var(--text)] focus:outline-none focus:border-[var(--primary)] font-mono"
        />
      );
    case "float":
      return (
        <input
          type="number"
          step="0.1"
          value={value as number}
          onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
          className="w-full px-3 py-2 rounded-lg bg-[var(--background)] border border-[var(--border)] text-sm text-[var(--text)] focus:outline-none focus:border-[var(--primary)] font-mono"
        />
      );
    case "enum":
      return (
        <select
          value={(value as string) || String(field.default ?? "")}
          onChange={(e) => onChange(e.target.value)}
          className="w-full px-3 py-2 rounded-lg bg-[var(--background)] border border-[var(--border)] text-sm text-[var(--text)] focus:outline-none focus:border-[var(--primary)] font-mono appearance-none cursor-pointer"
        >
          {(field.options || []).map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      );
    case "str":
    default:
      return (
        <input
          type="text"
          value={(value as string) || ""}
          onChange={(e) => onChange(e.target.value)}
          placeholder={String(field.default ?? "")}
          className="w-full px-3 py-2 rounded-lg bg-[var(--background)] border border-[var(--border)] text-sm text-[var(--text)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--primary)] font-mono"
        />
      );
  }
}

/** 有 schema 的插件：结构化表单 */
function SchemaPluginCard({
  pluginName,
  schema,
  config,
  onSave,
}: {
  pluginName: string;
  schema: PluginSchema;
  config: Record<string, unknown>;
  onSave: (config: Record<string, unknown>) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const [editConfig, setEditConfig] = useState<Record<string, unknown>>({ ...config });

  useEffect(() => {
    setEditConfig({ ...config });
  }, [config]);

  return (
    <div className="border border-[var(--border)] rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-4 py-3 bg-[var(--overlay)]/20 hover:bg-[var(--overlay)]/30 transition-colors"
      >
        {expanded ? <ChevronDown className="w-3.5 h-3.5 text-[var(--text-muted)]" /> : <ChevronRight className="w-3.5 h-3.5 text-[var(--text-muted)]" />}
        <span className="text-sm font-medium text-[var(--text)]">{schema.meta.name || pluginName}</span>
        {schema.meta.description && (
          <span className="text-xs text-[var(--text-muted)] ml-1">— {schema.meta.description}</span>
        )}
        <span className={cn(
          "ml-auto text-[10px] px-2 py-0.5 rounded-full font-medium",
          schema.meta.category === "input" ? "bg-[var(--primary)]/15 text-[var(--primary)]" :
          schema.meta.category === "output" ? "bg-[var(--success)]/15 text-[var(--success)]" :
          "bg-[var(--overlay)]/30 text-[var(--text-muted)]"
        )}>
          {schema.meta.category}
        </span>
      </button>
      {expanded && (
        <div className="px-4 py-3 space-y-3">
          {Object.entries(schema.fields).map(([key, field]) => (
            <div key={key}>
              <div className="flex items-center gap-2 mb-1">
                <label className="text-xs font-medium text-[var(--text-muted)]">{field.label || key}</label>
                {field.description && (
                  <span className="text-[10px] text-[var(--text-muted)]">({field.description})</span>
                )}
              </div>
              <FieldInput
                fieldKey={key}
                field={field}
                value={editConfig[key] ?? field.default}
                onChange={(val) => setEditConfig((prev) => ({ ...prev, [key]: val }))}
              />
            </div>
          ))}
          <button
            onClick={() => onSave(editConfig)}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium bg-[var(--primary)]/20 text-[var(--primary)] hover:bg-[var(--primary)]/30 transition-all"
          >
            <Save className="w-3 h-3" />
            保存
          </button>
        </div>
      )}
    </div>
  );
}

/** 无 schema 的插件：JSON 编辑器 */
function RawPluginCard({
  pluginName,
  config,
  onSave,
}: {
  pluginName: string;
  config: Record<string, unknown>;
  onSave: (config: Record<string, unknown>) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const [editJson, setEditJson] = useState(JSON.stringify(config, null, 2));
  const [parseError, setParseError] = useState("");

  useEffect(() => {
    setEditJson(JSON.stringify(config, null, 2));
  }, [config]);

  const handleJsonSave = () => {
    try {
      const parsed = JSON.parse(editJson);
      onSave(parsed);
      setParseError("");
    } catch {
      setParseError("JSON 格式错误");
    }
  };

  return (
    <div className="border border-[var(--border)] rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-4 py-3 bg-[var(--overlay)]/20 hover:bg-[var(--overlay)]/30 transition-colors"
      >
        {expanded ? <ChevronDown className="w-3.5 h-3.5 text-[var(--text-muted)]" /> : <ChevronRight className="w-3.5 h-3.5 text-[var(--text-muted)]" />}
        <span className="text-sm font-medium text-[var(--text)]">{pluginName}</span>
        <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-[var(--overlay)]/30 text-[var(--text-muted)] ml-auto">
          自定义
        </span>
      </button>
      {expanded && (
        <div className="px-4 py-3 space-y-3">
          <textarea
            value={editJson}
            onChange={(e) => { setEditJson(e.target.value); setParseError(""); }}
            rows={6}
            className="w-full px-3 py-2 rounded-lg bg-[var(--background)] border border-[var(--border)] text-sm text-[var(--text)] focus:outline-none focus:border-[var(--primary)] resize-none font-mono"
            spellCheck={false}
          />
          {parseError && <p className="text-xs text-[var(--error)]">{parseError}</p>}
          <button
            onClick={handleJsonSave}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium bg-[var(--primary)]/20 text-[var(--primary)] hover:bg-[var(--primary)]/30 transition-all"
          >
            <Save className="w-3 h-3" />
            保存
          </button>
        </div>
      )}
    </div>
  );
}

export default function PluginPanel() {
  const { config, updatePluginConfig } = useConfigStore();

  // 合并 schema 中的插件和 plugins 配置中的插件
  const allPluginNames = Array.from(new Set([
    ...Object.keys(config.plugin_schemas),
    ...Object.keys(config.plugins),
  ]));

  const handleSave = (pluginName: string, pluginConfig: Record<string, unknown>) => {
    updatePluginConfig(pluginName, pluginConfig);
  };

  if (allPluginNames.length === 0) {
    return (
      <div className="text-center py-12 text-[var(--text-muted)]">
        <p className="text-sm">暂无已注册的插件</p>
        <p className="text-xs mt-1">连接后端后，已注册插件的配置项将显示在此处</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {allPluginNames.map((name) => {
        const schema = config.plugin_schemas[name];
        const pluginConfig = config.plugins[name] || {};
        if (schema && Object.keys(schema.fields).length > 0) {
          return (
            <SchemaPluginCard
              key={name}
              pluginName={name}
              schema={schema}
              config={pluginConfig}
              onSave={(cfg) => handleSave(name, cfg)}
            />
          );
        }
        return (
          <RawPluginCard
            key={name}
            pluginName={name}
            config={pluginConfig}
            onSave={(cfg) => handleSave(name, cfg)}
          />
        );
      })}
    </div>
  );
}
