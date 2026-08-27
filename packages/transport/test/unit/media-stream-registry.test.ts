import { describe, expect, it } from "vitest";
import { VirtualClock } from "@bellis/testkit";
import { MediaFrameParser, MediaStreamRegistry, encodeMediaFrame } from "../../src/index.js";
import { testHeader } from "./media-codec.test.js";
import type { MediaFrameHeader } from "@bellis/contracts";
import type { MediaFrame } from "../../src/index.js";
import { FRAME_ID_A, FRAME_ID_B, SESSION_ID, STREAM_ID } from "../helpers.js";

type HeaderOverrides = {
  sequence?: string;
  frameId?: string;
  sessionId?: string;
  contentType?: string;
  targetTimeUs?: string;
};

function header(overrides: HeaderOverrides = {}): MediaFrameHeader {
  return testHeader(overrides);
}

function frame(overrides: HeaderOverrides = {}, payload = new Uint8Array(2)): MediaFrame {
  return {
    header: header(overrides),
    payload,
    mediaKind: "binary-test",
  };
}

function registry(
  overrides: Omit<ConstructorParameters<typeof MediaStreamRegistry>[0], "sessionId"> = {},
) {
  return new MediaStreamRegistry({ sessionId: SESSION_ID, ...overrides });
}

/** 帧内唯一 frameId（按序号派生）。 */
function fid(n: number): string {
  return `aaaaaaaa-aaaa-4aaa-8aaa-${n.toString(16).padStart(12, "0")}`;
}

describe("MediaStreamRegistry", () => {
  it("注册 → 按严格连续 Sequence 收帧 → 关闭 → 关闭后拒帧", () => {
    const clock = new VirtualClock();
    const reg = registry();
    expect(
      reg.open({
        streamId: STREAM_ID,
        sessionId: SESSION_ID,
        mediaKind: "binary-test",
        contentType: "application/octet-stream",
      }),
    ).toEqual({ status: "opened" });
    expect(reg.accept(frame({ sequence: "0", frameId: FRAME_ID_A }), clock.nowUs())).toEqual({
      status: "accepted",
      lastSequence: 0n,
    });
    expect(reg.accept(frame({ sequence: "1", frameId: FRAME_ID_B }), clock.nowUs())).toEqual({
      status: "accepted",
      lastSequence: 1n,
    });
    expect(reg.close(STREAM_ID)).toEqual({ status: "closed" });
    expect(reg.accept(frame({ sequence: "2" }), clock.nowUs()).status).toBe("rejected");
    // 关闭后不能复活。
    expect(
      reg.open({
        streamId: STREAM_ID,
        sessionId: SESSION_ID,
        mediaKind: "binary-test",
        contentType: "application/octet-stream",
      }).status,
    ).toBe("rejected");
  });

  it("未注册 Stream / Session 不匹配 → 拒绝", () => {
    const clock = new VirtualClock();
    const reg = registry();
    const unknown = reg.accept(frame(), clock.nowUs());
    expect(unknown.status).toBe("rejected");
    if (unknown.status === "rejected") {
      expect(unknown.code).toBe("unknown_stream");
    }
    expect(
      reg.open({
        streamId: STREAM_ID,
        sessionId: "00000000-0000-4000-8000-000000000000",
        mediaKind: "binary-test",
        contentType: "application/octet-stream",
      }).status,
    ).toBe("rejected");
    const wrongSession = reg.accept(
      frame({ sessionId: "00000000-0000-4000-8000-000000000000" }),
      clock.nowUs(),
    );
    if (wrongSession.status === "rejected") {
      expect(wrongSession.code).toBe("session_mismatch");
    }
  });

  it("重复注册拒绝；并发上限与总上限生效", () => {
    const reg = registry({ maxOpenStreams: 1, maxTotalStreams: 2 });
    const open = {
      streamId: STREAM_ID,
      sessionId: SESSION_ID,
      mediaKind: "binary-test" as const,
      contentType: "application/octet-stream",
    };
    reg.open(open);
    expect(reg.open(open).status).toBe("rejected");
    expect(reg.open({ ...open, streamId: FRAME_ID_A }).status).toBe("rejected"); // 并发上限
    reg.close(STREAM_ID);
    expect(reg.open({ ...open, streamId: FRAME_ID_A })).toEqual({ status: "opened" });
    expect(reg.open({ ...open, streamId: FRAME_ID_B }).status).toBe("rejected"); // 总上限
    expect(reg.closeAll()).toBe(2);
    expect(reg.openCount()).toBe(0);
  });

  it("Sequence 必须从 0 严格连续：跳号/重复/乱序都是 sequence_violation", () => {
    const clock = new VirtualClock();
    const reg = registry();
    reg.open({
      streamId: STREAM_ID,
      sessionId: SESSION_ID,
      mediaKind: "binary-test",
      contentType: "application/octet-stream",
    });
    const gap = reg.accept(frame({ sequence: "1" }), clock.nowUs());
    if (gap.status === "rejected") {
      expect(gap.code).toBe("sequence_violation");
    }
    reg.accept(frame({ sequence: "0" }), clock.nowUs());
    // 重复 Sequence（0 已消费）→ sequence_violation。
    const dup = reg.accept(frame({ sequence: "0", frameId: FRAME_ID_B }), clock.nowUs());
    if (dup.status === "rejected") {
      expect(dup.code).toBe("sequence_violation");
    }
    const back = reg.accept(frame({ sequence: "0", frameId: FRAME_ID_B }), clock.nowUs());
    if (back.status === "rejected") {
      expect(back.code).toBe("sequence_violation");
    }
  });

  it("frameId 去重与 Sequence 顺序是两个约束", () => {
    const clock = new VirtualClock();
    const reg = registry();
    reg.open({
      streamId: STREAM_ID,
      sessionId: SESSION_ID,
      mediaKind: "binary-test",
      contentType: "application/octet-stream",
    });
    reg.accept(frame({ sequence: "0", frameId: FRAME_ID_A }), clock.nowUs());
    // 新 Sequence 但复用 frameId → duplicate_frame_id（不是 sequence_violation）。
    const reused = reg.accept(frame({ sequence: "1", frameId: FRAME_ID_A }), clock.nowUs());
    if (reused.status === "rejected") {
      expect(reused.code).toBe("duplicate_frame_id");
    }
  });

  it("contentType / media kind 与注册不一致 → 拒绝", () => {
    const clock = new VirtualClock();
    const reg = registry();
    reg.open({
      streamId: STREAM_ID,
      sessionId: SESSION_ID,
      mediaKind: "binary-test",
      contentType: "application/octet-stream",
    });
    const contentType = reg.accept(frame({ contentType: "audio/pcm" }), clock.nowUs());
    if (contentType.status === "rejected") {
      expect(contentType.code).toBe("content_type_mismatch");
    }
    const kind = reg.accept({ ...frame(), mediaKind: "audio" }, clock.nowUs());
    if (kind.status === "rejected") {
      expect(kind.code).toBe("media_kind_mismatch");
    }
  });

  it("targetTimeUs 已过 → deadline_exceeded；未来 → 接受", () => {
    const clock = new VirtualClock();
    clock.advanceBy(1_000_000n);
    const reg = registry();
    reg.open({
      streamId: STREAM_ID,
      sessionId: SESSION_ID,
      mediaKind: "binary-test",
      contentType: "application/octet-stream",
    });
    const late = reg.accept(frame({ targetTimeUs: "500000" }), clock.nowUs());
    if (late.status === "rejected") {
      expect(late.code).toBe("deadline_exceeded");
    }
    const soon = reg.accept(frame({ targetTimeUs: "999999999" }), clock.nowUs());
    expect(soon.status).toBe("accepted");
  });

  it("带 finalSequence 边界的关闭：乱序尾帧仍入账、尾帧全量校验（各自独立流）", () => {
    const clock = new VirtualClock();
    const reg = registry();
    reg.open({
      streamId: STREAM_ID,
      sessionId: SESSION_ID,
      mediaKind: "binary-test",
      contentType: "application/octet-stream",
    });
    expect(reg.accept(frame({ sequence: "0", frameId: fid(0) }), clock.nowUs()).status).toBe(
      "accepted",
    );
    // closed 先于尾帧到达（跨连接乱序）：边界 = 已交送的最大 Sequence 3。
    expect(reg.close(STREAM_ID, { finalSequence: 3n }).status).toBe("closed");
    // 合法尾帧在窗口内照常入账。
    expect(reg.accept(frame({ sequence: "1", frameId: fid(1) }), clock.nowUs()).status).toBe(
      "accepted",
    );
    // 超出边界（发送侧从未交送）→ 拒绝。
    const beyond = reg.accept(frame({ sequence: "4", frameId: fid(4) }), clock.nowUs());
    expect(beyond.status).toBe("rejected");
    // 跳号（乱序）→ 拒绝（连续性在边界内同样成立）。
    const gap = reg.accept(frame({ sequence: "5", frameId: fid(5) }), clock.nowUs());
    expect(gap.status).toBe("rejected");

    // 尾帧绕过校验的回归用例（各自独立流：违规终结窗口后无合法延续）：
    // 内容不一致 / 重复 frameId / Deadline 过期都必须拒绝（与开放 Stream 同规）。
    const contentTypeStream = registry();
    contentTypeStream.open({
      streamId: STREAM_ID,
      sessionId: SESSION_ID,
      mediaKind: "binary-test",
      contentType: "application/octet-stream",
    });
    contentTypeStream.accept(frame({ sequence: "0", frameId: fid(0) }), clock.nowUs());
    contentTypeStream.close(STREAM_ID, { finalSequence: 3n });
    expect(
      contentTypeStream.accept(
        frame({ sequence: "1", frameId: fid(1), contentType: "audio/other" }),
        clock.nowUs(),
      ).status,
    ).toBe("rejected");

    const duplicateStream = registry();
    duplicateStream.open({
      streamId: STREAM_ID,
      sessionId: SESSION_ID,
      mediaKind: "binary-test",
      contentType: "application/octet-stream",
    });
    duplicateStream.accept(frame({ sequence: "0", frameId: fid(0) }), clock.nowUs());
    duplicateStream.close(STREAM_ID, { finalSequence: 3n });
    expect(
      duplicateStream.accept(frame({ sequence: "1", frameId: fid(0) }), clock.nowUs()).status,
    ).toBe("rejected");

    const lateClock = new VirtualClock();
    lateClock.advanceBy(1_000_000n);
    const deadlineStream = registry();
    deadlineStream.open({
      streamId: STREAM_ID,
      sessionId: SESSION_ID,
      mediaKind: "binary-test",
      contentType: "application/octet-stream",
    });
    deadlineStream.accept(frame({ sequence: "0", frameId: fid(0) }), lateClock.nowUs());
    deadlineStream.close(STREAM_ID, { finalSequence: 3n });
    expect(
      deadlineStream.accept(
        frame({ sequence: "1", frameId: fid(1), targetTimeUs: "1" }),
        lateClock.nowUs(),
      ).status,
    ).toBe("rejected");
  });

  it("尾帧窗口内首个协议违规即终结：后续合法尾帧不再入账", () => {
    const clock = new VirtualClock();
    const reg = registry();
    reg.open({
      streamId: STREAM_ID,
      sessionId: SESSION_ID,
      mediaKind: "binary-test",
      contentType: "application/octet-stream",
    });
    reg.accept(frame({ sequence: "0", frameId: fid(0) }), clock.nowUs());
    reg.close(STREAM_ID, { finalSequence: 3n });
    // 违规尾帧（contentType 不一致）→ 拒绝并终结窗口。
    const badTail = reg.accept(
      frame({ sequence: "1", frameId: fid(1), contentType: "audio/other" }),
      clock.nowUs(),
    );
    expect(badTail.status).toBe("rejected");
    if (badTail.status === "rejected") {
      expect(badTail.code).toBe("content_type_mismatch");
    }
    // 同一窗口内本可合法入账的尾帧 → stream_closed（窗口已终结）。
    const validAfterViolation = reg.accept(
      frame({ sequence: "1", frameId: fid(1) }),
      clock.nowUs(),
    );
    expect(validAfterViolation.status).toBe("rejected");
    if (validAfterViolation.status === "rejected") {
      expect(validAfterViolation.code).toBe("stream_closed");
    }
    // 客户端拒帧后的 close() 只会得到 already_closed（与真实 Stage 行为一致）。
    expect(reg.close(STREAM_ID)).toEqual({ status: "already_closed" });
  });

  it("关闭时已追平边界 → 立即压缩轻量墓碑（无尾帧可等）", () => {
    const clock = new VirtualClock();
    const reg = registry();
    reg.open({
      streamId: STREAM_ID,
      sessionId: SESSION_ID,
      mediaKind: "binary-test",
      contentType: "application/octet-stream",
    });
    reg.accept(frame({ sequence: "0", frameId: fid(0) }), clock.nowUs());
    reg.accept(frame({ sequence: "1", frameId: fid(1) }), clock.nowUs());
    // 全部帧已入账后才收到 closed（finalSequence = lastSequence）。
    expect(reg.close(STREAM_ID, { finalSequence: 1n }).status).toBe("closed");
    // 帧级状态已释放：任何帧（含边界内合法延续）一律 stream_closed。
    const after = reg.accept(frame({ sequence: "2", frameId: fid(2) }), clock.nowUs());
    expect(after.status).toBe("rejected");
    if (after.status === "rejected") {
      expect(after.code).toBe("stream_closed");
    }
    // 越界边界（finalSequence < lastSequence，发送侧声明矛盾）同样立即压缩。
    const reg2 = registry();
    reg2.open({
      streamId: STREAM_ID,
      sessionId: SESSION_ID,
      mediaKind: "binary-test",
      contentType: "application/octet-stream",
    });
    reg2.accept(frame({ sequence: "0", frameId: fid(0) }), clock.nowUs());
    reg2.accept(frame({ sequence: "1", frameId: fid(1) }), clock.nowUs());
    reg2.close(STREAM_ID, { finalSequence: 0n });
    const contradictory = reg2.accept(frame({ sequence: "2", frameId: fid(2) }), clock.nowUs());
    expect(contradictory.status).toBe("rejected");
    if (contradictory.status === "rejected") {
      expect(contradictory.code).toBe("stream_closed");
    }
  });

  it("尾帧追平边界 → 接受并立即压缩（后续帧一律拒绝）", () => {
    const clock = new VirtualClock();
    const reg = registry();
    reg.open({
      streamId: STREAM_ID,
      sessionId: SESSION_ID,
      mediaKind: "binary-test",
      contentType: "application/octet-stream",
    });
    reg.accept(frame({ sequence: "0", frameId: fid(0) }), clock.nowUs());
    reg.close(STREAM_ID, { finalSequence: 2n });
    expect(reg.accept(frame({ sequence: "1", frameId: fid(1) }), clock.nowUs())).toEqual({
      status: "accepted",
      lastSequence: 1n,
    });
    // 追平边界的最后一帧：接受 + 窗口使命完成。
    const last = reg.accept(frame({ sequence: "2", frameId: fid(2) }), clock.nowUs());
    expect(last).toEqual({ status: "accepted", lastSequence: 2n });
    const extra = reg.accept(frame({ sequence: "3", frameId: fid(3) }), clock.nowUs());
    expect(extra.status).toBe("rejected");
    if (extra.status === "rejected") {
      expect(extra.code).toBe("stream_closed");
    }
  });

  it("错 Session 的帧落在已关闭带边界 Stream 上：同样终结尾帧窗口", () => {
    const clock = new VirtualClock();
    const reg = registry();
    reg.open({
      streamId: STREAM_ID,
      sessionId: SESSION_ID,
      mediaKind: "binary-test",
      contentType: "application/octet-stream",
    });
    reg.accept(frame({ sequence: "0", frameId: fid(0) }), clock.nowUs());
    expect(reg.close(STREAM_ID, { finalSequence: 2n }).status).toBe("closed");
    // 错 Session 帧：session_mismatch（校验顺序保持首位）且窗口终结。
    const wrongSession = reg.accept(
      frame({ sequence: "1", frameId: fid(1), sessionId: "00000000-0000-4000-8000-000000000000" }),
      clock.nowUs(),
    );
    if (wrongSession.status === "rejected") {
      expect(wrongSession.code).toBe("session_mismatch");
    }
    // 客户端再 close 得 already_closed；随后正确 Session 的合法尾帧被拒。
    expect(reg.close(STREAM_ID)).toEqual({ status: "already_closed" });
    const validAfter = reg.accept(frame({ sequence: "1", frameId: fid(1) }), clock.nowUs());
    if (validAfter.status === "rejected") {
      expect(validAfter.code).toBe("stream_closed");
    }
  });

  it("带边界墓碑驻留期限：closedAtUs 起算届满后（帧到达懒扫描）压缩", () => {
    const clock = new VirtualClock();
    const reg = registry({ maxBoundaryWindowUs: 500_000n });
    reg.open({
      streamId: STREAM_ID,
      sessionId: SESSION_ID,
      mediaKind: "binary-test",
      contentType: "application/octet-stream",
    });
    reg.accept(frame({ sequence: "0", frameId: fid(0) }), clock.nowUs());
    expect(reg.close(STREAM_ID, { finalSequence: 2n, closedAtUs: clock.nowUs() }).status).toBe(
      "closed",
    );
    // 期限内：合法尾帧照常入账。
    clock.advanceBy(400_000n);
    expect(reg.accept(frame({ sequence: "1", frameId: fid(1) }), clock.nowUs()).status).toBe(
      "accepted",
    );
    // 期限届满（最后一帧永不到达、无违规帧）：任何后续帧到达时懒压缩，
    // 帧级状态（frameIds 等）不再驻留。
    clock.advanceBy(200_000n);
    const expired = reg.accept(frame({ sequence: "2", frameId: fid(2) }), clock.nowUs());
    if (expired.status === "rejected") {
      expect(expired.code).toBe("stream_closed");
    }
    expect(reg.accept(frame({ sequence: "2", frameId: fid(2) }), clock.nowUs()).status).toBe(
      "rejected",
    );
  });

  it("nowUs=null 跳过 Deadline 检查（时钟估计未就绪，不做跨域误判）", () => {
    const clock = new VirtualClock();
    clock.advanceBy(1_000_000_000n);
    const reg = registry();
    reg.open({
      streamId: STREAM_ID,
      sessionId: SESSION_ID,
      mediaKind: "binary-test",
      contentType: "application/octet-stream",
    });
    // targetTimeUs 属另一时钟域（Runtime 单调），本域时钟不可比较：
    // 估计缺失时接受帧（deadline 检查交由映射后的调用方域判断）。
    const result = reg.accept(frame({ targetTimeUs: "1" }), null);
    expect(result.status).toBe("accepted");
  });

  it("deadline 宽限可配置", () => {
    const clock = new VirtualClock();
    clock.advanceBy(1_000_000n);
    const reg = registry({ deadlineGraceUs: 100_000n });
    reg.open({
      streamId: STREAM_ID,
      sessionId: SESSION_ID,
      mediaKind: "binary-test",
      contentType: "application/octet-stream",
    });
    const withinGrace = reg.accept(frame({ targetTimeUs: "950000" }), clock.nowUs());
    expect(withinGrace.status).toBe("accepted");
    const outsideGrace = reg.accept(
      frame({ sequence: "1", frameId: FRAME_ID_B, targetTimeUs: "890000" }),
      clock.nowUs(),
    );
    if (outsideGrace.status === "rejected") {
      expect(outsideGrace.code).toBe("deadline_exceeded");
    }
  });

  it("单 Stream 帧数上限", () => {
    const clock = new VirtualClock();
    const reg = registry({ maxFramesPerStream: 1 });
    reg.open({
      streamId: STREAM_ID,
      sessionId: SESSION_ID,
      mediaKind: "binary-test",
      contentType: "application/octet-stream",
    });
    expect(reg.accept(frame({ sequence: "0" }), clock.nowUs()).status).toBe("accepted");
    const over = reg.accept(frame({ sequence: "1", frameId: FRAME_ID_B }), clock.nowUs());
    if (over.status === "rejected") {
      expect(over.code).toBe("frame_limit_reached");
    }
  });

  it("encodeMediaFrame → Parser → Registry 全链路类型一致", () => {
    const clock = new VirtualClock();
    const reg = registry();
    reg.open({
      streamId: STREAM_ID,
      sessionId: SESSION_ID,
      mediaKind: "binary-test",
      contentType: "application/octet-stream",
    });
    const bytes = encodeMediaFrame(frame({ sequence: "0" }, Uint8Array.from([9, 9, 9])));
    const parser = new MediaFrameParser();
    parser.push(bytes.subarray(0, 7));
    parser.push(bytes.subarray(7));
    const parsed = parser.endMessage()[0];
    expect(parsed).toBeDefined();
    if (parsed === undefined) {
      return;
    }
    const result = reg.accept(parsed, clock.nowUs());
    expect(result).toEqual({ status: "accepted", lastSequence: 0n });
  });
});
