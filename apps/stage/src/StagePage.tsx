import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BrowserMonotonicClock } from "@bellis/transport/browser";
import { StageApp, type StageAppState } from "./bootstrap/stage-app.js";
import { createBrowserSocket } from "./control/browser-socket.js";

/**
 * /stage/:profile 页面外壳（P2）。
 *
 * React 只承担状态呈现与用户手势入口（Audio Arm）；连接、时钟、Scene
 * 状态机全部在 StageApp 内，脱离 React 生命周期。close() 挂接
 * pagehide，保证刷新/关闭时零残留。
 */

const STATE_LABELS: Record<StageAppState, string> = {
  booting: "启动中",
  auth_ready: "认证完成",
  control_ready: "控制通道就绪",
  clock_ready: "时钟已校准",
  performance_ready: "演出就绪",
  degraded: "降级",
  reconnecting: "重连中",
  closing: "关闭中",
  closed: "已关闭",
};

function cryptoUuid(): string {
  return crypto.randomUUID();
}

export function StagePage({ profile }: { profile: string }) {
  const [state, setState] = useState<StageAppState>("booting");
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [armed, setArmed] = useState(false);
  const appRef = useRef<StageApp | null>(null);

  const authenticate = useCallback(async () => {
    // Phase 1 本地认证：startup token → HttpOnly session cookie（由 Runtime
    // 的 /api/v1/auth 完成，Demo/P5 注入真实流程；此处读取页面携带的会话）。
    const params = new URLSearchParams(window.location.search);
    const token = params.get("token") ?? "";
    const response = await fetch("/api/v1/auth/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ startupToken: token, clientType: "stage", profile }),
    });
    if (!response.ok) {
      throw new Error(`stage_auth_failed_${response.status}`);
    }
    const result = (await response.json()) as { sessionId: string; controlUrl: string };
    return result;
  }, [profile]);

  useEffect(() => {
    const clock = new BrowserMonotonicClock();
    const app = new StageApp({
      clock,
      nextMessageId: cryptoUuid,
      capabilities: {
        schemaVersion: 1,
        audio: {
          contentTypes: ["audio/pcm-s16le-48000-mono"],
          maxBufferedUs: "2000000",
        },
        subtitle: { supported: true },
        avatar: { adapter: "pending", motions: [], expressions: [] },
      },
      socketFactory: () =>
        createBrowserSocket(
          `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/v1/control`,
        ),
      authenticate,
      onStateChange: (next) => setState(next),
      onMediaAnnounce: () => {
        // P3：AudioWorklet Lane 建立有界缓冲后回 media.stream.ready。
      },
    });
    appRef.current = app;
    void app.start().catch((cause: unknown) => {
      setError({ code: "stage_start_failed", message: String(cause) });
    });
    const onUnload = () => {
      void app.close("page_unload");
    };
    window.addEventListener("pagehide", onUnload);
    return () => {
      window.removeEventListener("pagehide", onUnload);
      void app.close("react_unmount");
    };
  }, [authenticate]);

  const armAudio = useCallback(async () => {
    const app = appRef.current;
    if (app === null) {
      return;
    }
    try {
      const context = new AudioContext();
      await context.resume();
      await context.close();
      app.armAudio();
      setArmed(true);
    } catch {
      setError({ code: "audio_arm_failed", message: "AudioContext.resume 被拒绝" });
    }
  }, []);

  const stateLabel = useMemo(() => STATE_LABELS[state], [state]);

  return (
    <main className="stage-root">
      <h1>Bellis Stage — {profile}</h1>
      <section aria-live="polite">
        <p>
          状态：<strong>{stateLabel}</strong>
        </p>
        <p>
          音频：{armed ? "已启用" : "等待启用音频"}
          {!armed && (
            <button type="button" onClick={() => void armAudio()}>
              启用音频
            </button>
          )}
        </p>
        {error !== null && (
          <p role="alert" className="stage-error">
            错误 {error.code}：{error.message}
          </p>
        )}
      </section>
    </main>
  );
}
