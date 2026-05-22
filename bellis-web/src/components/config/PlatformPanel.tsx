import { useState, useEffect } from "react";
import { useConfigStore } from "@/store/useConfigStore";
import { Save } from "lucide-react";

export default function PlatformPanel() {
  const { config, updatePlatformConfig } = useConfigStore();
  const [danmakuUri, setDanmakuUri] = useState(config.platform.danmaku_ws_uri);
  const [commandUri, setCommandUri] = useState(config.platform.command_ws_uri);
  const [callbackSecret, setCallbackSecret] = useState(config.platform.callback_secret);
  const [queueSize, setQueueSize] = useState(String(config.platform.max_queue_size));
  const [qps, setQps] = useState(String(config.platform.danmaku_qps_limit));
  const [ttsLimit, setTtsLimit] = useState(String(config.platform.tts_queue_limit));
  const [idleThreshold, setIdleThreshold] = useState(String(config.platform.idle_threshold));
  const [idleInterval, setIdleInterval] = useState(String(config.platform.idle_monitor_interval));

  useEffect(() => {
    setDanmakuUri(config.platform.danmaku_ws_uri);
    setCommandUri(config.platform.command_ws_uri);
    setCallbackSecret(config.platform.callback_secret);
    setQueueSize(String(config.platform.max_queue_size));
    setQps(String(config.platform.danmaku_qps_limit));
    setTtsLimit(String(config.platform.tts_queue_limit));
    setIdleThreshold(String(config.platform.idle_threshold));
    setIdleInterval(String(config.platform.idle_monitor_interval));
  }, [config.platform]);

  const handleSave = () => {
    updatePlatformConfig({
      danmaku_ws_uri: danmakuUri,
      command_ws_uri: commandUri,
      callback_secret: callbackSecret,
      max_queue_size: parseInt(queueSize || "1000"),
      danmaku_qps_limit: parseInt(qps || "50"),
      tts_queue_limit: parseInt(ttsLimit || "20"),
      idle_threshold: parseInt(idleThreshold || "5"),
      idle_monitor_interval: parseFloat(idleInterval || "2.0"),
    });
  };

  return (
    <div className="space-y-4">
      {/* WebSocket 连接 */}
      <div className="space-y-3">
        <h3 className="text-xs font-semibold text-[var(--text)] uppercase tracking-wider">WebSocket 连接</h3>
        <div>
          <label className="block text-xs font-medium text-[var(--text-muted)] mb-1.5">弹幕 WebSocket URI</label>
          <input
            type="text"
            value={danmakuUri}
            onChange={(e) => setDanmakuUri(e.target.value)}
            placeholder="ws://localhost:8080/danmaku"
            className="w-full px-3 py-2 rounded-lg bg-[var(--background)] border border-[var(--border)] text-sm text-[var(--text)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--primary)] font-mono"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-[var(--text-muted)] mb-1.5">指令 WebSocket URI</label>
          <input
            type="text"
            value={commandUri}
            onChange={(e) => setCommandUri(e.target.value)}
            placeholder="ws://localhost:8080/command"
            className="w-full px-3 py-2 rounded-lg bg-[var(--background)] border border-[var(--border)] text-sm text-[var(--text)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--primary)] font-mono"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-[var(--text-muted)] mb-1.5">回调签名密钥</label>
          <input
            type="password"
            value={callbackSecret}
            onChange={(e) => setCallbackSecret(e.target.value)}
            placeholder="留空不验证"
            className="w-full px-3 py-2 rounded-lg bg-[var(--background)] border border-[var(--border)] text-sm text-[var(--text)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--primary)] font-mono"
          />
          <p className="mt-1 text-[10px] text-[var(--text-muted)]">用于验证回调请求来源的签名密钥</p>
        </div>
      </div>

      {/* 队列与限流 */}
      <div className="space-y-3 pt-3 border-t border-[var(--border)]">
        <h3 className="text-xs font-semibold text-[var(--text)] uppercase tracking-wider">队列与限流</h3>
        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="block text-xs font-medium text-[var(--text-muted)] mb-1.5">最大队列大小</label>
            <input
              type="number"
              value={queueSize}
              onChange={(e) => setQueueSize(e.target.value)}
              placeholder="1000"
              className="w-full px-3 py-2 rounded-lg bg-[var(--background)] border border-[var(--border)] text-sm text-[var(--text)] focus:outline-none focus:border-[var(--primary)] font-mono"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-[var(--text-muted)] mb-1.5">弹幕 QPS 限制</label>
            <input
              type="number"
              value={qps}
              onChange={(e) => setQps(e.target.value)}
              placeholder="50"
              className="w-full px-3 py-2 rounded-lg bg-[var(--background)] border border-[var(--border)] text-sm text-[var(--text)] focus:outline-none focus:border-[var(--primary)] font-mono"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-[var(--text-muted)] mb-1.5">TTS 队列限制</label>
            <input
              type="number"
              value={ttsLimit}
              onChange={(e) => setTtsLimit(e.target.value)}
              placeholder="20"
              className="w-full px-3 py-2 rounded-lg bg-[var(--background)] border border-[var(--border)] text-sm text-[var(--text)] focus:outline-none focus:border-[var(--primary)] font-mono"
            />
          </div>
        </div>
      </div>

      {/* 空闲监控 */}
      <div className="space-y-3 pt-3 border-t border-[var(--border)]">
        <h3 className="text-xs font-semibold text-[var(--text)] uppercase tracking-wider">空闲监控</h3>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-[var(--text-muted)] mb-1.5">空闲判定阈值 (秒)</label>
            <input
              type="number"
              value={idleThreshold}
              onChange={(e) => setIdleThreshold(e.target.value)}
              placeholder="5"
              className="w-full px-3 py-2 rounded-lg bg-[var(--background)] border border-[var(--border)] text-sm text-[var(--text)] focus:outline-none focus:border-[var(--primary)] font-mono"
            />
            <p className="mt-1 text-[10px] text-[var(--text-muted)]">超过此时间无弹幕视为空闲</p>
          </div>
          <div>
            <label className="block text-xs font-medium text-[var(--text-muted)] mb-1.5">监控检查间隔 (秒)</label>
            <input
              type="number"
              step="0.5"
              value={idleInterval}
              onChange={(e) => setIdleInterval(e.target.value)}
              placeholder="2.0"
              className="w-full px-3 py-2 rounded-lg bg-[var(--background)] border border-[var(--border)] text-sm text-[var(--text)] focus:outline-none focus:border-[var(--primary)] font-mono"
            />
          </div>
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
