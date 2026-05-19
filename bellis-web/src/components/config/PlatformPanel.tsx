import { useState } from "react";
import { useConfigStore } from "@/store/useConfigStore";
import { Save } from "lucide-react";

export default function PlatformPanel() {
  const { config, updatePlatformConfig } = useConfigStore();
  const [danmakuUri, setDanmakuUri] = useState(config.platform.danmaku_ws_uri);
  const [commandUri, setCommandUri] = useState(config.platform.command_ws_uri);
  const [queueSize, setQueueSize] = useState(String(config.platform.max_queue_size));
  const [qps, setQps] = useState(String(config.platform.danmaku_qps_limit));
  const [ttsLimit, setTtsLimit] = useState(String(config.platform.tts_queue_limit));

  const handleSave = () => {
    updatePlatformConfig({
      danmaku_ws_uri: danmakuUri,
      command_ws_uri: commandUri,
      max_queue_size: parseInt(queueSize || "1000"),
      danmaku_qps_limit: parseInt(qps || "50"),
      tts_queue_limit: parseInt(ttsLimit || "20"),
    });
  };

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-xs font-medium text-[var(--text-muted)] mb-1.5">弹幕 WebSocket URI</label>
        <input
          type="text"
          value={danmakuUri}
          onChange={(e) => setDanmakuUri(e.target.value)}
          placeholder="ws://localhost:8080/danmaku"
          className="w-full px-3 py-2 rounded-lg bg-[var(--background)] border border-[var(--border)] text-sm text-[var(--text)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--primary)] transition-colors font-mono"
        />
      </div>
      <div>
        <label className="block text-xs font-medium text-[var(--text-muted)] mb-1.5">指令 WebSocket URI</label>
        <input
          type="text"
          value={commandUri}
          onChange={(e) => setCommandUri(e.target.value)}
          placeholder="ws://localhost:8080/command"
          className="w-full px-3 py-2 rounded-lg bg-[var(--background)] border border-[var(--border)] text-sm text-[var(--text)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--primary)] transition-colors font-mono"
        />
      </div>
      <div className="grid grid-cols-3 gap-4">
        <div>
          <label className="block text-xs font-medium text-[var(--text-muted)] mb-1.5">最大队列大小</label>
          <input
            type="number"
            value={queueSize}
            onChange={(e) => setQueueSize(e.target.value)}
            placeholder="1000"
            className="w-full px-3 py-2 rounded-lg bg-[var(--background)] border border-[var(--border)] text-sm text-[var(--text)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--primary)] transition-colors font-mono"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-[var(--text-muted)] mb-1.5">弹幕 QPS 限制</label>
          <input
            type="number"
            value={qps}
            onChange={(e) => setQps(e.target.value)}
            placeholder="50"
            className="w-full px-3 py-2 rounded-lg bg-[var(--background)] border border-[var(--border)] text-sm text-[var(--text)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--primary)] transition-colors font-mono"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-[var(--text-muted)] mb-1.5">TTS 队列限制</label>
          <input
            type="number"
            value={ttsLimit}
            onChange={(e) => setTtsLimit(e.target.value)}
            placeholder="20"
            className="w-full px-3 py-2 rounded-lg bg-[var(--background)] border border-[var(--border)] text-sm text-[var(--text)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--primary)] transition-colors font-mono"
          />
        </div>
      </div>
      <button
        onClick={handleSave}
        className="flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-medium bg-[var(--primary)]/20 text-[var(--primary)] hover:bg-[var(--primary)]/30 transition-all"
      >
        <Save className="w-3.5 h-3.5" />
        保存平台配置
      </button>
    </div>
  );
}
