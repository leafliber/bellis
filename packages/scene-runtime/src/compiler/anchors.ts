/**
 * Cue Anchor 闭合语法（docs/archive/phase-2/development-guide.md §6.1）。
 *
 * Anchor 是语义时间引用，不是绝对时刻：Runtime/Stage 在 Commit 得到 T0
 * （及可选的 speech 起点映射）后解析为本地目标时刻。允许的语法：
 *
 * - `scene_start`：Scene 生效时刻（T0）；
 * - `speech_start`：主发言开始（Phase 2 语音与 Scene 同刻开始）；
 * - `speech_end`：主发言结束（时长由音频派生，运行期才知道）；
 * - `speech.word:<n>`：第 n 个词的起点（n ≥ 0，来自 TTS 词时间标记）；
 * - `tool_start` / `tool_end`：工具起点/终点（Phase 2 未产生，语法保留）。
 *
 * 本模块是纯函数：不访问时钟、网络或随机源。
 */

export type Anchor =
  | { readonly kind: "scene_start" }
  | { readonly kind: "speech_start" }
  | { readonly kind: "speech_end" }
  | { readonly kind: "speech_word"; readonly wordIndex: number }
  | { readonly kind: "tool_start" }
  | { readonly kind: "tool_end" };

const ANCHOR_PATTERN =
  /^(scene_start|speech_start|speech_end|speech\.word:([0-9]+)|tool_start|tool_end)$/;

/** 解析 anchor 字符串；语法不闭合返回 null（不抛出）。 */
export function parseAnchor(anchor: string): Anchor | null {
  const match = ANCHOR_PATTERN.exec(anchor);
  if (match === null) {
    return null;
  }
  switch (match[1]) {
    case "scene_start":
      return { kind: "scene_start" };
    case "speech_start":
      return { kind: "speech_start" };
    case "speech_end":
      return { kind: "speech_end" };
    case "tool_start":
      return { kind: "tool_start" };
    case "tool_end":
      return { kind: "tool_end" };
    default: {
      // speech.word:<n>（模式已保证非负十进制）
      const index = Number(match[2] ?? "-1");
      return { kind: "speech_word", wordIndex: index };
    }
  }
}

/** anchor 是否属于闭合语法。 */
export function isKnownAnchor(anchor: string): boolean {
  return parseAnchor(anchor) !== null;
}

/**
 * 依赖 speech 的 anchor 集合：Scene 无主发言时这些 anchor 无法解析。
 */
export function requiresSpeech(anchor: Anchor): boolean {
  return (
    anchor.kind !== "scene_start" && anchor.kind !== "tool_start" && anchor.kind !== "tool_end"
  );
}

/**
 * 把 anchor 解析为相对 T0 的基准时刻（微秒）。speech 相关 anchor 需要
 * speech 上下文（起点相对 T0 的偏移）；缺失或未知（如 speech_end 尚无
 * 时长、wordIndex 超出词表）返回 null，由调用方决定拒绝或等待。
 *
 * Phase 2 语音与 Scene 同刻开始：speechStartOffsetUs 缺省为 0。
 */
export function resolveAnchorBaseUs(
  anchor: Anchor,
  context: {
    readonly speechStartOffsetUs?: bigint;
    readonly speechDurationUs?: bigint;
    readonly wordStartOffsetUs?: readonly bigint[];
  },
): bigint | null {
  const speechStart = context.speechStartOffsetUs ?? 0n;
  switch (anchor.kind) {
    case "scene_start":
      return 0n;
    case "speech_start":
      return speechStart;
    case "speech_end":
      return context.speechDurationUs === undefined ? null : speechStart + context.speechDurationUs;
    case "speech_word": {
      const starts = context.wordStartOffsetUs;
      if (starts === undefined || anchor.wordIndex >= starts.length) {
        return null;
      }
      return starts[anchor.wordIndex] ?? null;
    }
    case "tool_start":
    case "tool_end":
      // 工具时刻运行期才知道，且属于下一个 Cycle 的 Scene（architecture §9.1）。
      return null;
  }
}
