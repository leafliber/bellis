import { useState, useEffect } from "react";
import { useConfigStore } from "@/store/useConfigStore";
import { Save, Plus, Trash2, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { EmotionType, MotionType, GUIPersonaConfig } from "@/types";

const EMOTION_OPTIONS: EmotionType[] = ["happy", "excited", "calm", "shy", "angry", "sad", "surprised", "neutral"];
const MOTION_OPTIONS: MotionType[] = ["idle", "wave", "nod", "shake_head", "bow", "clap", "point", "think", "cheer"];

const EMOTION_LABELS: Record<EmotionType, string> = {
  happy: "开心", excited: "兴奋", calm: "平静", shy: "害羞",
  angry: "生气", sad: "悲伤", surprised: "惊讶", neutral: "中性",
};

const MOTION_LABELS: Record<MotionType, string> = {
  idle: "待机", wave: "挥手", nod: "点头", shake_head: "摇头",
  bow: "鞠躬", clap: "鼓掌", point: "指向", think: "思考", cheer: "欢呼",
};

function MapEditor({
  label,
  map,
  options,
  optionLabels,
  onChange,
}: {
  label: string;
  map: Record<string, string>;
  options: string[];
  optionLabels: Record<string, string>;
  onChange: (map: Record<string, string>) => void;
}) {
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState(options[0]);

  const handleAdd = () => {
    if (!newKey.trim() || newKey in map) return;
    onChange({ ...map, [newKey.trim()]: newValue });
    setNewKey("");
  };

  const handleRemove = (key: string) => {
    const next = { ...map };
    delete next[key];
    onChange(next);
  };

  const handleValueChange = (key: string, value: string) => {
    onChange({ ...map, [key]: value });
  };

  return (
    <div className="space-y-2">
      <label className="block text-xs font-medium text-[var(--text-muted)]">{label}</label>
      {Object.entries(map).map(([key, value]) => (
        <div key={key} className="flex items-center gap-2">
          <span className="flex-1 px-2 py-1.5 rounded bg-[var(--background)] border border-[var(--border)] text-xs text-[var(--text)] truncate">
            {key}
          </span>
          <ChevronRight className="w-3 h-3 text-[var(--text-muted)] shrink-0" />
          <select
            value={value}
            onChange={(e) => handleValueChange(key, e.target.value)}
            className="flex-1 px-2 py-1.5 rounded bg-[var(--background)] border border-[var(--border)] text-xs text-[var(--text)] focus:outline-none focus:border-[var(--primary)]"
          >
            {options.map((opt) => (
              <option key={opt} value={opt}>{optionLabels[opt] || opt}</option>
            ))}
          </select>
          <button onClick={() => handleRemove(key)} className="p-1 text-[var(--error)] hover:bg-[var(--error)]/10 rounded transition-colors">
            <Trash2 className="w-3 h-3" />
          </button>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
          placeholder="关键词"
          className="flex-1 px-2 py-1.5 rounded bg-[var(--background)] border border-[var(--border)] text-xs text-[var(--text)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--primary)]"
          onKeyDown={(e) => e.key === "Enter" && handleAdd()}
        />
        <ChevronRight className="w-3 h-3 text-[var(--text-muted)] shrink-0" />
        <select
          value={newValue}
          onChange={(e) => setNewValue(e.target.value)}
          className="flex-1 px-2 py-1.5 rounded bg-[var(--background)] border border-[var(--border)] text-xs text-[var(--text)] focus:outline-none focus:border-[var(--primary)]"
        >
          {options.map((opt) => (
            <option key={opt} value={opt}>{optionLabels[opt] || opt}</option>
          ))}
        </select>
        <button
          onClick={handleAdd}
          disabled={!newKey.trim()}
          className="p-1 text-[var(--primary)] hover:bg-[var(--primary)]/10 rounded transition-colors disabled:opacity-40"
        >
          <Plus className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
}

export default function PersonaPanel() {
  const { config, registerPersona, switchPersona } = useConfigStore();
  const personaNames = Object.keys(config.personas);
  const [selectedName, setSelectedName] = useState<string | null>(config.active_persona || personaNames[0] || null);
  const [newPersonaName, setNewPersonaName] = useState("");

  const active = selectedName ? config.personas[selectedName] : null;

  const [systemPrompt, setSystemPrompt] = useState("");
  const [ttsVoice, setTtsVoice] = useState("");
  const [ttsSpeedMin, setTtsSpeedMin] = useState("0.8");
  const [ttsSpeedMax, setTtsSpeedMax] = useState("1.5");
  const [emotionMap, setEmotionMap] = useState<Record<string, string>>({});
  const [motionMap, setMotionMap] = useState<Record<string, string>>({});

  useEffect(() => {
    if (active) {
      setSystemPrompt(active.system_prompt);
      setTtsVoice(active.tts_voice);
      setTtsSpeedMin(String(active.tts_speed_range[0]));
      setTtsSpeedMax(String(active.tts_speed_range[1]));
      setEmotionMap(active.emotion_map || {});
      setMotionMap(active.motion_map || {});
    }
  }, [active]);

  const handleSave = () => {
    if (!selectedName) return;
    const persona: GUIPersonaConfig = {
      name: selectedName,
      system_prompt: systemPrompt,
      emotion_map: emotionMap as Record<string, EmotionType>,
      motion_map: motionMap as Record<string, MotionType>,
      tts_voice: ttsVoice,
      tts_speed_range: [parseFloat(ttsSpeedMin || "0.8"), parseFloat(ttsSpeedMax || "1.5")],
    };
    registerPersona(persona);
  };

  const handleAddPersona = () => {
    const name = newPersonaName.trim();
    if (!name || name in config.personas) return;
    const persona: GUIPersonaConfig = {
      name,
      system_prompt: "",
      emotion_map: {},
      motion_map: {},
      tts_voice: "default",
      tts_speed_range: [0.8, 1.5],
    };
    registerPersona(persona);
    setSelectedName(name);
    setNewPersonaName("");
  };

  const handleSelectPersona = (name: string) => {
    setSelectedName(name);
  };

  const handleActivate = () => {
    if (selectedName && selectedName !== config.active_persona) {
      switchPersona(selectedName);
    }
  };

  return (
    <div className="space-y-5">
      {/* Persona 列表 */}
      <div>
        <label className="block text-xs font-medium text-[var(--text-muted)] mb-1.5">人设列表</label>
        <div className="flex gap-2">
          <select
            value={selectedName || ""}
            onChange={(e) => handleSelectPersona(e.target.value)}
            className="flex-1 px-3 py-2 rounded-lg bg-[var(--background)] border border-[var(--border)] text-sm text-[var(--text)] focus:outline-none focus:border-[var(--primary)]"
          >
            {personaNames.length === 0 && <option value="" disabled>无人设</option>}
            {personaNames.map((name) => (
              <option key={name} value={name}>
                {name}{name === config.active_persona ? " (活跃)" : ""}
              </option>
            ))}
          </select>
          {selectedName && selectedName !== config.active_persona && (
            <button
              onClick={handleActivate}
              className="px-3 py-2 rounded-lg text-xs font-medium bg-[var(--success)]/20 text-[var(--success)] hover:bg-[var(--success)]/30 transition-all"
            >
              激活
            </button>
          )}
        </div>
      </div>

      {/* 新增人设 */}
      <div className="flex gap-2">
        <input
          type="text"
          value={newPersonaName}
          onChange={(e) => setNewPersonaName(e.target.value)}
          placeholder="新人设名称"
          className="flex-1 px-3 py-2 rounded-lg bg-[var(--background)] border border-[var(--border)] text-sm text-[var(--text)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--primary)]"
          onKeyDown={(e) => e.key === "Enter" && handleAddPersona()}
        />
        <button
          onClick={handleAddPersona}
          disabled={!newPersonaName.trim()}
          className="flex items-center gap-1 px-3 py-2 rounded-lg text-xs font-medium bg-[var(--primary)]/20 text-[var(--primary)] hover:bg-[var(--primary)]/30 transition-all disabled:opacity-40"
        >
          <Plus className="w-3.5 h-3.5" />
          新增
        </button>
      </div>

      {/* 编辑区域 */}
      {active && (
        <div className="space-y-4 pt-2 border-t border-[var(--border)]">
          <div>
            <label className="block text-xs font-medium text-[var(--text-muted)] mb-1.5">System Prompt</label>
            <textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder="输入 system prompt..."
              rows={4}
              className="w-full px-3 py-2 rounded-lg bg-[var(--background)] border border-[var(--border)] text-sm text-[var(--text)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--primary)] resize-none"
            />
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-[var(--text-muted)] mb-1.5">TTS 音色</label>
              <input
                type="text"
                value={ttsVoice}
                onChange={(e) => setTtsVoice(e.target.value)}
                placeholder="default"
                className="w-full px-3 py-2 rounded-lg bg-[var(--background)] border border-[var(--border)] text-sm text-[var(--text)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--primary)]"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--text-muted)] mb-1.5">语速下限</label>
              <input
                type="number"
                step="0.1"
                value={ttsSpeedMin}
                onChange={(e) => setTtsSpeedMin(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-[var(--background)] border border-[var(--border)] text-sm text-[var(--text)] focus:outline-none focus:border-[var(--primary)] font-mono"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--text-muted)] mb-1.5">语速上限</label>
              <input
                type="number"
                step="0.1"
                value={ttsSpeedMax}
                onChange={(e) => setTtsSpeedMax(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-[var(--background)] border border-[var(--border)] text-sm text-[var(--text)] focus:outline-none focus:border-[var(--primary)] font-mono"
              />
            </div>
          </div>

          {/* 情感映射 */}
          <MapEditor
            label="情感映射 (关键词 → 情感)"
            map={emotionMap}
            options={EMOTION_OPTIONS}
            optionLabels={EMOTION_LABELS}
            onChange={setEmotionMap}
          />

          {/* 动作映射 */}
          <MapEditor
            label="动作映射 (关键词 → 动作)"
            map={motionMap}
            options={MOTION_OPTIONS}
            optionLabels={MOTION_LABELS}
            onChange={setMotionMap}
          />

          <button
            onClick={handleSave}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-medium bg-[var(--primary)]/20 text-[var(--primary)] hover:bg-[var(--primary)]/30 transition-all"
          >
            <Save className="w-3.5 h-3.5" />
            保存人设
          </button>
        </div>
      )}
    </div>
  );
}
