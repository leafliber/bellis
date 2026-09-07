# ADR 0013：Memory 隐私版本与回写事务屏障

状态：宿主路径已实施；Core 外部失效、受控工具和完整恢复 Gate 仍待接入。日期：2026-09-06。

## 问题

仅取消进程内 Context 无法保护 DB Worker 中迟到的采用、输入和输出回执。旧 Observe/Usage 也可能在重启后重投。源游标连续性要求进一步限制了抑制策略：不能把未投递的旧事件冒充成已 ACK，然后继续使用同一流。

## 决策

1. Migration 10 保存可信 scope 的隐私版本、单调 generation、读阻断状态、资源 tombstone、变更幂等记录、Session 归属和消息抑制审计。`MemoryPolicyStamp` 是 scope 摘要与 generation；新 Manifest、输入目标、输出目标及 Outbox 绑定此 stamp。旧 schema-1 Manifest 保持可读，摘要不重写；Session 一旦归属某 scope，不能改绑或通过省略 stamp 降级。
2. Runtime 在构建前读取持久策略，并在内存中取消旧 Context 和投递。DB Worker 在采用事务中复核 generation、privacyRevision 与被包含的资源；失败不推进消费水位，也不生成 Usage。输入事实与输出准备同样复核；迟到输出回执返回 `privacy_revoked`。
3. `RuntimeHandle.memory.changePrivacy` 只供可信宿主协调器调用，不进入模型参数或 Stage Control 协议。它先建立本地屏障并发起现有演出打断，再提交持久变更。结果未知时保持阻断；同一变更重试保留首次的预期 generation，即使期间读到了较新策略也不生成第二个变更。
4. tombstone 按 Provider 与规范资源引用匹配。有限 revision 只排除该版本及更早版本；永久删除不能被后续较低版本“解除”。匹配每条来源引用自身的版本，避免新派生候选携带已失效的旧来源。Iris 映射始终保留候选自己的规范资源引用，并保留来源引用。
5. scope 的 generation 变化保守抑制该 scope 所有未完成 Memory 投递并关闭旧输出许可。消息正文、事件身份和确认事实保留；抑制审计记录变更版本以及当时是否已在途。`dead/privacy_revoked` 不等同于 delivered，Core 已接收的消息不能靠本地取消撤回。当前读路径只读取当前 generation 的确认历史。
6. 新输入/输出使用新的 source stream，从独立 cursor 1 开始；不跳过旧流中的缺口。generation 0 的输出流名保持现有兼容。被抑制行释放待投递容量，但保留的历史仍占磁盘，不能据此宣称完整磁盘配额通过。
7. 每个 scope 最多 4096 个 tombstone，最多 64 个 scope。永久屏障不以 TTL/LRU 淘汰。修改 publicLabels 等读取授权仍通过可信 Runtime 配置；启动时配置 privacyRevision 与持久值不同会拒绝就绪，不悄悄恢复旧授权。

## 验证与边界

事务集成测试覆盖旧 generation 采用回滚、缺失 stamp、永久删除单调性、输入流轮换、迟到输出、已在途投递抑制、旧 ACK 拒绝、旧确认历史过滤与重启。宿主单元测试覆盖冻结快照取消、旧 Usage 拒绝、在途调用取消及变更 ACK 丢失重试。浏览器专项在第三个 Cycle 的第一片段实际输出后发起可信隐私中断，等待 Scene 释放并检查后半段没有观察事实。

这些路径不替代 Core 的真实删除。下一步必须由 Iris 四工具和公共外部失效事件调用此协调器，并冻结其业务参数与结果未知恢复规则。通用 Core `revision.invalidated` 目前仍走 Persona 失效，尚未完整映射成资源 tombstone；真实删除/Legal Hold/凭据收紧矩阵、旧快照恢复、未采用 Signal/Tool Result 的完整作用域恢复，以及变更/抑制历史的磁盘上限仍未关闭。A4 的 100 Cycle、每窗口至少 20 次崩溃和 Phase 4B 继续保留。
