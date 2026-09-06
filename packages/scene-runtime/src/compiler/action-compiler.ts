import {
  PHASE_2_PCM_CONTENT_TYPE,
  type ActionFrame,
  type Cue,
  type CueLane,
  type Scene,
  type ScenePlan,
  type StageCapabilities,
  type SyncGroup,
} from "@bellis/contracts";
import { isKnownAnchor } from "./anchors.js";
import type { CompileIssue } from "./issues.js";
import { resolveCompilePolicy, type CompilePolicy } from "./policy.js";
import { validateScenePlan } from "./plan-validator.js";

/**
 * 纯函数 Action Compiler（docs/phase-2-development-guide.md §6.1）。
 *
 * 输入：经 ActionFrameSchema 校验的 ActionFrame、cycleId、Stage 能力快照、
 * 确定性 ID 源与编译策略。输出：noop / ScenePlan / 拒绝 Issue 列表。
 *
 * 纯度契约：不访问网络、数据库、Socket、浏览器或墙钟；相同输入
 * （frame/cycleId/capabilities）与相同 ID 序列得到逐字节相同的结果。
 * 唯一的外部依赖是注入的 ID 源（按固定顺序消费）。
 */

/** 确定性 ID 源：编译器按 sceneId → groupId… → cueId… 的固定顺序消费。 */
export interface CompileIdSource {
  nextId(): string;
}

export interface CompileInput {
  readonly frame: ActionFrame;
  readonly cycleId: string;
  readonly capabilities: StageCapabilities;
  readonly ids: CompileIdSource;
  readonly policy?: Partial<CompilePolicy>;
}

export type CompileResult =
  | { readonly kind: "noop" }
  | {
      readonly kind: "scene";
      readonly plan: ScenePlan;
      readonly advisories: readonly CompileIssue[];
    }
  | { readonly kind: "rejected"; readonly issues: readonly CompileIssue[] };

/** 排序键固定的 Lane 顺序：audio → subtitle → avatar → game → overlay。 */
const LANE_ORDER: readonly CueLane[] = ["audio", "subtitle", "avatar", "game", "overlay"];

function laneOrder(lane: CueLane): number {
  const index = LANE_ORDER.indexOf(lane);
  return index === -1 ? LANE_ORDER.length : index;
}

/** speech 的单一存放点：plan 级扩展键（ScenePlanSchema 可扩展对象允许）。 */
const SPEECH_PLAN_KEY = "speech";
/** Cue 引用 plan 级 speech 的固定引用值（单一发言来源，不复制全文）。 */
const SPEECH_REF = "plan";

interface DraftCue {
  readonly lane: CueLane;
  readonly anchor: string;
  readonly offsetMs: number;
  /** 由 JSON 值（string/number）构成的 intent；最终经 ScenePlanSchema 校验。 */
  readonly intent: Record<string, string | number>;
  /** 能力缺失时丢弃所需的信息。 */
  readonly capabilityIssue: CompileIssue | undefined;
}

export function compileActionFrame(input: CompileInput): CompileResult {
  const policy = resolveCompilePolicy(input.policy);
  const { frame, capabilities, ids } = input;

  if ("noOp" in frame && frame.noOp === true) {
    // 明确静默不伪造空 Scene（§6.1）。
    return { kind: "noop" };
  }

  const issues: CompileIssue[] = [];
  const advisories: CompileIssue[] = [];
  const drafts: DraftCue[] = [];

  /** 评估单个 Cue 草稿的能力；返回是否保留。 */
  const keep = (draft: DraftCue, hard: boolean): boolean => {
    if (draft.capabilityIssue === undefined) {
      return true;
    }
    if (hard) {
      // hard lane 不可满足一律拒绝，策略不允许降级（指南 §6.1）。
      issues.push({
        code: "hard_lane_unsatisfiable",
        message: draft.capabilityIssue.message,
        lane: draft.lane,
        ...(draft.capabilityIssue.intentId === undefined
          ? {}
          : { intentId: draft.capabilityIssue.intentId }),
      });
      return false;
    }
    if (policy.missingCapability === "reject") {
      issues.push(draft.capabilityIssue);
      return false;
    }
    advisories.push(draft.capabilityIssue);
    return false;
  };

  // ---- 生成 Cue 草稿（顺序确定：speech.audio → speech.subtitle → avatar…）----

  const speech = "speech" in frame ? frame.speech : undefined;
  const audioSupported = capabilities.audio.contentTypes.includes(PHASE_2_PCM_CONTENT_TYPE);
  const subtitleSupported = capabilities.subtitle.supported;
  // Avatar 动作与主发言对齐；无发言的静默行动锚定 Scene 生效时刻。
  const avatarAnchor = speech !== undefined ? "speech_start" : "scene_start";

  if (speech !== undefined) {
    if (!audioSupported) {
      drafts.push({
        lane: "audio",
        anchor: "scene_start",
        offsetMs: 0,
        intent: { speechRef: SPEECH_REF, contentType: PHASE_2_PCM_CONTENT_TYPE },
        capabilityIssue: {
          code: "capability_missing",
          message: `stage audio does not accept ${PHASE_2_PCM_CONTENT_TYPE}`,
          lane: "audio",
        },
      });
    } else {
      drafts.push({
        lane: "audio",
        anchor: "scene_start",
        offsetMs: 0,
        intent: { speechRef: SPEECH_REF, contentType: PHASE_2_PCM_CONTENT_TYPE },
        capabilityIssue: undefined,
      });
    }
    if (!subtitleSupported) {
      drafts.push({
        lane: "subtitle",
        anchor: "scene_start",
        offsetMs: 0,
        intent: { speechRef: SPEECH_REF },
        capabilityIssue: {
          code: "capability_missing",
          message: "stage subtitle lane is not supported",
          lane: "subtitle",
        },
      });
    } else {
      drafts.push({
        lane: "subtitle",
        anchor: "scene_start",
        offsetMs: 0,
        intent: { speechRef: SPEECH_REF },
        capabilityIssue: undefined,
      });
    }
  }

  if ("avatar" in frame && frame.avatar !== undefined) {
    for (const intent of frame.avatar) {
      const motion = "motion" in intent ? intent.motion : undefined;
      const expression = "expression" in intent ? intent.expression : undefined;
      const motionKnown = motion === undefined || capabilities.avatar.motions.includes(motion);
      const expressionKnown =
        expression === undefined || capabilities.avatar.expressions.includes(expression);
      const unknown: string[] = [];
      if (!motionKnown) {
        unknown.push(`motion:${motion}`);
      }
      if (!expressionKnown) {
        unknown.push(`expression:${expression ?? ""}`);
      }
      const avatarIntent: Record<string, string | number> = {
        intentId: intent.intentId,
        // 动作时长随意图下发：Stage Avatar Lane 的真实完成信号（呈现窗口）。
        durationMs: intent.durationMs,
      };
      if (motion !== undefined) {
        avatarIntent.motion = motion;
      }
      if (expression !== undefined) {
        avatarIntent.expression = expression;
      }
      drafts.push({
        lane: "avatar",
        anchor: avatarAnchor,
        offsetMs: 0,
        intent: avatarIntent,
        capabilityIssue:
          unknown.length > 0
            ? {
                code: "capability_missing",
                message: `avatar adapter does not declare ${unknown.join(", ")}`,
                lane: "avatar",
                intentId: intent.intentId,
              }
            : undefined,
      });
    }
  }

  // game/overlay 意图：Stage 能力模型没有对应 Lane，按策略处置
  //（Phase 2 Fake Model 不产生这两类意图；此处保持通用性）。
  const gameIntents = "game" in frame ? frame.game : undefined;
  if (gameIntents !== undefined) {
    for (const intent of gameIntents) {
      drafts.push({
        lane: "game",
        anchor: "scene_start",
        offsetMs: 0,
        intent: { intentId: intent.intentId },
        capabilityIssue: {
          code: "capability_missing",
          message: "stage has no game lane capability",
          lane: "game",
          intentId: intent.intentId,
        },
      });
    }
  }
  const overlayIntents = "overlay" in frame ? frame.overlay : undefined;
  if (overlayIntents !== undefined) {
    for (const intent of overlayIntents) {
      drafts.push({
        lane: "overlay",
        anchor: "scene_start",
        offsetMs: 0,
        intent: { intentId: intent.intentId },
        capabilityIssue: {
          code: "capability_missing",
          message: "stage has no overlay lane capability",
          lane: "overlay",
          intentId: intent.intentId,
        },
      });
    }
  }

  // ---- 能力过滤 ----

  const hardLanes = new Set<CueLane>("sync" in frame ? frame.sync.hardLanes : []);
  const kept: DraftCue[] = [];
  for (const draft of drafts) {
    if (keep(draft, hardLanes.has(draft.lane))) {
      kept.push(draft);
    }
  }
  if (issues.length > 0) {
    return { kind: "rejected", issues };
  }
  if (kept.length === 0) {
    // 全部 Cue 因缺能力被 omit：无可执行内容，按拒绝处理而非空 Scene。
    return {
      kind: "rejected",
      issues: [
        {
          code: "capability_missing",
          message: "no executable cue remains after capability policy",
        },
      ],
    };
  }

  // ---- anchor 闭合（speech 依赖）----

  for (const draft of kept) {
    if (!isKnownAnchor(draft.anchor)) {
      return {
        kind: "rejected",
        issues: [
          {
            code: "anchor_unresolved",
            message: `unknown anchor ${draft.anchor}`,
            lane: draft.lane,
          },
        ],
      };
    }
    if (draft.anchor.startsWith("speech") && speech === undefined) {
      return {
        kind: "rejected",
        issues: [
          {
            code: "anchor_unresolved",
            message: `anchor ${draft.anchor} requires a speech intent`,
            lane: draft.lane,
          },
        ],
      };
    }
  }

  // ---- 上限 ----

  if (kept.length > policy.maxCues) {
    return {
      kind: "rejected",
      issues: [
        {
          code: "cue_limit_exceeded",
          message: `compiled ${kept.length} cues exceeding policy limit ${policy.maxCues}`,
        },
      ],
    };
  }

  // ---- 组装（ID 消费顺序固定：sceneId → groupId（hard→soft）→ cueId）----

  const sceneId = ids.nextId();
  const keptLanes = new Set<CueLane>(kept.map((cue) => cue.lane));
  const hardGroupLanes = [...hardLanes]
    .filter((lane) => keptLanes.has(lane))
    .toSorted((a, b) => laneOrder(a) - laneOrder(b));
  const softGroupLanes = [...keptLanes]
    .filter((lane) => !hardLanes.has(lane))
    .toSorted((a, b) => laneOrder(a) - laneOrder(b));

  const groups: SyncGroup[] = [];
  if (hardGroupLanes.length > 0) {
    groups.push({
      schemaVersion: 1,
      groupId: ids.nextId(),
      lanes: hardGroupLanes,
      level: "hard",
    });
  }
  if (softGroupLanes.length > 0) {
    groups.push({
      schemaVersion: 1,
      groupId: ids.nextId(),
      lanes: softGroupLanes,
      level: "soft",
    });
  }

  const sortedCues = kept.toSorted((a, b) => {
    const byLane = laneOrder(a.lane) - laneOrder(b.lane);
    return byLane !== 0 ? byLane : a.anchor.localeCompare(b.anchor);
  });
  const cues: Cue[] = sortedCues.map((draft) => ({
    schemaVersion: 1,
    cueId: ids.nextId(),
    lane: draft.lane,
    anchor: draft.anchor,
    offsetMs: draft.offsetMs,
    intent: draft.intent,
  }));

  // interruptPolicy：任一来源不可打断 → finish；全部可打断 → fade。
  const sourcesInterruptible =
    (speech === undefined || speech.interruptible) &&
    !("avatar" in frame && (frame.avatar ?? []).some((intent) => !intent.interruptible));
  const interruptPolicy = sourcesInterruptible ? "fade" : "finish";

  const scene: Scene = {
    schemaVersion: 1,
    sceneId,
    cycleId: input.cycleId,
    groups,
    deadlineMs: policy.defaultDeadlineMs,
    interruptPolicy,
  };
  const plan: ScenePlan & { speech?: unknown } = {
    schemaVersion: 1,
    softTimeoutMs: frame.sync.softTimeoutMs ?? 500,
    scene,
    cues,
    ...(speech === undefined ? {} : { [SPEECH_PLAN_KEY]: speech }),
  };

  // ---- 输出复核（运行期校验，不依赖静态类型）----

  const validation = validateScenePlan(plan);
  if (!validation.ok) {
    return { kind: "rejected", issues: validation.issues };
  }
  return { kind: "scene", plan: validation.plan, advisories };
}
