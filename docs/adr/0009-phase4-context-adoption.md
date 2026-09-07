# ADR 0009：Phase 4 Context 采用与 Iris 摘要兼容

状态：A0/A1 实施；2026-09-06。上位语义继续服从 ADR 0007/0008。

## 最小纵向边界

`ModelContextPort` 由宿主注入唯一 Decision Loop，在模型请求之前执行可取消的 Context 构建。Loop 在发送请求及 adoption 前复核 Context generation；关闭、Session 切换或隐私失效取消尚未采用工作。Phase 3 未注入时保留原请求装配路径。Phase 4 不把 Phase 3 的计划发言当作已确认的 Conversation；实际输出历史由 A2 补充。

`Phase4MemoryHost` 先在 Runtime 功能模块内实现。Memory/Persona 双 Port 的同一对象只有一个生命周期所有者。人格来自启动就绪的结构化快照，规则先于人格，白名单渲染字段不允许声明工具权限。人格发布版本及 rendererVersion 进入 promptEpoch，瞬时 state 不进入 Epoch。

Context 使用 UTF-8 字节作为保守 Token 上界，固定预算包含指令、工具目录与消息开销；本地动态内容按 Unicode 字符边界裁剪，记忆按整块舍弃。Provider tokenEstimate 不能降低宿主计费。低于稳定前缀所需预算直接拒绝。空 actor 不查询，私有标签、跨域和未声明公开标签的块不能进入公开直播输入；Recall 结果不跨 Cycle 缓存。

## Manifest、Usage 与 Migration 6

新增 `ContextManifest` / `ContextAdoption` v1 和双 dialect Schema。Manifest 记录 Session/Cycle/modelRequest、身份/隐私版本、Persona Slot、预算、每个 Recall 的完整 returned/hostSelected/modelVisible，以及块来源摘要、原文/规范化/可见文本摘要与排除原因。正文不保存在 Manifest，不能据此宣称可还原完整 Prompt。

`phase3_adopt_cycle` 增加可选 context，老调用保持兼容。DB Worker 在已有 adoption 事务内核验身份、Manifest SHA-256、预算及 Usage 血缘，再写 `phase4_context_manifests` 与 `memory.usage.v1` Outbox。任何一步失败，Cycle、水位、Manifest、Usage 同时回滚。未采用请求可能已发送给模型，但不产生“已采用 Usage”。远端 ACK 由后台 Dispatcher 等待。

Migration 6 为新增表，不改历史 Migration checksum。`phase4ReadContextManifest(sessionId, cycleId)` 仅按原采用事实读取，不重新 Recall。二进制回退仍需验证旧版本对新增 Migration 的读取策略，本 ADR 不承诺可直接降级。

## Iris 来源摘要

Provider 0.2.0 / mapping 2 的实测范围固定为 Core 0.12.0、Schema 14、Contract 1.10.0、已安装 SDK 0.11.1。仅 off Surface 模式有本轮真实接入证据。

Recall 的 16/64 位 hex `contentHash` 原样保留并标为 passthrough；`textHash` 独立计算。未知资源类型不能被 categoryMap 放行，viewer 不由 Provider 推断；合法资源的空 category 只进入原始审计。

Persona 按 Core canonical v1 复核。公共 SDK 的 fetch 接缝在 JSON 数字被转换为 JS number 前保留原始数字表示，再按 Unicode code point 排序重建 canonical 内容；这样可区分 Python 的 `1.0`、`-0.0`、指数格式。传递至宿主的 `sourceCanonicalJson` 必须与结构化三层内容一致，且 hash 匹配；不安全整数拒绝。独立 Python 生成的 Fixture 验证跨语言数字与 Unicode。

Core 初始人格有唯一固定历史表示：core 为 `{"language":"und","name_placeholder":true}` 的字符串，traits 为 `[]` 字符串，narrative 为空字符串；公共 API 将后两者规范化为空对象。适配器仅对这组完全相等的固定内容接受对应历史摘要，不将其变成任意 hash 兜底。

Observe 保留 schema 1 旧记录可读性；生产者必须验证 partial 的 confirmed_range、完整 committed 禁止 proof、stream/cursor 成对以及数字范围。A2 冻结 Stage 真实片段 receipt、事务投影及持久 cursor 后才能宣称输出回写完成。

## 未关闭的边界

A2 输入归属与持久队列的后续实现见 ADR 0010；实际 Stage 确认与游标对账，A3 的持久撤销/删除屏障与四工具，A4 的连续 100 Cycle/崩溃矩阵，以及 Phase 4B 的 MCP/Avatar/Presence，不能由 A0/A1 探针替代。
