import { useEffect, useRef, useState } from "react";
import { useLive2DStore } from "@/store/useLive2DStore";
import type { Live2DCommand } from "@/types/live2d";

/**
 * Live2D Canvas 渲染组件。
 *
 * 使用 PIXI.js v6 + pixi-live2d-display 加载和渲染 Live2D 模型，
 * 订阅 useLive2DStore 的命令队列逐帧应用控制命令。
 */
export default function Live2DCanvas() {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const appRef = useRef<any>(null);
  const modelRef = useRef<any>(null);
  const enabled = useLive2DStore((s) => s.enabled);
  const modelUrl = useLive2DStore((s) => s.modelUrl);
  const [containerSize, setContainerSize] = useState({ width: 800, height: 600 });

  // 监听容器尺寸变化
  useEffect(() => {
    if (!containerRef.current) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          setContainerSize({ width: Math.floor(width), height: Math.floor(height) });
        }
      }
    });

    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  // 初始化 PIXI Application + 加载模型
  useEffect(() => {
    if (!canvasRef.current || !enabled || containerSize.width === 0) return;

    let destroyed = false;

    async function initPixi() {
      const PIXI = await import("pixi.js");
      const { Live2DModel } = await import("pixi-live2d-display/cubism4");

      // pixi-live2d-display 需要全局 PIXI 引用
      (window as any).PIXI = PIXI;

      const { width, height } = containerSize;

      const app = new PIXI.Application({
        view: canvasRef.current!,
        width,
        height,
        backgroundAlpha: 0,
        resolution: window.devicePixelRatio || 1,
        autoDensity: true,
      });
      appRef.current = app;

      // 加载模型
      if (modelUrl) {
        try {
          console.log("[Live2D] Loading model:", modelUrl);
          const model = await Live2DModel.from(modelUrl, { autoInteract: false });
          if (destroyed) return;

          // 居中放置
          model.anchor.set(0.5, 0.5);
          model.x = app.screen.width / 2;
          model.y = app.screen.height / 2;

          // 缩放适配
          const scale = Math.min(
            app.screen.width / model.width,
            app.screen.height / model.height,
          ) * 0.85;
          model.scale.set(scale);

          app.stage.addChild(model as any);
          modelRef.current = model;
          console.log("[Live2D] Model loaded successfully, size:", model.width, "x", model.height);

          // 播放 Idle 动作确认模型正常
          try {
            model.motion("Idle");
          } catch {
            // 模型可能没有 Idle 组
          }
        } catch (err) {
          console.warn("[Live2D] Failed to load model:", err);
        }
      }
    }

    initPixi();

    return () => {
      destroyed = true;
      if (appRef.current) {
        appRef.current.destroy(true, { children: true });
        appRef.current = null;
        modelRef.current = null;
      }
    };
  }, [enabled, modelUrl, containerSize]);

  // 命令处理循环
  useEffect(() => {
    if (!enabled) return;

    const interval = setInterval(() => {
      const store = useLive2DStore.getState();
      const cmd = store.dequeueCommand();
      if (!cmd || !modelRef.current) return;

      applyCommand(cmd, modelRef.current);
    }, 50);

    return () => clearInterval(interval);
  }, [enabled]);

  // 鼠标追踪
  useEffect(() => {
    if (!enabled || !canvasRef.current) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!modelRef.current) return;
      const rect = canvasRef.current!.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      const y = (e.clientY - rect.top) / rect.height;

      try {
        const internalModel = modelRef.current.internalModel;
        if (internalModel) {
          const coreModel = internalModel.coreModel;
          coreModel.setParameterValueById("ParamEyeBallX", (x - 0.5) * 2);
          coreModel.setParameterValueById("ParamEyeBallY", -(y - 0.5) * 2);
        }
      } catch {
        // 参数可能不存在于某些模型
      }
    };

    canvasRef.current.addEventListener("mousemove", handleMouseMove);
    const canvas = canvasRef.current;
    return () => canvas.removeEventListener("mousemove", handleMouseMove);
  }, [enabled]);

  if (!enabled) return null;

  return (
    <div ref={containerRef} className="w-full h-full relative">
      <canvas ref={canvasRef} className="w-full h-full" />
      {!modelUrl && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-[var(--text-muted)]">
          请在配置页面设置 Live2D 模型 URL
        </div>
      )}
    </div>
  );
}

/** 应用 Live2D 控制命令到模型 */
function applyCommand(cmd: Live2DCommand, model: any) {
  try {
    switch (cmd.type) {
      case "set_emotion":
        if (cmd.emotion) {
          const group = emotionToMotionGroup(cmd.emotion);
          model.motion(group);
        }
        break;

      case "play_motion":
        if (cmd.group) {
          model.motion(cmd.group, cmd.index ?? 0);
        }
        break;

      case "set_parameter":
        if (cmd.param_id != null && cmd.value != null) {
          const coreModel = model.internalModel?.coreModel;
          if (coreModel) {
            coreModel.setParameterValueById(cmd.param_id, cmd.value);
          }
        }
        break;

      case "set_parameters":
        if (cmd.parameters) {
          const coreModel = model.internalModel?.coreModel;
          if (coreModel) {
            for (const [id, value] of Object.entries(cmd.parameters)) {
              coreModel.setParameterValueById(id, value);
            }
          }
        }
        break;

      case "set_expression":
        if (cmd.expression_name) {
          model.expression(cmd.expression_name);
        }
        break;

      case "set_lip_sync":
        if (cmd.mouth_open != null) {
          const coreModel = model.internalModel?.coreModel;
          if (coreModel) {
            coreModel.setParameterValueById("ParamMouthOpenY", cmd.mouth_open);
          }
        }
        break;
    }
  } catch (err) {
    console.debug("[Live2D] Command apply error:", cmd.type, err);
  }
}

/** 情绪名称 → Live2D Motion Group 映射（与后端 mappings.py 对齐） */
function emotionToMotionGroup(emotion: string): string {
  const map: Record<string, string> = {
    happy: "Happy",
    excited: "Happy",
    calm: "Idle",
    shy: "Awkward",
    angry: "Angry",
    sad: "Sad",
    surprised: "Surprise",
    neutral: "Idle",
    think: "Think",
    awkward: "Awkward",
    question: "Question",
    curious: "Curious",
  };
  return map[emotion] ?? "Idle";
}
