# ADR 0035：实际 Recall 请求的持久准备记录

状态：原请求持久化、清单接入及真实安装验证已完成；全量重验与解除未完成。日期：2026-09-07。

ADR 0034 的公开批量核验要求完整原 Recall 请求。Manifest 保存摘要及返回集合，无法从中恢复原 topic、actors、过滤条件和预算，因此不能伪造核验输入。新增可信 `MemoryProviderContext.recordRecallRequest` 回调和 Bellis Migration 19，以发送尝试为单位保存实际准备的请求正文。

Iris Adapter 生成独立 attemptId，将 requestId、agent/space 及完整 SDK body 传给宿主，等待 DB Worker ACK，再将同一份正文交给 SDK。保存失败、取消、断档或资源失效发生在等待期间时不继续发送。每次真实尝试可以保存自己的 deadline；相同 requestId 的不同尝试不相互覆盖。记录证明准备已持久化，不证明 Core 收到请求或模型使用了响应。Bearer token 和传输凭据不进入正文记录。

宿主按配置绑定 provider、Session 和 policy scope/generation；Worker 在同一事务中检查已绑定的 Session、当前策略及新工作磁盘准入。attemptId 重复且完整输入一致可去重；不同正文或归属复用该 ID 拒绝。新表保存完整输入及 SHA-256，单项最多 64 KiB、全表最多 4096 项/64 MiB，超限拒绝新增，不驱逐可能仍被历史事实引用的旧记录。这些是当前有界处理限制，长期保留和增长策略仍需验收。

原请求作为 `recall_request` 加入 ADR 0031 的范围清单，按 scope/provider 隔离；清单摘要和读取时的完整性检查覆盖实际正文。多余的未发送准备记录也保留为待核对事实，不能把准备数量当作成功 HTTP 数。该回调对独立 Adapter 是可选宿主能力；正式 Phase4MemoryHost 总会提供它，缺失持久端口则拒绝该次 Iris 请求。

恢复验证必须从 DB Worker 清单读取原正文，并同捕获的真实 SDK HTTP body 比较，再发送给 Core 批量核验；不得从测试变量重新构造“等价”原请求。即使该项返回 valid，缺口仍保持。逐项结论持久化、全部事实覆盖、跨批次一致性和原子安全解除继续实施。

验证：根检查通过 1043 项单元/性质测试、256 项集成测试，164 个生成契约无漂移；独立 Provider 92 项及类型、lint、格式、构建通过。最终构建在 Core Schema 20 的精确 wheel 上通过实际 HTTP 正文比较与公开核验、Chromium、删除/纠正/检查点回归；工具及 24 组恢复冒烟通过，完整恢复入口仍退出 2。见 [本轮证据](../../../evidence/phase4-original-recall-probe.json)。
