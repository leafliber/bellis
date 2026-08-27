import { parseDecimalString } from "@bellis/contracts";
import type { MediaStreamRejectCode } from "../errors.js";
import type { MediaFrame, MediaKindName } from "./frame-codec.js";

/**
 * Media Stream Registry（docs/phase-1-reference.md）。
 *
 * - Stream 必须先经 Control `media.stream.open` 注册（P4 在收到 accepted 的
 *   open 消息后调用 open()），才能收帧；Registry 绑定单一 Session。
 * - 校验：Session 一致、Stream 已注册、contentType 一致、Sequence 从 0 起
 *   严格连续递增（重复/乱序/缺口都是 sequence_violation）、frameId 不重复。
 * - 关闭后的 Stream 不能复活；总 Stream 数与并发数有上限，frameId 集合
 *   随每 Stream 帧数上限有界。带边界的关闭只在「仍有尾帧可等」期间保留
 *   帧级状态：追平边界或首个违规即压缩为轻量墓碑（窗口不无限驻留）。
 * - Deadline：Header.targetTimeUs 已过（含可配置宽限）且帧不再可用时拒绝。
 *   nowUs 由调用方注入（Runtime 单调微秒）。
 * - 连接关闭时 closeAll() 释放全部 Stream 状态。
 * - Phase 1 Payload 只是测试字节；audio/viseme 是为后续阶段保留的枚举位。
 */

export interface OpenStreamInput {
  readonly streamId: string;
  readonly sessionId: string;
  readonly mediaKind: MediaKindName;
  readonly contentType: string;
}

export interface MediaStreamRegistryOptions {
  /** Registry 绑定的逻辑 Session；帧与注册的 sessionId 必须一致。 */
  readonly sessionId: string;
  /** 并发打开的 Stream 上限，默认 8。 */
  readonly maxOpenStreams?: number;
  /** 单连接生命周期内的总 Stream 上限（含已关闭），默认 1024。 */
  readonly maxTotalStreams?: number;
  /** 单 Stream 接受的帧数上限（frameId 去重集合的上界），默认 65536。 */
  readonly maxFramesPerStream?: number;
  /** targetTimeUs 判定为过期的宽限（微秒），默认 0。 */
  readonly deadlineGraceUs?: bigint;
}

export type MediaStreamOpenResult =
  | { readonly status: "opened" }
  | { readonly status: "rejected"; readonly code: MediaStreamRejectCode; readonly message: string };

export type MediaFrameAcceptResult =
  | { readonly status: "accepted"; readonly lastSequence: bigint }
  | { readonly status: "rejected"; readonly code: MediaStreamRejectCode; readonly message: string };

export type CloseStreamResult =
  | { readonly status: "closed" }
  | { readonly status: "unknown_stream" }
  | { readonly status: "already_closed" };

export interface CloseStreamOptions {
  /**
   * 关闭边界（可选）：closed 与帧跨连接送达无全局顺序——携带边界时，
   * sequence ≤ finalSequence 且严格连续的迟到帧仍可入账（尾帧乱序
   * 不丢）。窗口生命周期有界：追平边界、或收到首个违规/越界帧即压缩
   * 为轻量墓碑（后续一切帧拒绝）。缺省 = 立即关闭。
   */
  readonly finalSequence?: bigint;
}

interface StreamRecord {
  readonly streamId: string;
  readonly mediaKind: MediaKindName;
  readonly contentType: string;
  lastSequence: bigint | null;
  readonly frameIds: Set<string>;
  closed: boolean;
  /** 关闭边界（null = 无待收尾帧；携带边界时保留 lastSequence 续收尾帧）。 */
  finalSequence: bigint | null;
  frameCount: number;
}

/**
 * 压缩为轻量墓碑（禁止复活）：帧级状态（lastSequence/frameIds/计数）全部
 * 释放。带边界的关闭在两种情况下也立即压缩：
 * - 关闭时已追平或超出边界（lastSequence ≥ finalSequence，无尾帧可等）；
 * - 尾帧窗口内发生首个协议违规——窗口即终结（严格连续性意味着后续帧
 *   永不可能合法入账，保留状态只剩内存占用）。
 */
function toTombstone(record: StreamRecord): void {
  record.closed = true;
  record.finalSequence = null;
  record.lastSequence = null;
  record.frameIds.clear();
  record.frameCount = 0;
}

/** 带边界关闭：保留续收乱序尾帧所需的帧级状态（仅当仍有尾帧可等）。 */
function toBoundaryTombstone(record: StreamRecord, finalSequence: bigint): void {
  const caughtUp = record.lastSequence !== null && record.lastSequence >= finalSequence;
  if (caughtUp || finalSequence < 0n) {
    toTombstone(record);
    return;
  }
  record.closed = true;
  record.finalSequence = finalSequence;
}

const DEFAULT_MAX_OPEN_STREAMS = 8;
const DEFAULT_MAX_TOTAL_STREAMS = 1024;
const DEFAULT_MAX_FRAMES_PER_STREAM = 65_536;

function reject(
  code: MediaStreamRejectCode,
  message: string,
): { status: "rejected"; code: MediaStreamRejectCode; message: string } {
  return { status: "rejected", code, message };
}

export class MediaStreamRegistry {
  readonly #sessionId: string;
  readonly #maxOpenStreams: number;
  readonly #maxTotalStreams: number;
  readonly #maxFramesPerStream: number;
  readonly #deadlineGraceUs: bigint;
  readonly #streams = new Map<string, StreamRecord>();
  #totalStreams = 0;

  constructor(options: MediaStreamRegistryOptions) {
    for (const [name, value] of [
      ["maxOpenStreams", options.maxOpenStreams ?? DEFAULT_MAX_OPEN_STREAMS],
      ["maxTotalStreams", options.maxTotalStreams ?? DEFAULT_MAX_TOTAL_STREAMS],
      ["maxFramesPerStream", options.maxFramesPerStream ?? DEFAULT_MAX_FRAMES_PER_STREAM],
    ] as const) {
      if (!Number.isInteger(value) || value < 1) {
        throw new RangeError(`${name} must be a positive integer`);
      }
    }
    if ((options.deadlineGraceUs ?? 0n) < 0n) {
      throw new RangeError("deadlineGraceUs must be non-negative");
    }
    this.#sessionId = options.sessionId;
    this.#maxOpenStreams = options.maxOpenStreams ?? DEFAULT_MAX_OPEN_STREAMS;
    this.#maxTotalStreams = options.maxTotalStreams ?? DEFAULT_MAX_TOTAL_STREAMS;
    this.#maxFramesPerStream = options.maxFramesPerStream ?? DEFAULT_MAX_FRAMES_PER_STREAM;
    this.#deadlineGraceUs = options.deadlineGraceUs ?? 0n;
  }

  get sessionId(): string {
    return this.#sessionId;
  }

  openCount(): number {
    let count = 0;
    for (const record of this.#streams.values()) {
      if (!record.closed) {
        count += 1;
      }
    }
    return count;
  }

  isOpen(streamId: string): boolean {
    const record = this.#streams.get(streamId);
    return record !== undefined && !record.closed;
  }

  /** 注册 Stream（对应 Control media.stream.open 被 accepted 之后）。 */
  open(input: OpenStreamInput): MediaStreamOpenResult {
    if (input.sessionId !== this.#sessionId) {
      return reject("session_mismatch", "stream open declared a different session");
    }
    const existing = this.#streams.get(input.streamId);
    if (existing !== undefined) {
      return existing.closed
        ? reject("stream_closed", "closed streams cannot be revived")
        : reject("stream_already_open", "stream is already open");
    }
    if (this.#totalStreams >= this.#maxTotalStreams) {
      return reject("total_stream_limit_reached", "connection exceeded its total stream budget");
    }
    if (this.openCount() >= this.#maxOpenStreams) {
      return reject("stream_limit_reached", "too many concurrently open streams");
    }
    this.#streams.set(input.streamId, {
      streamId: input.streamId,
      mediaKind: input.mediaKind,
      contentType: input.contentType,
      lastSequence: null,
      frameIds: new Set<string>(),
      closed: false,
      finalSequence: null,
      frameCount: 0,
    });
    this.#totalStreams += 1;
    return { status: "opened" };
  }

  /**
   * 接受一帧：Session/注册状态、contentType、Sequence 严格连续递增、
   * frameId 去重、targetTimeUs Deadline 与帧数上限全部通过才算 accepted。
   */
  accept(frame: MediaFrame, nowUs: bigint | null): MediaFrameAcceptResult {
    if (frame.header.sessionId !== this.#sessionId) {
      return reject("session_mismatch", "frame belongs to a different session");
    }
    const record = this.#streams.get(frame.header.streamId);
    if (record === undefined) {
      return reject("unknown_stream", "stream is not registered on this connection");
    }
    // 已关闭 Stream 的任何拒帧都终结尾帧窗口：严格连续性下后续帧不可能
    // 再合法入账（缺口/越界/重复/迟到都无合法延续），保留帧级状态只剩
    // 内存占用——立即压缩为轻量墓碑。
    const rejectClosed = (code: MediaStreamRejectCode, message: string) => {
      const result = reject(code, message);
      if (record.closed) {
        toTombstone(record);
      }
      return result;
    };
    // 内容一致性与开放 Stream 同规（墓碑尾帧不得绕过）。
    if (frame.header.contentType !== record.contentType) {
      return rejectClosed(
        "content_type_mismatch",
        "frame contentType differs from the registered stream",
      );
    }
    if (frame.mediaKind !== record.mediaKind) {
      return rejectClosed(
        "media_kind_mismatch",
        "frame media kind differs from the registered stream",
      );
    }
    const sequence = parseDecimalString(frame.header.sequence);
    const expected = record.lastSequence === null ? 0n : record.lastSequence + 1n;
    if (record.closed) {
      // 带边界的关闭：尾帧仍须严格连续且不超出边界（closed 经 Control
      // 与帧跨连接送达，无全局顺序——先到的 closed 不丢边界内尾帧）；
      // frameId 去重与 Deadline 检查与开放 Stream 一致（下方继续执行）。
      if (
        record.finalSequence === null ||
        sequence !== expected ||
        sequence > record.finalSequence
      ) {
        return rejectClosed("stream_closed", "stream is closed; frames are no longer accepted");
      }
    } else if (sequence !== expected) {
      return reject(
        "sequence_violation",
        "frame sequence must be contiguous and strictly increasing from 0",
      );
    }
    if (record.frameIds.has(frame.header.frameId)) {
      return rejectClosed("duplicate_frame_id", "frameId was already used in this stream");
    }
    if (frame.header.targetTimeUs !== undefined && nowUs !== null) {
      const targetUs = parseDecimalString(frame.header.targetTimeUs);
      if (nowUs - targetUs >= this.#deadlineGraceUs) {
        return rejectClosed("deadline_exceeded", "frame target time has passed");
      }
    }
    if (record.frameCount >= this.#maxFramesPerStream) {
      return rejectClosed("frame_limit_reached", "stream exceeded its frame budget");
    }
    record.lastSequence = sequence;
    record.frameIds.add(frame.header.frameId);
    record.frameCount += 1;
    if (record.closed && record.finalSequence !== null && sequence === record.finalSequence) {
      // 追平边界：窗口使命完成（后续帧只可能越界），压缩为轻量墓碑。
      toTombstone(record);
    }
    return { status: "accepted", lastSequence: sequence };
  }

  /** 关闭单个 Stream（对应 Control media.stream.closed 或服务端主动关闭）。 */
  close(streamId: string, options?: CloseStreamOptions): CloseStreamResult {
    const record = this.#streams.get(streamId);
    if (record === undefined) {
      return { status: "unknown_stream" };
    }
    if (record.closed) {
      return { status: "already_closed" };
    }
    // 关闭即释放帧级状态（frameId 集合等），只留轻量墓碑防止复活；
    // 否则顺序创建大量流时 frameId 集合会驻留到 closeAll()。携带边界
    // 且仍有尾帧可等时保留水位续收乱序尾帧（见 toBoundaryTombstone）。
    const finalSequence = options?.finalSequence ?? null;
    if (finalSequence === null) {
      toTombstone(record);
    } else {
      toBoundaryTombstone(record, finalSequence);
    }
    return { status: "closed" };
  }

  /** 连接关闭：释放全部 Stream 与 frameId 集合，返回清理的 Stream 数。 */
  closeAll(): number {
    const count = this.#streams.size;
    this.#streams.clear();
    return count;
  }
}
