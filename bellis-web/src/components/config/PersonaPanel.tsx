import { useState, useEffect } from "react";
import { useConfigStore } from "@/store/useConfigStore";
import { Save } from "lucide-react";

export default function PersonaPanel() {
  const { config, registerPersona } = useConfigStore();
  const active = config.personas[config.active_persona];

  const [name, setName] = useState(active?.name || "");
  const [systemPrompt, setSystemPrompt] = useState(active?.system_prompt || "");
  const [ttsVoice, setTtsVoice] = useState(active?.tts_voice || "");

  useEffect(() => {
    setName(active?.name || "");
    setSystemPrompt(active?.system_prompt || "");
    setTtsVoice(active?.tts_voice || "");
  }, [active]);

  const handleSave = () => {
    registerPersona({ name, system_prompt: systemPrompt, tts_voice: ttsVoice });
  };

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-xs font-medium text-[var(--text-muted)] mb-1.5">Persona 名称</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="default"
          className="w-full px-3 py-2 rounded-lg bg-[var(--background)] border border-[var(--border)] text-sm text-[var(--text)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--primary)] transition-colors"
        />
      </div>
      <div>
        <label className="block text-xs font-medium text-[var(--text-muted)] mb-1.5">System Prompt</label>
        <textarea
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          placeholder="输入 system prompt..."
          rows={4}
          className="w-full px-3 py-2 rounded-lg bg-[var(--background)] border border-[var(--border)] text-sm text-[var(--text)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--primary)] transition-colors resize-none"
        />
      </div>
      <div>
        <label className="block text-xs font-medium text-[var(--text-muted)] mb-1.5">TTS Voice</label>
        <input
          type="text"
          value={ttsVoice}
          onChange={(e) => setTtsVoice(e.target.value)}
          placeholder="default"
          className="w-full px-3 py-2 rounded-lg bg-[var(--background)] border border-[var(--border)] text-sm text-[var(--text)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--primary)] transition-colors"
        />
      </div>
      <button
        onClick={handleSave}
        className="flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-medium bg-[var(--primary)]/20 text-[var(--primary)] hover:bg-[var(--primary)]/30 transition-all"
      >
        <Save className="w-3.5 h-3.5" />
        保存 Persona
      </button>
    </div>
  );
}
