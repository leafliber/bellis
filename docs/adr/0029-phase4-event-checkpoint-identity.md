# ADR 0029：SSE 恢复游标的事件身份

状态：初始契约与成对身份持久化记录；后续正式请求接入见 ADR 0044，缺口屏障与部分重验见 ADR 0030–0040，全量重验尚未完成。日期：2026-09-07。

## 问题与公开契约

Core 的 service event 游标是全局递增值，响应按 tenant、agent、space group、space 授权过滤。因此相邻可见事件的数字不连续不能证明丢失历史。仅用 `after` 读取事件时，空流也不能区分“已经追平”与“Core 从较旧快照恢复，客户端游标已超前”。宿主不能通过读取 Core 数据库补这个判断。

新增可协商能力 `events.checkpoint.v1`。支持它的 `/v1/events` 接受可选请求头 `X-Iris-After-Event-ID`，与现有 `Last-Event-ID` 一起表示客户端上次接受的事件身份。SDK 的 `events({ after, afterEventId, signal })` 对应这些头；未提供新字段的旧调用保留原行为。

Core 在同一个只读快照中校验原游标处的可见事件身份，并读取后续事件，再发送 HTTP 响应。游标对应的事件缺失、身份改变或已不在当前授权范围内时，返回 JSON ErrorEnvelope：HTTP 410、`history_unavailable`、`retryable=false`，不先发 SSE 200，也不泄露实际事件身份。已验证的最新事件没有后继时仍返回空 SSE；跨号但原事件身份一致时正常继续。

新头要求正游标和 1–512 个可见 ASCII 字符；游标必须处于 SQLite 有符号 64 位非负范围内。SDK 在发送前检查新字段组合。SSE 禁用时同时撤下两项事件能力；新可信初始化凭据包含新能力，已有凭据不被原地改写。

## 证明边界与后续接入

这项校验验证的是最后一个已接受事件在当前授权和历史中仍可定位，不是完整事件日志的密码学连续性证明。它不能识别“保留原锚点但删除更早或其后部分事件”的任意日志篡改；Core 当前没有删除 service event 的保留策略。将来引入事件清理必须增加持久保留边界，不能仅依赖本头。

Bellis 现将 `eventId` 与 `eventCursor` 同一状态写入，并校验两者的组合；写入失败同时恢复内存中的旧身份和游标，下一次继续原游标。旧状态只有数字游标时保留原值，不伪造事件身份。实际删除 SSE 与宿主 Worker 重启已核对持久身份仍对应 Core 的原事件。

后续仍须在协商成功后携带二者；遇到 410 时先封锁旧 Context、人格兜底和历史交付，再通过公开资源读取建立全量重验流程，不能直接跳到新游标。本 ADR 初始验收时默认 Provider 使用 SDK 0.11.1；SDK 0.11.2 的本地 registry 发布被自动审批拒绝，正在等待明确授权。隔离候选消费者已从本地 tarball 安装 0.11.2 并验证真实校验头，但未替换正式依赖。

候选 Core wheel 包含当前工作树的 Migration 16–18。已审查新增 Console 删除预览、实体删除账本和 State 删除代际并通过相关 32 项测试；应用 OpenAPI 仅 `/v1/events` 不同，组件定义一致。探针为 SHA `65169f6067debfcf676f542bfc73e2054a28c7a33350d2aa97d567caed420ab9` 单独接受 Schema 18，不放宽默认 Provider 的 Schema 上限。安装文件核验和候选真实 HTTP/Chromium 结果见 [身份持久化与候选证据](../evidence/phase4-event-identity-probe.json)。

Core/SDK 契约测试、生成物及公开清单摘要见 [校验证据](../evidence/phase4-event-checkpoint-contract-probe.json)。完整 A3 历史缺口、旧快照恢复及 Phase 4 Gate 继续保持未完成。

后续：[ADR 0044](./0044-phase4-installed-checkpoint-sdk.md) 已将同一不可变 SDK 压缩包纳入正式相对路径安装，补齐 Provider 检查点请求，并移除独立探针注入。此前 registry 发布未执行。
