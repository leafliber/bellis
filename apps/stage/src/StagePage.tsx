import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BrowserMonotonicClock } from "@bellis/transport/browser";
import { StageApp, type StageAppState } from "./bootstrap/stage-app.js";
import { createBrowserSocket } from "./control/browser-socket.js";
import { StageMediaClient } from "./media/stage-media-client.js";
import { AudioLaneAdapter } from "./lanes/audio/audio-lane.js";
import { BrowserAudioEnvironment } from "./lanes/audio/browser-audio-environment.js";
import { DomSubtitleDocument } from "./lanes/subtitle/dom-subtitle-document.js";
import { SubtitleLaneAdapter } from "./lanes/subtitle/subtitle-lane.js";
import { DomAvatarLane } from "./lanes/avatar/dom-avatar-lane.js";
import { LaneRegistry } from "./lanes/lane-registry.js";

/**
 * /stage/:profile 页面外壳（P2/P3 装配）。
 *
 * React 只承担状态呈现与用户手势入口（Audio Arm）；连接、时钟、Scene
 * 状态机全部在 StageApp 内，脱离 React 生命周期。close() 挂接
 * pagehide，保证刷新/关闭时零残留。
 *
 * 真实装配：
 * - 认证：/api/v1/auth/exchange（startup token → HttpOnly Cookie）；
 * - 三条 Lane：AudioWorklet 音频（PCM 有界缓冲 + Commit 原子切换）、
 *   DOM 字幕（文本节点）、Recording+DOM Avatar（语义命令）；
 * - 媒体：Media WS 接收 BELL v1 帧（announce 校验能力 → ready → 帧）。
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

const AUDIO_CONTENT_TYPES = ["audio/pcm-s16le-48000-mono"] as const;

function cryptoUuid(): string {
  return crypto.randomUUID();
}

/** E2E 诊断句柄（仅测试装配读取；生产页面不依赖）。 */
interface StageDiagnostics {
  appState(): string;
  audioArmed(): boolean;
  underruns(): number;
  bufferedFrames(): Record<string, number>;
  subtitleTexts(): readonly string[];
  avatarCommands(): number;
  mediaStats(): {
    acceptedFrames: number;
    rejectedFrames: number;
    openedStreams: number;
    connectAttempts: number;
    rawMessages: number;
  } | null;
  audioError(): string | null;
  laneStarts(): {
    sceneId: string;
    lane: string;
    targetLocalUs: string;
    startedAtStageUs: string;
    late: boolean;
  }[];
  sceneEvents(): { sceneId: string; state: string; at: number; targetLocalUs?: string }[];
}

declare global {
  interface Window {
    __bellisStage?: StageDiagnostics | undefined;
  }
}

export function StagePage({ profile }: { profile: string }) {
  const [state, setState] = useState<StageAppState>("booting");
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [armed, setArmed] = useState(false);
  const [sceneEvents, setSceneEvents] = useState<{ sceneId: string; state: string; at: number }[]>(
    [],
  );
  const appRef = useRef<StageApp | null>(null);
  const subtitleRootRef = useRef<HTMLDivElement | null>(null);
  const avatarBadgeRef = useRef<HTMLParagraphElement | null>(null);
  const audioLaneRef = useRef<AudioLaneAdapter | null>(null);
  const mediaRef = useRef<StageMediaClient | null>(null);
  const registryRef = useRef<LaneRegistry | null>(null);
  const laneStartsRef = useRef<
    {
      sceneId: string;
      lane: string;
      targetLocalUs: string;
      startedAtStageUs: string;
      late: boolean;
    }[]
  >([]);
  const sceneEventsRef = useRef<
    { sceneId: string; state: string; at: number; targetLocalUs?: string }[]
  >([]);

  const authenticate = useCallback(async () => {
    // Phase 1 本地认证：startup token → HttpOnly session cookie。
    // token 由 Demo/E2E 注入页面查询参数；Cookie 对当前源生效。
    const params = new URLSearchParams(window.location.search);
    const token = params.get("token") ?? "";
    const response = await fetch("/api/v1/auth/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ startupToken: token }),
    });
    if (!response.ok) {
      throw new Error(`stage_auth_failed_${response.status}`);
    }
    const result = (await response.json()) as { sessionId: string };
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    return {
      sessionId: result.sessionId,
      controlUrl: `${protocol}://${location.host}/ws/v1/control`,
    };
  }, []);

  useEffect(() => {
    const clock = new BrowserMonotonicClock();
    const audioEnvironment = new BrowserAudioEnvironment();
    const audioLane = new AudioLaneAdapter({
      environment: audioEnvironment,
      minPreparedFrames: 6,
    });
    const subtitleDocument = new DomSubtitleDocument(subtitleRootRef.current ?? document.body);
    const subtitleLane = new SubtitleLaneAdapter(subtitleDocument);
    const avatarLane = new DomAvatarLane(
      { adapter: "recording", motions: ["nod_agree"], expressions: ["happy"] },
      avatarBadgeRef.current ?? document.body,
    );
    const registry = new LaneRegistry();
    registry.register(audioLane);
    registry.register(subtitleLane);
    registry.register(avatarLane);
    audioLaneRef.current = audioLane;
    registryRef.current = registry;

    const app = new StageApp({
      clock,
      nextMessageId: cryptoUuid,
      capabilities: {
        schemaVersion: 1,
        audio: { contentTypes: [...AUDIO_CONTENT_TYPES], maxBufferedUs: "2000000" },
        subtitle: { supported: true },
        avatar: { adapter: "recording", motions: ["nod_agree"], expressions: ["happy"] },
      },
      socketFactory: () =>
        createBrowserSocket(
          `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/v1/control`,
        ),
      authenticate,
      laneRegistry: registry,
      speechPublisher: subtitleLane,
      onStateChange: (next) => setState(next),
      onSceneEvent: (event) => {
        sceneEventsRef.current = [
          ...sceneEventsRef.current.slice(-15),
          {
            sceneId: event.sceneId,
            state: event.state,
            at: Date.now(),
            ...(event.targetLocalUs === undefined
              ? {}
              : { targetLocalUs: event.targetLocalUs.toString() }),
          },
        ];
        setSceneEvents(sceneEventsRef.current);
      },
      onLaneStarted: (report) => {
        laneStartsRef.current = [
          ...laneStartsRef.current.slice(-15),
          {
            sceneId: report.sceneId,
            lane: report.lane,
            targetLocalUs: report.targetLocalUs.toString(),
            startedAtStageUs: report.startedAtStageUs.toString(),
            late: report.late,
          },
        ];
      },
      onMediaAnnounce: (payload, sendReady) => {
        const media = mediaRef.current;
        if (media === null) {
          return;
        }
        void media.handleAnnounce(payload, sendReady);
      },
      onMediaStreamClosed: (streamId) => {
        mediaRef.current?.closeStream(streamId);
      },
    });
    appRef.current = app;
    // E2E 诊断句柄：命名以下划线开头表示测试专用全局（oxlint no-dangling-underscores 例外）。
    /* oxlint-disable no-underscore-dangle -- 测试专用全局句柄 */
    window.__bellisStage = {
      appState: () => app.state,
      audioArmed: () => audioLane.armed,
      underruns: () => audioLane.underruns,
      bufferedFrames: () => Object.fromEntries(audioLane.bufferedFrames),
      subtitleTexts: () => subtitleDocument.visibleTexts(),
      avatarCommands: () => avatarLane.commands.length,
      mediaStats: () => mediaRef.current?.stats ?? null,
      audioError: () => audioEnvironment.lastError,
      laneStarts: () => [...laneStartsRef.current],
      sceneEvents: () => [...sceneEventsRef.current],
    };
    /* oxlint-enable no-underscore-dangle */
    void app
      .start()
      .then(() => {
        // 媒体连接随引导建立（非 announce 时）：announce → ready 链路
        // 不再承担 WS 升级延迟（prepare 预算 500ms 内完成预缓冲）。
        const sessionId = app.sessionId;
        if (sessionId === null || mediaRef.current !== null) {
          return;
        }
        const media = new StageMediaClient({
          sessionId,
          socketFactory: () =>
            createBrowserSocket(
              `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/v1/media`,
            ),
          clock,
          audioContentTypes: AUDIO_CONTENT_TYPES,
          runtimeOffsetUs: () => app.runtimeOffsetUs(),
          onFrame: (frame) => {
            if (frame.sceneId !== null) {
              audioLane.appendFrame(frame.sceneId, frame.samples);
            }
          },
          onDisconnected: () => {
            audioLane.clearAll();
          },
        });
        mediaRef.current = media;
        media.connect();
      })
      .catch((cause: unknown) => {
        setError({ code: "stage_start_failed", message: String(cause) });
      });
    const onUnload = () => {
      mediaRef.current?.close();
      void app.close("page_unload");
    };
    window.addEventListener("pagehide", onUnload);
    return () => {
      window.removeEventListener("pagehide", onUnload);
      /* oxlint-disable no-underscore-dangle -- 测试专用全局句柄 */
      window.__bellisStage = undefined;
      /* oxlint-enable no-underscore-dangle */
      mediaRef.current?.close();
      mediaRef.current = null;
      void app.close("react_unmount");
    };
  }, [authenticate]);

  const armAudio = useCallback(async () => {
    const app = appRef.current;
    const lane = audioLaneRef.current;
    if (app === null || lane === null) {
      return;
    }
    try {
      // 用户手势内 resume AudioContext（自动播放限制是正式前置条件）。
      const ok = await lane.arm();
      if (!ok) {
        setError({ code: "audio_arm_failed", message: "AudioContext.resume 被拒绝" });
        return;
      }
      app.armAudio();
      setArmed(true);
    } catch (cause) {
      setError({ code: "audio_arm_failed", message: String(cause) });
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
        <div ref={subtitleRootRef} className="stage-subtitle" aria-label="字幕" />
        <p className="stage-avatar" aria-label="avatar">
          Avatar：<span ref={avatarBadgeRef}>idle</span>
        </p>
        {error !== null && (
          <p role="alert" className="stage-error">
            错误 {error.code}：{error.message}
          </p>
        )}
        {sceneEvents.length > 0 && (
          <p className="stage-scene-events" aria-label="scene-events">
            最近 Scene：{sceneEvents.at(-1)?.state}
          </p>
        )}
      </section>
    </main>
  );
}
