import Live2DCanvas from "@/components/live2d/Live2DCanvas";
import { useLive2DStore } from "@/store/useLive2DStore";

/**
 * Live2D 独立页面 — 全屏渲染 Live2D 模型。
 *
 * 不使用 AppLayout（无侧边栏），模型占满整个视口。
 * 仍通过 WebSocket 接收后端的 Live2D 控制命令。
 */
export default function Live2DPage() {
  const enabled = useLive2DStore((s) => s.enabled);
  const modelUrl = useLive2DStore((s) => s.modelUrl);
  const currentEmotion = useLive2DStore((s) => s.currentEmotion);
  const currentMotion = useLive2DStore((s) => s.currentMotion);

  return (
    <div className="h-screen w-screen bg-[var(--background)] flex flex-col">
      {/* 顶部状态栏 */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--border)] bg-[var(--surface)]">
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium text-[var(--text)]">Live2D</span>
          {modelUrl && (
            <span className="text-xs text-[var(--text-muted)] truncate max-w-[300px]">
              {modelUrl.split("/").pop()}
            </span>
          )}
        </div>
        <div className="flex items-center gap-4 text-xs text-[var(--text-muted)]">
          <span>情绪: <span className="text-[var(--primary)]">{currentEmotion}</span></span>
          <span>动作: <span className="text-[var(--primary)]">{currentMotion}</span></span>
        </div>
      </div>

      {/* Live2D 渲染区域 */}
      <div className="flex-1 overflow-hidden">
        {enabled ? (
          <Live2DCanvas />
        ) : (
          <div className="flex items-center justify-center h-full text-sm text-[var(--text-muted)]">
            Live2D 未启用
          </div>
        )}
      </div>
    </div>
  );
}
