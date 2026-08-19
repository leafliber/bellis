import type { ContractSchemaKey } from "../src/json-schema.js";

/**
 * 全部公开 Schema 的共享 Fixture 注册表。
 *
 * 三类样本（phase-1-build-guide.md §6.1、§11、ADR 0001 §4）：
 * - valid：Zod 与两套 JSON Schema dialect 都必须接受。
 * - invalid：结构非法，三者都必须拒绝。
 * - refinementOnly：仅被 Zod 跨字段 refine 拒绝（如 Envelope 方向约束、
 *   水位顺序、r2>=r1）。JSON Schema 无法表达这些约束，Ajv 允许通过，
 *   属于文档化的 Zod 运行期校验语义。
 */

export const TRACE_ID = "0123456789abcdef0123456789abcdef";
export const TRACE_ID_ALT = "fedcba9876543210fedcba9876543210";
export const SPAN_ID = "0123456789abcdef";
export const SESSION_ID = "11111111-1111-4111-8111-111111111111";
export const TURN_ID = "22222222-2222-4222-8222-222222222222";
export const CYCLE_ID = "33333333-3333-4333-8333-333333333333";
export const SCENE_ID = "44444444-4444-4444-8444-444444444444";
export const CUE_ID = "55555555-5555-4555-8555-555555555555";
export const SIGNAL_ID = "66666666-6666-4666-8666-666666666666";
export const MESSAGE_ID = "77777777-7777-4777-8777-777777777777";
export const TOOL_RUN_ID = "88888888-8888-4888-8888-888888888888";
export const STREAM_ID = "99999999-9999-4999-8999-999999999999";
export const RUNTIME_VERSION = "0.1.0-phase1";

/** 2^64-1，超过 JSON 安全整数，用于证明十进制字符串无精度损失。 */
export const MAX_U64 = "18446744073709551615";

export interface SchemaFixtures {
  readonly valid: readonly unknown[];
  readonly invalid: readonly unknown[];
  readonly refinementOnly?: readonly unknown[];
}

const speech = {
  schemaVersion: 1,
  text: "我看看现在的任务进度",
  purpose: "tool_notice",
  interruptible: true,
};

const avatarIntent = {
  schemaVersion: 1,
  intentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  motion: "nod_agree",
  channels: ["head", "body"],
  priority: 80,
  durationMs: 1200,
  interruptible: true,
  exclusive: false,
  mutexTags: ["gesture"],
};

const gameIntent = {
  schemaVersion: 1,
  intentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  skillId: "move_to_safe_area",
  timeRelation: "at_scene_start",
  arguments: { area: "left" },
};

const syncPolicy = { schemaVersion: 1, hardLanes: ["audio", "subtitle"], softTimeoutMs: 50 };

const actionFrame = {
  schemaVersion: 1,
  speech,
  sync: syncPolicy,
};

const snapshotBase = {
  schemaVersion: 1,
  reason: "initial",
  sessionId: SESSION_ID,
  sessionStatus: "ready",
  latestServerSeq: MAX_U64,
  signalWatermarks: [{ source: "danmaku", watermark: MAX_U64 }],
  activeScene: null,
  openMediaStreams: [],
  runtimeVersion: RUNTIME_VERSION,
  generatedAtMs: 1_755_600_000_000,
};

function envelope(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    version: 1,
    type: "clock.ping",
    messageId: MESSAGE_ID,
    sessionId: SESSION_ID,
    trace: { traceId: TRACE_ID },
    sentAtUs: "123456789012345",
    payload: {},
    ...overrides,
  };
}

export const SCHEMA_FIXTURES: Record<ContractSchemaKey, SchemaFixtures> = {
  "trace-context": {
    valid: [
      { traceId: TRACE_ID },
      { traceId: TRACE_ID_ALT, spanId: SPAN_ID, sessionId: SESSION_ID, cycleId: CYCLE_ID },
    ],
    invalid: [
      { traceId: TRACE_ID.toUpperCase() },
      { traceId: "0123456789abcdef" },
      { traceId: TRACE_ID, spanId: "0123456789ABCDEF" },
      { traceId: TRACE_ID, sessionId: "not-a-uuid" },
    ],
  },
  "error-envelope": {
    valid: [
      { code: "invalid_message", message: "unknown type", retryable: false, traceId: TRACE_ID },
      {
        code: "backpressure",
        message: "queue full",
        retryable: true,
        traceId: TRACE_ID,
        details: { queue: 512 },
      },
    ],
    invalid: [
      { code: "unknown_code", message: "x", retryable: false, traceId: TRACE_ID },
      { code: "invalid_message", message: "", retryable: false, traceId: TRACE_ID },
      { code: "invalid_message", message: "x", traceId: TRACE_ID },
      { code: "invalid_message", message: "x", retryable: "no", traceId: TRACE_ID },
      { code: "invalid_message", message: "x", retryable: false, traceId: "zz" },
    ],
  },
  signal: {
    valid: [
      {
        schemaVersion: 1,
        id: SIGNAL_ID,
        kind: "danmaku",
        source: "platform-bilibili",
        occurredAt: 1_755_600_000_123,
        priority: 100,
        payload: { text: "你好" },
      },
      {
        schemaVersion: 1,
        id: SIGNAL_ID,
        kind: "gift",
        source: "platform-bilibili",
        occurredAt: 0,
        priority: 0,
        payload: null,
      },
    ],
    invalid: [
      { schemaVersion: 1, id: SIGNAL_ID, kind: "", source: "x", occurredAt: 0, priority: 0 },
      { schemaVersion: 1, id: "no", kind: "danmaku", source: "x", occurredAt: 0, priority: 0 },
      {
        schemaVersion: 1,
        id: SIGNAL_ID,
        kind: "danmaku",
        source: "x",
        occurredAt: -1,
        priority: 0,
      },
      {
        schemaVersion: 1,
        id: SIGNAL_ID,
        kind: "danmaku",
        source: "x",
        occurredAt: 1.5,
        priority: 0,
      },
      {
        schemaVersion: 1,
        id: SIGNAL_ID,
        kind: "danmaku",
        source: "x",
        occurredAt: 0,
        priority: 1001,
      },
      { schemaVersion: 2, id: SIGNAL_ID, kind: "danmaku", source: "x", occurredAt: 0, priority: 0 },
    ],
  },
  "audience-batch": {
    valid: [
      {
        schemaVersion: 1,
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        watermarkFrom: "0",
        watermarkTo: MAX_U64,
        highlights: [{ signalId: SIGNAL_ID, userId: "u1", text: "冲！", weight: 0.5 }],
        topics: [{ label: "进攻", count: 3, participants: 2, examples: ["冲！", "冲冲冲"] }],
        urgentSignals: [],
        tokenEstimate: 128,
      },
    ],
    invalid: [
      {
        schemaVersion: 1,
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        watermarkFrom: "0",
        watermarkTo: "1",
        highlights: [],
        topics: [],
        urgentSignals: [],
        tokenEstimate: -1,
      },
      {
        schemaVersion: 1,
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        watermarkFrom: "0",
        watermarkTo: "-1",
        highlights: [],
        topics: [],
        urgentSignals: [],
        tokenEstimate: 0,
      },
    ],
    refinementOnly: [
      {
        schemaVersion: 1,
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        watermarkFrom: MAX_U64,
        watermarkTo: "0",
        highlights: [],
        topics: [],
        urgentSignals: [],
        tokenEstimate: 0,
      },
    ],
  },
  "speech-intent": {
    valid: [speech, { ...speech, emotion: "happy" }],
    invalid: [
      { ...speech, text: "" },
      { ...speech, purpose: "chatter" },
      { schemaVersion: 1, text: "x", purpose: "answer" },
      { ...speech, emotion: "" },
    ],
  },
  "avatar-intent": {
    valid: [avatarIntent, { ...avatarIntent, motion: undefined, expression: "happy" }],
    invalid: [
      { ...avatarIntent, channels: [] },
      { ...avatarIntent, priority: 101 },
      { ...avatarIntent, durationMs: -1 },
    ],
    refinementOnly: [{ ...avatarIntent, motion: undefined }],
  },
  "game-intent": {
    valid: [gameIntent, { ...gameIntent, timeRelation: "at_speech_word", wordIndex: 3 }],
    invalid: [
      { ...gameIntent, skillId: "" },
      { ...gameIntent, timeRelation: "whenever" },
    ],
    refinementOnly: [
      { ...gameIntent, timeRelation: "at_speech_word" },
      {
        schemaVersion: 1,
        intentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        skillId: "x",
        timeRelation: "at_speech_word",
        arguments: {},
      },
    ],
  },
  "overlay-intent": {
    valid: [
      {
        schemaVersion: 1,
        intentId: CUE_ID,
        kind: "status",
        content: { text: "加载中" },
        durationMs: 500,
      },
    ],
    invalid: [
      { schemaVersion: 1, intentId: CUE_ID, kind: "" },
      { schemaVersion: 1, kind: "status" },
    ],
  },
  "sync-policy": {
    valid: [syncPolicy, { schemaVersion: 1, hardLanes: [] }],
    invalid: [
      { schemaVersion: 1, hardLanes: ["smell"] },
      { schemaVersion: 1, hardLanes: ["audio"], softTimeoutMs: -1 },
    ],
  },
  "action-frame": {
    valid: [
      actionFrame,
      { schemaVersion: 1, sync: syncPolicy, noOp: true },
      { schemaVersion: 1, avatar: [avatarIntent], game: [gameIntent], sync: syncPolicy },
    ],
    invalid: [
      { schemaVersion: 1, speech },
      {
        schemaVersion: 1,
        speech,
        sync: { schemaVersion: 1, hardLanes: ["audio"], softTimeoutMs: -1 },
      },
    ],
    refinementOnly: [{ schemaVersion: 1, sync: syncPolicy }],
  },
  "tool-call": {
    valid: [
      {
        schemaVersion: 1,
        toolRunId: TOOL_RUN_ID,
        toolName: "search_memory",
        arguments: { q: "观众A" },
        idempotencyKey: "mem-42",
      },
    ],
    invalid: [
      { schemaVersion: 1, toolRunId: TOOL_RUN_ID, toolName: "", arguments: {} },
      { schemaVersion: 1, toolName: "x", arguments: {} },
      {
        schemaVersion: 1,
        toolRunId: TOOL_RUN_ID,
        toolName: "x",
        arguments: {},
        idempotencyKey: "",
      },
    ],
  },
  "decision-packet": {
    valid: [
      { schemaVersion: 1, cycleId: CYCLE_ID, toolCalls: [], action: actionFrame, next: "finish" },
      {
        schemaVersion: 1,
        cycleId: CYCLE_ID,
        toolCalls: [
          { schemaVersion: 1, toolRunId: TOOL_RUN_ID, toolName: "search", arguments: {} },
        ],
        action: { schemaVersion: 1, sync: syncPolicy, noOp: true },
        next: "after_tools",
      },
    ],
    invalid: [
      { schemaVersion: 1, cycleId: CYCLE_ID, toolCalls: [], action: actionFrame, next: "retry" },
      { schemaVersion: 1, toolCalls: [], action: actionFrame, next: "finish" },
      { schemaVersion: 1, cycleId: "cycle", toolCalls: [], action: actionFrame, next: "finish" },
    ],
  },
  cue: {
    valid: [
      {
        schemaVersion: 1,
        cueId: CUE_ID,
        lane: "audio",
        anchor: "scene_start",
        offsetMs: 0,
        intent: { chunk: 1 },
      },
      {
        schemaVersion: 1,
        cueId: CUE_ID,
        lane: "subtitle",
        anchor: "speech.word:3",
        offsetMs: -120,
        intent: null,
      },
    ],
    invalid: [
      { schemaVersion: 1, cueId: CUE_ID, lane: "haptics", anchor: "scene_start", offsetMs: 0 },
      { schemaVersion: 1, cueId: CUE_ID, lane: "audio", anchor: "", offsetMs: 0 },
      { schemaVersion: 1, cueId: CUE_ID, lane: "audio", anchor: "scene_start", offsetMs: 1.5 },
    ],
  },
  scene: {
    valid: [
      {
        schemaVersion: 1,
        sceneId: SCENE_ID,
        cycleId: CYCLE_ID,
        groups: [
          {
            schemaVersion: 1,
            groupId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            lanes: ["audio", "subtitle"],
            level: "hard",
          },
        ],
        deadlineMs: 250,
        interruptPolicy: "fade",
      },
    ],
    invalid: [
      {
        schemaVersion: 1,
        sceneId: SCENE_ID,
        cycleId: CYCLE_ID,
        groups: [],
        deadlineMs: 250,
        interruptPolicy: "fade",
      },
      {
        schemaVersion: 1,
        sceneId: SCENE_ID,
        cycleId: CYCLE_ID,
        groups: [
          {
            schemaVersion: 1,
            groupId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            lanes: ["audio"],
            level: "instant",
          },
        ],
        deadlineMs: -1,
        interruptPolicy: "fade",
      },
    ],
  },
  "session-record": {
    valid: [
      {
        schemaVersion: 1,
        recordId: MESSAGE_ID,
        sessionId: SESSION_ID,
        recordType: "scene_committed",
        aggregateId: SCENE_ID,
        aggregateSeq: "42",
        traceId: TRACE_ID,
        occurredAtMs: 1_755_600_000_456,
        payload: { sceneId: SCENE_ID },
      },
      {
        schemaVersion: 1,
        recordId: MESSAGE_ID,
        sessionId: SESSION_ID,
        recordType: "audience_batch",
        traceId: TRACE_ID,
        occurredAtMs: 0,
        payload: {},
      },
    ],
    invalid: [
      {
        schemaVersion: 1,
        recordId: MESSAGE_ID,
        sessionId: SESSION_ID,
        recordType: "",
        traceId: TRACE_ID,
        occurredAtMs: 0,
        payload: {},
      },
      {
        schemaVersion: 1,
        recordId: MESSAGE_ID,
        sessionId: SESSION_ID,
        recordType: "scene_committed",
        traceId: TRACE_ID,
        occurredAtMs: 1.5,
        payload: {},
      },
      {
        schemaVersion: 1,
        recordId: MESSAGE_ID,
        sessionId: SESSION_ID,
        recordType: "scene_committed",
        aggregateSeq: "-1",
        traceId: TRACE_ID,
        occurredAtMs: 0,
        payload: {},
      },
    ],
  },
  "phase1-session-snapshot": {
    valid: [
      snapshotBase,
      {
        ...snapshotBase,
        reason: "replay_gap",
        lastCommittedScene: {
          sceneId: SCENE_ID,
          cycleId: CYCLE_ID,
          status: "committed",
          committedAtMs: 1_755_600_000_789,
        },
      },
    ],
    invalid: [
      { ...snapshotBase, reason: "sync" },
      { ...snapshotBase, activeScene: { sceneId: SCENE_ID } },
      { ...snapshotBase, openMediaStreams: [{ streamId: STREAM_ID }] },
      { ...snapshotBase, latestServerSeq: Number(MAX_U64) },
      {
        ...snapshotBase,
        lastCommittedScene: {
          sceneId: SCENE_ID,
          cycleId: CYCLE_ID,
          status: "prepared",
          committedAtMs: 0,
        },
      },
    ],
  },
  "outbox-message": {
    valid: [
      {
        schemaVersion: 1,
        outboxId: MESSAGE_ID,
        topic: "scene.committed",
        partitionKey: SESSION_ID,
        payload: { sceneId: SCENE_ID },
        createdAtMs: 1_755_600_000_000,
      },
    ],
    invalid: [
      {
        schemaVersion: 1,
        outboxId: MESSAGE_ID,
        topic: "",
        partitionKey: SESSION_ID,
        payload: {},
        createdAtMs: 0,
      },
      {
        schemaVersion: 1,
        outboxId: MESSAGE_ID,
        topic: "t",
        partitionKey: SESSION_ID,
        payload: {},
        createdAtMs: -1,
      },
    ],
  },
  "server-control-envelope": {
    valid: [
      envelope({ direction: "server", seq: "0" }),
      envelope({
        direction: "server",
        seq: MAX_U64,
        type: "scene.committed",
        deadlineUs: "999999",
        "x-extra": 1,
      }),
    ],
    invalid: [
      envelope({ direction: "server" }),
      envelope({ direction: "server", seq: "-1" }),
      envelope({ direction: "server", seq: "1.5" }),
      envelope({ direction: "server", seq: "0", version: 2 }),
      envelope({ direction: "server", seq: "0", type: "clock_ping" }),
      envelope({ direction: "server", seq: "0", trace: { traceId: "nope" } }),
    ],
    refinementOnly: [
      envelope({ direction: "server", seq: "0", ack: "1" }),
      envelope({ direction: "server", seq: "0", idempotencyKey: "k" }),
    ],
  },
  "client-control-envelope": {
    valid: [
      envelope({ direction: "client" }),
      envelope({
        direction: "client",
        ack: MAX_U64,
        idempotencyKey: "scene-42",
        type: "scene.committed",
      }),
    ],
    invalid: [
      envelope({ direction: "client", ack: "-1" }),
      envelope({ direction: "client", idempotencyKey: "" }),
      envelope({ direction: "client", sentAtUs: "1e9" }),
      envelope({ direction: "client", messageId: "m1" }),
    ],
    refinementOnly: [envelope({ direction: "client", seq: "0" })],
  },
  "control-envelope": {
    valid: [
      envelope({ direction: "server", seq: "7" }),
      envelope({ direction: "client", ack: "6" }),
    ],
    invalid: [envelope({ direction: "peer" }), envelope({ direction: "server", seq: "+1" })],
    refinementOnly: [
      envelope({ direction: "server", seq: "1", ack: "0" }),
      envelope({ direction: "client", seq: "1" }),
    ],
  },
  "control-payload": {
    valid: [
      { type: "clock.ping", payload: { c0: "123" } },
      { type: "clock.pong", payload: { c0: "1", r1: "2", r2: "3" } },
      {
        type: "server.hello",
        payload: {
          protocolVersion: 1,
          runtimeVersion: RUNTIME_VERSION,
          heartbeatIntervalMs: 15_000,
          replayWindowSize: 512,
        },
      },
      {
        type: "client.hello",
        payload: { protocolVersion: 1, clientType: "test-client", lastAck: "9" },
      },
      { type: "session.snapshot", payload: { snapshot: snapshotBase } },
      {
        type: "scene.committed",
        payload: { sceneId: SCENE_ID, cycleId: CYCLE_ID, committedAtMs: 1 },
      },
      {
        type: "media.stream.open",
        payload: {
          streamId: STREAM_ID,
          mediaKind: "binary-test",
          contentType: "application/octet-stream",
        },
      },
      {
        type: "error",
        payload: {
          error: { code: "not_ready", message: "starting", retryable: true, traceId: TRACE_ID },
        },
      },
    ],
    invalid: [
      { type: "clock.unknown", payload: {} },
      { type: "clock.pong", payload: { c0: "1" } },
      { type: "server.hello", payload: { protocolVersion: 2 } },
      { type: "session.snapshot", payload: { snapshot: { ...snapshotBase, reason: "sync" } } },
      { type: "error", payload: {} },
    ],
    refinementOnly: [{ type: "clock.pong", payload: { c0: "5", r1: "9", r2: "7" } }],
  },
  "media-frame-header": {
    valid: [
      {
        schemaVersion: 1,
        streamId: STREAM_ID,
        frameId: MESSAGE_ID,
        sessionId: SESSION_ID,
        sceneId: SCENE_ID,
        cueId: CUE_ID,
        sequence: MAX_U64,
        targetTimeUs: "1",
        durationUs: "2",
        contentType: "audio/pcm; rate=48000; layout=mono",
        traceId: TRACE_ID,
      },
      {
        schemaVersion: 1,
        streamId: STREAM_ID,
        frameId: MESSAGE_ID,
        sessionId: SESSION_ID,
        sequence: "0",
        contentType: "application/octet-stream",
        traceId: TRACE_ID,
      },
    ],
    invalid: [
      {
        schemaVersion: 1,
        streamId: STREAM_ID,
        frameId: MESSAGE_ID,
        sessionId: SESSION_ID,
        sequence: "007",
        contentType: "x",
        traceId: TRACE_ID,
      },
      {
        schemaVersion: 1,
        streamId: STREAM_ID,
        frameId: MESSAGE_ID,
        sessionId: SESSION_ID,
        sequence: "1.0",
        contentType: "x",
        traceId: TRACE_ID,
      },
      {
        schemaVersion: 1,
        streamId: STREAM_ID,
        frameId: MESSAGE_ID,
        sessionId: SESSION_ID,
        sequence: "1",
        contentType: "",
        traceId: TRACE_ID,
      },
      {
        schemaVersion: 1,
        streamId: STREAM_ID,
        frameId: MESSAGE_ID,
        sessionId: SESSION_ID,
        sequence: "1",
        contentType: "x",
        traceId: "ABC",
      },
    ],
  },
};
