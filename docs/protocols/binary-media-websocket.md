# Binary Media WebSocket 协议（/ws/v1/media）

> 状态：Phase 1 冻结 v1（实现：`@bellis/transport` P1）
> 上位规范：[Phase 1 构建指导 §8.4](../phase-1-build-guide.md) · [ADR 0001](../adr/0001-canonical-core-and-wire-contracts.md)
> 姊妹文档：[Control WebSocket](./control-websocket.md)
>
> 本文档中的全部 `hex media-frame` 代码块由
> `packages/transport/test/unit/protocol-docs.test.ts` 自动验证。

## 1. 范围声明（Phase 1）

Phase 1 只用**随机测试字节**验证传输、顺序与资源限制语义。Payload 不是
可播放音频、viseme 数据或任何真实媒体；`audio` / `viseme` 只是为后续阶段
保留的 kind 枚举位。TTS、AudioWorklet、Live2D 不在本阶段。

## 2. 字节布局（冻结）

一条 WebSocket **二进制消息**恰好承载一帧：

```text
偏移   长度   字段
0      4     magic = ASCII "BELL"（0x42 0x45 0x4C 0x4C）
4      1     protocol version = 0x01
5      1     media kind（见 §3）
6      2     flags，unsigned little-endian（v1 恒为 0x0000）
8      4     header length (N)，unsigned little-endian
12     N     UTF-8 JSON header（MediaFrameHeaderSchema）
12+N   M     binary payload（M = 消息剩余字节数）
```

要点：

- 多字节整数一律**小端**。
- 布局没有 Payload 长度字段：**帧边界 = WebSocket 消息边界**，Payload 占据
  该消息的剩余字节。因此分片送达时无法自判帧结束，解析器提供显式
  `endMessage()`（见 §5）。
- 默认上限（均可配置）：Header 16 KiB，单帧 Payload 1 MiB。读取长度字段后
  **先检查上限再继续累积**，不为超限输入保留完整副本。

## 3. Media Kind 与 Flags

| kind 字节 | 名称 | Phase 1 用途 |
| --- | --- | --- |
| 0x01 | `audio` | 保留（后续阶段 PCM/编码音频） |
| 0x02 | `viseme` | 保留（后续阶段口型数据） |
| 0x03 | `binary-test` | 随机测试字节 |

- 未知 kind 字节（0x00、≥0x04）稳定拒绝（`invalid_media_kind`）。
- Flags v1 恒为 0；任何非零 flags 稳定拒绝（`bad_flags`）。后续版本语义
  变更必须提升 protocol version。

## 4. JSON Header（MediaFrameHeaderSchema）

```json
{
  "schemaVersion": 1,
  "streamId": "99999999-9999-4999-8999-999999999999",
  "frameId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "sessionId": "11111111-1111-4111-8111-111111111111",
  "sceneId": "44444444-4444-4444-8444-444444444444",
  "cueId": "55555555-5555-4555-8555-555555555555",
  "sequence": "0",
  "targetTimeUs": "1755648000000000",
  "durationUs": "20000",
  "contentType": "application/octet-stream",
  "traceId": "0123456789abcdef0123456789abcdef"
}
```

- `sceneId` / `cueId` / `targetTimeUs` / `durationUs` 可选；其余必填。
- `sequence` / `targetTimeUs` / `durationUs` 是非负十进制字符串（微秒/序号，
  Runtime 内转 bigint）。
- `contentType` ≤ 128 字符；必须与 Stream 注册时声明一致。
- 未知扩展键允许，值必须是 JSON 值（可扩展对象策略）。
- Header 语义校验失败 → `invalid_header`。

## 5. 合法帧十六进制示例

Header JSON（紧凑、286 字节总长，Payload = `DE AD BE EF`）：

```json
{"schemaVersion":1,"streamId":"99999999-9999-4999-8999-999999999999","frameId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","sessionId":"11111111-1111-4111-8111-111111111111","sequence":"0","contentType":"application/octet-stream","traceId":"0123456789abcdef0123456789abcdef"}
```

完整帧（`hex media-frame-valid`）：

```hex media-frame-valid
42454c4c010300000e0100007b22736368656d6156657273696f6e223a312c2273747265616d4964223a2239393939393939392d393939392d343939392d383939392d393939393939393939393939222c226672616d654964223a2261616161616161612d616161612d346161612d386161612d616161616161616161616161222c2273657373696f6e4964223a2231313131313131312d313131312d343131312d383131312d313131313131313131313131222c2273657175656e6365223a2230222c22636f6e74656e7454797065223a226170706c69636174696f6e2f6f637465742d73747265616d222c2274726163654964223a223031323334353637383961626364656630313233343536373839616263646566227ddeadbeef
```

拆解：

```text
42 45 4c 4c   magic "BELL"
01            version 1
03            media kind = binary-test
00 00         flags = 0（LE）
0e 01 00 00   header length = 0x010e = 270（LE）
…270 字节…    UTF-8 JSON Header
de ad be ef   payload（4 字节）
```

失败示例（magic 损坏，`hex media-frame-invalid`）：

```hex media-frame-invalid
58454c4c010300000e0100007b22736368656d6156657273696f6e223a317dadbeef
```

（首字节 0x58 ≠ 0x42 → `bad_magic`；即使后续字节随意，也在首个分片被拒绝。）

失败示例（Header 长度字段超出上限，读取长度时立即拒绝）：

```hex media-frame-invalid
42454c4c01030000ffff0000
```

## 6. 增量解析器语义

- `push(chunk)`：按任意分片追加并做增量校验（magic / version / kind /
  flags / header 长度 / Header JSON 与 Schema / Payload 越界），恒返回空数组。
- 累积器是**预分配的有界缓冲**（容量硬上限 = 12 + maxHeaderBytes +
  maxPayloadBytes，跨消息复用）：push 只做一次写入，没有逐分片全量拼接；
  分片再碎也不会出现平方级复制成本。
- **上限检查先于复制**：分片使累计长度越过当前上限（前缀已知后即
  12 + headerLen + maxPayloadBytes）时，最多补齐 12 字节前缀用于精确分类
  错误码，绝不保留超限输入的完整副本，然后立即拒绝。
- `endMessage()`：当前 WS 消息结束时调用，产出完整帧（Header + Payload 副本
  + 解析出的 media kind）并复位累积器；消息在帧完成前结束 → `truncated`。
- 任意非法输入抛出稳定的 `MediaFrameError(code)`，解析器进入 **failed**
  状态；后续输入一律拒绝（`parser_failed`），直到 `reset()`，绝不误读
  后续字节。
- 错误码：`bad_magic` / `unsupported_version` / `invalid_media_kind` /
  `bad_flags` / `header_too_large` / `payload_too_large` / `truncated` /
  `invalid_utf8` / `invalid_json` / `invalid_header` / `parser_failed`。
- 错误信息不含原始字节或 Header 内容。

## 7. Stream 注册与校验（Stream Registry）

- Stream 必须先经 Control 通道 `media.stream.open` 注册（P4 在收到 accepted
  的 open 消息后调用 `registry.open(...)`），Media 通道只接受已注册 Stream
  的帧。Media 连接复用已建立的本地 Session 身份。
- 注册信息：`streamId`（UUID）、`sessionId`（必须与 Registry 绑定的逻辑
  Session 一致）、`mediaKind`、`contentType`。
- 每帧校验（任一失败即拒绝）：
  1. `header.sessionId` 与逻辑 Session 一致（`session_mismatch`）。
  2. Stream 已注册且未关闭（`unknown_stream` / `stream_closed`）。
  3. `contentType` 与注册一致（`content_type_mismatch`）；帧 kind 字节与
     注册 kind 一致（`media_kind_mismatch`）。
  4. `sequence` 从 0 开始**严格连续递增**：重复、乱序、跳号都是
     `sequence_violation`（WebSocket 有序可靠，缺口意味着协议违例）。
  5. `frameId` 在 Stream 内唯一（`duplicate_frame_id`）——与 Sequence 顺序
     是两个独立约束。
  6. `targetTimeUs` 已过（含可配置宽限，默认 0）且帧不可再用 →
     `deadline_exceeded`。比较基准是 Runtime 单调时钟（注入的 nowUs）。
  7. 单 Stream 帧数上限（默认 65536，`frame_limit_reached`）。
- 关闭（Control `media.stream.closed` 或服务端主动）：关闭后的 Stream 不能
  复活（同 `streamId` 再注册被拒绝）。关闭时**立即释放帧级状态**
  （frameId 去重集合、Sequence 游标、帧计数），只保留轻量墓碑防止复活；
  frameId 集合不会驻留到连接结束。
- 资源上限（默认，可配置）：并发打开 Stream 8 个；单连接生命周期总 Stream
  1024 个。连接关闭时 `closeAll()` 释放全部状态。
- **Media Stream 不重放**：重连 / Snapshot 后客户端必须重新注册 Stream。

## 8. 与 Control 通道的关系

- Control 与 Media 使用不同通道与不同队列；持续 Media 压力不会阻塞 Control
  的心跳与取消（优先级见 control-websocket.md §10，集成测试验证）。
- Stream 的打开/关闭走 Control；帧数据走 Media。P4 负责把 accepted 的
  `media.stream.open` 映射为 `registry.open(...)`，把 Media WS 消息交给
  `MediaFrameParser` + `registry.accept(frame, nowUs)`。

## 9. P4 适配器使用方式

```text
onMediaBinaryMessage(chunks):   # 一条 WS 消息可能分片送达
  for chunk in chunks: parser.push(chunk)
  for frame in parser.endMessage():
    result = registry.accept(frame, clock.nowUs())
    if result.status === "rejected": 按 code 映射 error/close 处理
    else: 交给后续管线（Phase 1 只统计/回执）

onMediaClose / onControlClose:
  parser.reset(); registry.closeAll()
```
