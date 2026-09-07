# Phase 4 实施历史（归档）

> 归档于 2026-09-07。此处保存当时的切片进度、命令和判定，不再追加；“本次”“当前”“提交后停止”均为历史语境。现行事实见 [当前实施状态](../../phase-4-implementation-status.md)。


状态：用户指定的 Phase 4A 范围冻结收尾已完成验证；两项命令均退出 0，提交后停止，不自动开始新切片。

## 当前有效的恢复验收范围

[ADR 0047](../../adr/0047-phase4a-recovery-scope-freeze.md) 显式冻结 Phase 4A 恢复 Gate 为 8 个窗口 × 3 个目标 × 20 次，冻结时已通过 480/480：Cycle/Usage 180、Observe HTTP 180、SSE 120。顶层 status 改为依据次数和实际/预期用例总数计算。原 remaining 与「仍需完成」条目整体移入 [Phase 4B 待办](../../phase-4b-backlog.md)；扩展的恢复、Stage、容量、cursor 场景不再列作 Phase 4A 恢复通过条件。

本次先以 `08bb567` 保存全部工作树 WIP，再修改判定与文档。收尾已运行一次完整根检查和冻结的 480 例恢复命令：`pnpm check` 退出 0（1054 项单元/性质、275 项集成、168 个生成契约），`pnpm test:memory:iris:recovery` 退出 0（24 组合各 20 次，480/480，`covered-windows-passed`）。见 [本次结果](../../evidence/phase4a-recovery-scope-freeze.json) 和 [原始恢复报告摘要](../../evidence/phase4a-frozen-recovery-summary.json)。全部收尾改动提交后停止。

以下保留冻结前的实施历史和原始证据。其中“完整恢复入口 incomplete/退出 2”及扩展恢复待办属于当时的判定和范围，当前均以 ADR 0047 和上面的冻结范围为准，不构成新的 Phase 4A 前置条件。

实施起点：Bellis `893ab9e635186cddb97eba0f43787f08f118926e`，工作树干净。Iris 起点 HEAD `692de12b4b9a9d8d47ebfdd938ba9622d152f0d9`，已有大量上游未提交收尾修改；累计对 Iris 增量补充可信 CLI 的 actor 身份 ID 输出、原子搜索初始化选项、应用 SSE 读取能力及对应测试/安装说明，保留其他上游改动。实际安装物以 [探针摘要](../../evidence/phase4-iris-probe.json) 的 SHA-256 为准。

## 已实现与验证

- A0：Provider mapping 2、来源摘要与数字安全检查、Observe proof/actor 字段、HTTP 错误分类、Persona canonical/历史 bootstrap 兼容。Core wheel 隔离安装、可信 CLI 初始化，业务仅用公共 SDK/HTTP。成功响应在 SDK 解析前限流，Observe 批次与 ACK 完整性校验已补齐。
- A1 首条纵向：启动期 Persona、可取消 Context Port、公开隐私过滤/预算、Manifest 双 Schema、Migration 6、adoption 内 Usage Outbox、按 Session/Cycle 读取原 Manifest。真实 Decision Host/DB Worker 接收 Recall、发送模型请求，采用后 Usage 获得 Core ACK。
- A2 输入侧：可信输入映射独立提供身份与隐私标签，Migration 7 在 Signal 接纳事务内分配独立游标并写 Observe 账本/Outbox；同流有序 Claim、逐项 ACK 与重启重发。重新安装的 Core wheel 与 151 个安装文件逐一比对，真实可信 user 输入获 Core ACK，相同事件重发成功。
- A2 输出实现：冻结语义片段、逐段 PCM 样本绑定、Worklet 源样本计数、字幕应用回执；Migration 8 同事务写确认/Observe/独立游标，Context 从已确认片段构建。活动 Scene 预留容量，终态等待最终绑定清单及持久 ACK 后释放，不再按两秒窗口丢弃迟到绑定。配置需显式 `observeOutput.privacyLabels` 才向 Memory 投影。
- `demo:phase4:iris` 已接通并验证真实 Chromium → Runtime/DB Worker → Iris Provider/已安装 SDK → Core API/Worker：三个 Cycle、四条实际输出、三次 Usage ACK，Core 独立源游标为 4；取消的后半段没有产生观察。首次循环另有真实 Recall/Persona 和可信输入。此短闭环不代表 A4 长时/崩溃矩阵通过。
- A3 人格切片：Migration 9 与宿主 Provider 状态端口，按可信范围隔离并以预期版本写入；默认 Iris 装配已使用 DB Worker。人格失效/撤销和授权失败保留持久读屏障，刷新失败不推进事件游标；迟到刷新、同版本摘要变化及被撤销/替代版本不能恢复。后台重验覆盖缺少事件能力的瞬时 state 更新。Iris 网络与宿主投递在取消后保留真实在途名额。独立 Provider 当前 80 项测试通过。
- A3 宿主隐私切片：Migration 10、策略 stamp/资源 tombstone、Session 归属、采用/输入/输出事务复核、旧 Observe/Usage 抑制审计与确认历史过滤；新 generation 使用独立源流。可信 `RuntimeHandle.memory.changePrivacy` 取消旧 Context/投递并打断演出，结果未知的重试保持原始变更身份。真实 Chromium/Core 验证在第三个 Cycle 播放中推进隐私 generation 到 1，后半段没有回写。Core 的单目标实际删除现已接到 Forget 协调事务；外部删除事件接入见下条。
- A3 外部删除失效：Migration 15 原子保存事件摘要、generation 与 tombstone；Provider 先持久保存待处理事件，宿主取消旧 Context/投递并确认停止演出，随后才提交游标。ACK 丢失、事务回滚、重启恢复和迟到 Recall 已验证。新的 Core 0.13 独立安装补齐 CLI 应用凭据的 `events.sse.v1`；真实外部 Forget → Core Worker/SSE → MemoryHost 永久 tombstone 与游标重启恢复通过。见 [ADR 0022](../../adr/0022-phase4-resource-invalidations.md) 和 [证据](../../evidence/phase4-resource-invalidation-probe.json)。
- A3 工具恢复基础：Migration 11 随 adoption 保存原始调用与原幂等键，逐项读取复核身份/摘要/字节数；修改参数、键或工具集合的重放拒绝，正文不进入审计。真实 DB Worker 重启后保留原调用并将 running 标为 uncertain，不自动执行。
- A3 实际请求：Migration 12 与可信准备端口保存注入后的请求、业务键、确认描述和策略/资源版本，关联已采用的原调用；换参数/键拒绝。保存 ACK 前不确认，批准后事务复核策略及能力，恢复加载原请求而不重新解析。真实宿主/DB Worker 与安装 Core 的 remember 夹具已验证保存→确认→写入→丢响应→重启读取→原键对账；生产四工具授权及隐私协调尚未装配。
- A3 四工具注册：`registerIrisTools` 注册封闭参数、可信字段注入、稳定业务键、授权复核、Forget 屏障与结果过滤端口；`RuntimeOptions.tools` 接入显式能力和确认，启动失败清理宿主/DB Worker。57 项 Provider 测试覆盖 SDK 四路径和 Schema 14–15 窗口；真实 Core remember 已改用注册适配器和 MemoryHost 策略。生产目标授权规则和四工具完整宿主 Gate 仍开放；Forget 事务增量见下条。
- A3 Forget 协调：Migration 13 原子保存读屏障与操作归属，完成时原子保存回执/tombstone；未知结果保持 blocked，保留对象保持 retained，旧完成不能解除更新的隐私屏障。MemoryHost 接入本地取消/演出中断与 ACK 丢失重试。真实注册适配器→Core 删除已通过一次确认/一次写入、HTTP 前持久屏障、generation 2、永久 tombstone 和重启恢复；真实 Legal Hold/保护对象及崩溃矩阵仍未通过。
- A3 待消费输入隐私：Migration 14 随 Signal 接纳保存可信策略版本，重复输入不重标记；模型请求前按持久来源过滤旧/未知 Signal 与 Tool Result，保留 unknown 写结果警示。完整当前批次保留聚类和权重，混合旧版本或水位缺口不授权聚合内容。过滤先于 actors/Recall，并在 Manifest 留下无正文排除记录；真实宿主恢复/跨版本工具结果与容量/取消测试通过。见 [ADR 0021](../../adr/0021-phase4-local-input-privacy.md) 和 [专项证据](../../evidence/phase4-local-input-privacy-probe.json)。
- A3 写目标核验：correct/forget 经公共 getClaim 核对可信主体、当前范围、revision 和隐私标签，将目标内容纳入持久确认；批准后重读并再次复核宿主权限。确认期间目标变化即拒绝写入。真实注册 Forget 验证两次读取、一次确认/写入及屏障顺序；Core Forget 不支持 expected_revision，两次读取不是跨写者的原子条件删除。见 [ADR 0020](../../adr/0020-phase4-iris-tool-target-verification.md) 与 [目标核验证据](../../evidence/phase4-tool-target-probe.json)。
- A3 Session 所有权：未使用的占位宿主绑定真实 Session 后重新恢复管道；Turn 捕获可信 Session，工具运行记录沿用该身份。已有输入（包括尚在 append 中）或恢复事实时拒绝跨 Session 改绑。真实宿主测试覆盖恢复目标 Session 的未消费输入并执行工具，同 Session 重连继续允许。
- A3 工具公共传输：独立 `IrisToolBoundary` 经安装 SDK 的四个公开方法传递冻结参数/原键/Lease/revision，并补实际 HTTP 取消、正文上限、稳定错误与未知写结果。Tool Runtime 将已启动写操作的丢响应/超时/取消保留为 uncertain，下一 Cycle 提示对账；真实宿主/DB Worker 验证只执行一次并保留原调用。
- `test:memory:iris:tools` 在新 Core 0.13/schema 15 独立 wheel 上已通过公共接口专项、退出 0：可信 CLI 初始化已验证 FTS generation，remember 后搜索命中，correct 修订冲突明确，协调 Forget 后搜索消失/getClaim 404。旧 0.12 安装仍保留 incomplete/退出 2；四工具生产授权、Legal Hold 和完整宿主恢复 Gate 并未全部通过。
- A3 确认边界：具体参数/可信执行身份/工具版本与请求摘要进入 ConfirmationPort；取消与单调 Deadline 覆盖确认等待，期限不在批准后重置。失控 Port 保留单个在途名额，迟到批准不执行；声明和调用深冻结，批准后复核能力，确认型调用不通过 L0 共享跳过确认。真实宿主/DB Worker 验证审批参数已持久化且 Session 关闭后没有写入。准备型调用的确认摘要另绑定整个可信实际请求。
- 事务测试证明 digest/血缘/Outbox 失败整体回滚；重启读取原 Manifest。Persistence 集成 109 项通过，包括旧隐私版本拒绝、迟到效果抑制、原流不伪造 ACK、独立新流、永久 tombstone 单调性、实际请求恢复和变更拒绝。
- 资源失效切片的根 `pnpm check` 通过，Contracts 305 项、Runtime 单元 131 项、Stage 单元 66 项通过；当时共 1018 项单元/性质测试与 229 项集成测试，160 个生成契约文件无漂移。修复既有 Outbox 幂等测试对首次交付时序的错误假设，继续核对最终一次交付及原 trace。Phase 1、2、2 crash、3 Demo 基线此前已复验。
- Core 0.13 兼容：新旧 wheel 的应用契约差异只有包版本/Schema；0.13 安装逐项核对 156 个文件，SDK 保持 0.11.1。新版本真实 Chromium/Core 回归通过三个 Cycle、四条输出、三次 Usage 和隐私 generation 1。搜索初始化切片当时的 Core 源码 11,032 项测试通过、覆盖率 84.49%，初始化专项 9 项及类型/公共契约检查通过。未原地升级用户数据。
- 修复既有 Audio Arm 过早公开就绪的问题：Worklet 加载完成后再允许准备，避免初始媒体帧丢失及并发创建节点。全部 Chromium 三用例此前通过，欠载 0，既有同步样本最大偏差 3.13ms、打断 3.20ms；不代表物理扬声器或 P99 验收。本切片另复验真实 Core 联合浏览器路径。

- A4 连续纵向：新增 `test:memory:iris:continuous`，同一真实 Runtime/DB Worker、Core API/Worker 和 Chromium 会话运行 100 个 Cycle。逐轮读取持久 Manifest，对照实际模型请求、Recall 来源/Persona 版本与 Core Usage ACK 三集合；100/100 均通过。101 条实际输出的 Core 源游标为 101，最大输入估算 6,857／16,000，末轮隐私中断通过。双进程崩溃、总磁盘配额和长时资源增长仍未通过。见 [运行说明](../../phase-4-continuous-validation.md) 与 [证据](../../evidence/phase4-continuous-probe.json)。

- A4 SSE 崩溃窗口：新增 `test:memory:iris:recovery`，已通过 pending 失效落盘/宿主 ACK 前及策略提交/游标推进前两个窗口，分别 SIGKILL 真实 Runtime、Core API、Core Worker，每组合 20 次，共 120 次。重启继续原事件，永久 tombstone、游标与原删除回执一致，已提交策略不重复推进 generation。完整恢复 Gate 仍报告 incomplete/退出 2；新增采用/Observe/ACK 窗口见后续条目；旧快照、容量及 Stage 窗口仍待完成。见 [恢复说明](../../phase-4-recovery-validation.md) 与 [证据](../../evidence/phase4-recovery-probe.json)。

- A4 采用/Usage 崩溃窗口：真实 Signal Pipeline/Loop 在 Manifest 形成/adoption 前、adoption 提交/Usage ACK 前、Usage ACK/宿主 delivered 前停留；分别终止 Runtime、Core API、Core Worker，各 20 次，新增 180 次通过，同轮 SSE 120 次回归通过。已采用 Runtime 重启保持原 Manifest 且模型请求为 0；采用前原候选缺席，未消费输入以新 Cycle 恢复。原键 Usage 重投与 Core 自然去重指向同一 report ID。完整恢复 Gate 仍为 incomplete/退出 2；见 [恢复说明](../../phase-4-recovery-validation.md) 和 [300 次证据](../../evidence/phase4-cycle-recovery-probe.json)。

- A4 Observation HTTP 窗口：真实输入/Outbox 经固定目的地址的 loopback 代理，在 Core 发布前、Core 已提交但 HTTP ACK 未转发、SDK 已确认但宿主未结算三个边界分别终止 Runtime/API/Worker，各 20 次。新增 180 次及原有 300 次回归均通过，共 480 次。原正文/批次键重投保持 180 个 Canonical ID，记录级重报新增事实与投影任务为 0，两端源游标及宿主 delivered 均为 1。完整恢复 Gate 仍为 incomplete；见 [恢复说明](../../phase-4-recovery-validation.md) 与 [本轮证据](../../evidence/phase4-observe-recovery-probe.json)。

- A3 显式作用域：宿主要求明确接受 space 跨 Session 语义，拒绝未核验的 Core Session/group；Provider 启动前事务性保存本地 Session 归属，重启改配置失败整体回滚。输出目标使用配置快照，旧 Outbox 不兼容目标拒绝发送且不重写。Core Session 映射仍未完成，见 [ADR 0023](../../adr/0023-phase4-explicit-memory-scope.md)。

## 当前验收边界

真实探针 `pnpm test:memory:iris` 需要 `IRIS_CORE_PYTHON` 指向临时、非 editable 的 wheel 安装。缺环境退出 2 并报告 NOT RUN，不能把 skip 计为通过。可设置 `IRIS_PROBE_REPORT` 保存脱敏摘要。

`test:memory:iris` 保留原公共契约/可信输入探针；其中合成的 partial 数据不能充当 Stage 证明。`demo:phase4:iris` 额外运行同一次真实 Stage→Core 联合路径，并用公共 source cursor 独立核对实际输出。见 [联合验收记录](../../evidence/phase4-stage-core-probe.json) 和 [输出验收记录](../../evidence/phase4-output-probe.json)。模型与 TTS 仍为确定性测试边界，不宣称物理扬声器或完整 A4 性能验收。

人格状态切片的测试、容量边界与源码摘要见 [人格状态证据](../../evidence/phase4-persona-state-probe.json)。故障注入覆盖人格失效；当前真实服务证据证明新存储装配与既有闭环兼容，真实人格发布/撤销及通用隐私恢复矩阵尚未完成。

宿主隐私事务、真实播放中断和恢复抑制见 [隐私事务证据](../../evidence/phase4-memory-policy-probe.json)。本轮磁盘耗尽曾使两次验证无法启动；清理已确认无进程使用的旧 pytest 临时数据后，完整检查和真实服务专项重跑通过，未将环境失败计为通过。

原始调用与 Session 恢复基础见 [工具基础证据](../../evidence/phase4-tool-foundation-probe.json)；本轮另通过 [真实 Stage/Core 回归](../../evidence/phase4-tool-foundation-stage-core-probe.json)，仍为三个 Cycle、四次 Observe、三次 Usage 和隐私 generation 1，不能替代工具写入或 A4 验收。

工具公共传输与未知结果见 [工具边界证据](../../evidence/phase4-tool-boundary-probe.json) 和 [真实 Core 未完成报告](../../evidence/phase4-tools-core-probe.json)。后者记录 `fts_rebuild_pending` 和间歇 `internal_error`，退出 2；未将四工具 Gate 标为通过。

具体确认及取消证据见 [确认边界证据](../../evidence/phase4-confirmation-probe.json)。

实际请求的持久化、确认与恢复见 [实际请求专项](../../evidence/phase4-prepared-tools-probe.json) 和 [真实 Core 报告](../../evidence/phase4-prepared-tools-core-probe.json)。remember 已通过真实宿主确认后写入，重启后使用保存的原请求对账；该历史 0.12 报告的搜索返回 `fts_rebuild_pending`/`internal_error`，当时入口为 incomplete/退出 2；新 0.13 结果见下文。

注册适配器、应用生命周期及真实 Core 证据见 [工具注册专项](../../evidence/phase4-tool-registration-probe.json) 和 [注册适配器 Core 报告](../../evidence/phase4-tool-registration-core-probe.json)。

Forget 协调事务、保留计数与真实删除证据见 [Forget 专项](../../evidence/phase4-forget-coordinator-probe.json) 和 [真实 Core 报告](../../evidence/phase4-forget-coordinator-core-probe.json)。

新 Core 0.13 的公开搜索、双版本安装和 Stage 回归见 [搜索专项](../../evidence/phase4-core13-search-probe.json)。上文旧报告的未就绪状态属于历史安装，不能改写为新版的通过证据。

后续继续 A3 → A4 和 Phase 4B：Iris 四工具生产授权、事件历史缺口全量重验及普通纠正通知、真实 Legal Hold/保护对象/人格撤销、可信输入/证据授权与 Core Session 映射、其余窗口各 20 次崩溃验收及长时资源增长验证、总磁盘配额、MCP、Presence/Avatar 与完整 `demo:phase4` 尚未交付。

边界与兼容决定见 [ADR 0009](../../adr/0009-phase4-context-adoption.md)、[ADR 0010](../../adr/0010-phase4-input-observation-ledger.md)、[ADR 0011](../../adr/0011-phase4-output-segment-confirmation.md)、[ADR 0012](../../adr/0012-phase4-provider-state-and-persona-barriers.md)、[ADR 0013](../../adr/0013-phase4-memory-policy-transactions.md) 、[ADR 0014](../../adr/0014-phase4-original-tool-calls-and-session-ownership.md)、[ADR 0015](../../adr/0015-phase4-iris-tool-transport-outcomes.md) 、[ADR 0016](../../adr/0016-phase4-prepared-tool-requests.md) 、[ADR 0017](../../adr/0017-phase4-iris-tool-registration.md) 、[ADR 0018](../../adr/0018-phase4-forget-coordination.md) 和 [ADR 0019](../../adr/0019-phase4-core13-search-initialization.md)。

本地 Signal/Tool Result 策略版本过滤及最终联合 Core/Stage 回归见 [ADR 0021](../../adr/0021-phase4-local-input-privacy.md)。资源失效切片当时的根检查为上述 1018/229 项，历史证据文件中的早期计数保持原样。

最新事件能力安装的 wheel SHA、159 个安装文件、公共工具与 Chromium 联合回归见 [真实报告](../../evidence/phase4-resource-invalidation-core-probe.json)。它包含 Iris 工作树其他增量；包内应用契约未变化，Console OpenAPI 有变化。当前 Core 全量回归为 11,114 通过、4 失败、54 错误，覆盖率 83.29%；4 项失败均为 Console 上传描述与生成 Schema 不匹配，54 项错误为沙箱阻止 Mock Server 监听端口，不能沿用历史 11,032 项通过结果作为本次全量通过证明。

上述 54 项 Mock Server 环境错误在获得本地端口权限后单独重跑，54 项全部通过；4 项 Console 契约失败仍保留，不将分次结果合并为一次全量通过。

显式 Space scope 的最终根检查通过 1033 项单元/性质测试、230 项集成测试，Runtime 单元 146 项，160 个生成契约无漂移，Provider 80 项通过。真实 Core 工具/SSE/Chromium 联合回归退出 0；24 个恢复组合各一次冒烟全部通过，恢复入口仍按未完成 Gate 退出 2。本地 Session 绑定不是远端 Session 映射，见 [本轮证据](../../evidence/phase4-explicit-scope-probe.json)。

A4 磁盘准入新增实际 DB/WAL/SHM/锁文件占用与文件系统剩余空间检查；新 Signal/采用/效果准备/Scene commit 在事务内拒绝高水位准入，已有确认、去重与恢复读取保留。Runtime ready 端点反映磁盘状态，Context 预检查受取消和剩余预算约束。整体硬上限及最坏确认预留仍未证明，见 [ADR 0024](./decisions/0024-phase4-disk-admission.md) 和 [本轮证据](../../evidence/phase4-disk-admission-probe.json)。

磁盘准入切片的最终根检查通过 1035 项单元/性质测试、232 项集成测试，160 个生成契约无漂移；Provider 80 项及类型检查通过。真实 Core 工具/SSE/Chromium 退出 0，24 次恢复冒烟通过但完整恢复入口保持退出 2。实际宿主数据库相关文件共 951800 字节，其中 WAL 865264 字节；完整硬配额及最坏预留不在通过范围内。

A4 数据库硬限制新增 state/telemetry 的实际 SQLite 页上限，覆盖所有经过 Worker 连接的后台写入。空间耗尽自动回滚与 SAVEPOINT 清理已修复；原状态/revision、成功审计记录与重启限制得到验证，第二个数据库打开失败后也释放全部锁。WAL 总量与确认专用预留仍开放，见 [ADR 0025](./decisions/0025-phase4-database-page-limits.md) 及 [本轮证据](../../evidence/phase4-database-capacity-probe.json)。

数据库页限制切片通过根检查 1035 项单元/性质测试、234 项集成测试，160 个生成契约无漂移；Provider 80 项与类型检查通过。真实 Core/Chromium 联合回归退出 0，24 次恢复冒烟通过、完整恢复 Gate 仍退出 2。公开宿主探针读回 state 1 GiB、telemetry 64 MiB 的实际页上限；不宣称已完成 WAL 总量或确认专用预留。

A4 WAL 增量：实际 WAL 达阈值且检查点被旧快照阻塞时，数据库适配层停止后续实际写事务，覆盖后台写入、缓存语句、CTE/RETURNING 与 exec。已提交状态仍可读取，释放快照后检查点和 ready 自行恢复；两个数据库及公共 Provider 接口通过真实持有快照测试。见 [ADR 0026](./decisions/0026-phase4-wal-write-fence.md) 和 [证据](../../evidence/phase4-wal-fence-probe.json)。

WAL 拦截切片通过根检查 1035 项单元/性质测试、237 项集成测试，160 个生成契约无漂移；独立 Provider 80 项及类型检查通过。真实 Core 工具/SSE/Chromium 联合回归退出 0，24 次恢复冒烟通过，完整恢复入口仍退出 2。单个事务超调、目录硬上限和确认专用物理预留尚未证明，Phase 4 继续保持进行中。

A4 单事务容量：Worker 为两个 SQLite 连接关闭并锁定 cache spill，接入原生 progress/commit hook，以连接级 pager cache 预算约束提交。重复改写约 100 MB 逻辑数据在提交前不扩大 WAL；超预算自动提交、显式事务、SAVEPOINT 与 RETURNING 均回滚，执行中断也保留原事实。独立连接预算、恢复后重新应用和设置不可被仓库 SQL 改写已验证。见 [ADR 0027](./decisions/0027-phase4-transaction-capacity.md) 与 [证据](../../evidence/phase4-transaction-capacity-probe.json)。

本切片根检查通过 1035 项单元/性质测试、240 项集成测试，160 个生成契约无漂移；随后补充的 progress/RETURNING 断言通过专项测试和类型检查。独立 Provider 80 项与类型检查通过；真实 Core 工具/SSE/Chromium 退出 0，24 次恢复冒烟通过，完整恢复 Gate 保持退出 2。默认预算下公开读取的每库 WAL 边界为 75616288 字节。新增 C 编译步骤在本地 macOS/arm64 通过，Windows MSVC CI 配置已补但远端结果未验证。确认专用预留和整个目录配额仍开放，Phase 4 仍为进行中。

A4 活动演出收尾额度：Migration 16 与准备记录一起保存每个 Scene 的绑定、确认和关闭额度；普通 state/telemetry 写入保留剩余额度所需的页、WAL、索引及文件系统空间。经过原校验的收尾操作使用独立原生预算，事实和扣减同事务提交，重复调用不扣额度，重启释放未用额度并保留已确认事实。四个最大音频计划、每计划 32 个片段和八个大目标在 WAL 压力下完成 1024 个 Observe 投影；接近页上限与 64 KiB 页数据库也已验证。见 [ADR 0028](./decisions/0028-phase4-completion-reservations.md) 和 [本轮证据](../../evidence/phase4-completion-reserve-probe.json)。

收尾额度切片最终根检查通过 1035 项单元/性质测试、245 项集成测试，160 个生成契约无漂移；独立 Provider 80 项、类型检查和构建通过。两个本地确认事务窗口各 20 次真实 SIGKILL 共 40 次通过，提交前没有残留观察，提交后丢 ACK 以原回执去重恢复。最后的原生 ABI 2 构建通过真实 Core 工具/SSE/Chromium 回归和既有 24 次恢复冒烟；完整恢复入口保持退出 2。此处额度是 Worker 预算，不是操作系统独占预分配，真实 ENOSPC、目录硬配额、外部读者跨重启及完整 Stage/Core 矩阵仍开放。新 40 次不与历史不同版本的 480 次合并为本版本完整验收，Phase 4 继续进行。

收尾恢复修复：独立只读快照跨两次 Worker 重启持续阻塞 WAL 检查点时，恢复逐个使用四个旧 Scene 的原关闭额度，保留原确认及 Outbox；没有恢复写入时只读启动，ready 仍拒绝新准入。真实 in-flight Lease 无普通写入容量时明确拒绝 migrate，释放外部快照后同一 Client 可重试。隐私策略关闭也在同事务释放收尾额度，避免关闭记录长期占用活动额度。见 [恢复压力证据](../../evidence/phase4-completion-restart-pressure-probe.json)。

本轮根检查通过 1035 项单元/性质测试、247 项集成测试，160 个生成契约无漂移；40 次本地确认 SIGKILL 再验证通过。最终构建的真实 Core 工具/SSE/Chromium 退出 0，24 次原恢复组合冒烟通过，完整恢复入口继续退出 2。新增两项为外部读者持续存活时的 Worker 重启测试，不算新增 SIGKILL 窗口；操作系统耗尽、目录硬配额、旧备份和完整 Stage/Core 组合仍待完成。

A3 历史缺口的公开前置契约：Core 新增 `events.checkpoint.v1`，以原游标与事件身份共同校验恢复位置；不一致或当前不可见时在 SSE 响应前返回 410 `history_unavailable`，权限过滤造成的跨号可继续。TypeScript SDK 源码增加 `afterEventId`，并更新生成 OpenAPI 与经审查的公开清单。Core 专项 114 项、SDK 19 项，以及类型、lint、生成契约和兼容检查通过。未更换默认 Provider 的已安装 SDK/wheel，未将源码测试记作 Bellis 历史缺口恢复完成；持久身份、屏障及全量重验继续推进。见 [ADR 0029](./decisions/0029-phase4-event-checkpoint-identity.md) 和 [契约证据](../../evidence/phase4-event-checkpoint-contract-probe.json)。

A3 事件身份持久化：Provider 将事件身份与游标一起保存，写入失败时同时恢复旧字段并按原游标重试，旧状态不伪造身份。82 项 Provider 测试及类型、lint、格式、构建通过。隔离安装的 SDK 0.11.2 候选已通过真实 Core 校验头验证；默认 Provider 依赖仍为 0.11.1，本地 registry 发布被自动审批拒绝，等待明确授权。

本轮候选 Core 源码包含 Schema 16–18，初次探针因版本不符正确停止；核对三项 Migration 并通过相关 32 项测试后，仅按精确 wheel SHA 接纳 Schema 18 候选。168 个安装文件核验通过，新旧应用 API 仅事件接口变化，组件定义一致。候选真实 Chromium/删除 SSE/原身份校验退出 0，工具通过，既有 24 次恢复冒烟通过、完整恢复入口仍退出 2。默认 Provider 版本范围未放宽，正式校验请求、历史缺口屏障、全量重验及旧备份恢复仍待完成。见 [身份与候选证据](../../evidence/phase4-event-identity-probe.json)。

A3 宿主历史缺口屏障：Migration 17 按 scope/provider 持久化缺口，可信生命周期回调先取消旧 Context 和交付，等待持久化与效果停止后才 ACK。失败保留内存屏障；重启及普通策略修改均不能解除未重验缺口。受影响 Memory Outbox 暂停领取，在途失败退回 pending 并保留原正文、身份与尝试次数。已核验的实际效果仍原子记录确认及待投递 Observe；真实隐私撤销、策略代际与 tombstone 校验保持生效。见 [ADR 0030](./decisions/0030-phase4-history-gap-barrier.md) 与 [本轮证据](../../evidence/phase4-history-barrier-probe.json)。

本轮根检查通过 1040 项单元/性质测试、250 项集成测试，162 个生成契约无漂移；独立 Provider 82 项、类型检查及构建通过。候选安装的真实 Core 工具/SSE/事件身份校验/Chromium 退出 0，既有 24 次恢复冒烟通过，完整恢复入口保持退出 2。Provider 自动缺口报告、正式成对校验请求、全量重验及安全解除尚未完成。默认 SDK 仍为 0.11.1，0.11.2 的本地 registry 发布仍待此前请求的明确授权；自动审批拒绝原因为发布目标未获明确授权。Phase 4 总目标继续进行。

A3 Provider 历史缺口报告：事件请求的明确 410 `history_unavailable` 会保留原检查点、建立稳定 gapId 并同时尝试状态保存与宿主屏障通知；任一侧失败只重试同一缺口，不继续请求 SSE。支持检查点校验的 Core 遇到缺少事件身份的旧正游标时，在 Persona/SSE 前报告 `checkpoint_missing`。宿主 ACK 后缺口仍保留，重启继续暂停 Recall、Persona 缓存/静态兜底、Observe、Usage 和旧投递；并发 Persona 基线保存也不能返回失效旧值。

本轮 Provider 89 项测试以及类型、lint、格式和构建通过。隔离安装 SDK 候选触发真实 Core 410，生产 Provider 错误处理接入 MemoryHost/DB Worker，验证旧 Context 取消、原 Usage 完整保留以及重启后继续报告缺口；最终构建的真实 Chromium/删除 SSE 回归通过。工具及 24 组既有恢复冒烟通过，完整恢复入口继续退出 2。宿主源码未改，1040/250 项根检查沿用上一轮基线，没有算作本轮重跑。见 [接入证据](../../evidence/phase4-provider-history-gap-probe.json)。

此次分歧由可信测试端预置旧事件身份，尚未证明实际旧 Core 备份恢复。默认 Provider SDK 仍为 0.11.1，正式成对检查点请求待此前发布授权及依赖升级；全量公开重验与安全解除、普通修正事件、容量和完整 Stage/Core 矩阵、Phase4B 与全量 demo 仍未完成，Phase 4 继续进行。

A3 全量重验的持久范围：Bellis Migration 18 固定 scope/provider 的重验 run，绑定原 gapId、策略代际和有序身份摘要。范围包含 Manifest、实际效果、Observation/原 Outbox/ACK、Usage 以及宿主保存的 Provider 状态；分页和逐项正文读取均重验当前集合。迟到确认、ACK、Provider 状态或策略变化会使旧清单失效；替换失败保留原清单，其他 scope 的事实与交付不受影响。空清单或分页结束均不能解除屏障。见 [ADR 0031](./decisions/0031-phase4-history-revalidation-inventory.md) 和 [清单证据](../../evidence/phase4-history-inventory-probe.json)。

本轮根检查通过 1040 项单元/性质测试、254 项集成测试，162 个生成契约无漂移；随后补充的跨 scope 断言通过四项专项测试及类型检查。独立 Provider 89 项、类型和构建通过。真实 Core 410 → Provider → MemoryHost/DB Worker 创建并恢复三类清单项，原正文摘要一致且屏障保持；真实 Chromium/删除 SSE 回归退出 0，工具通过，24 次恢复冒烟通过，完整恢复入口仍退出 2。

清单当前有界于 4096 项/64 MiB，超限拒绝而不截断；逐页会重新扫描完整有界集合。它只是后续重验的覆盖依据，公开资源/删除/权限核验、远端一致性、逐项结论与安全解除仍待完成，外置 Provider StateStore 与未绑定旧身份也不能由它代为证明。正式 SDK 发布仍待此前明确授权，其余 Phase4A/4B 完整 Gate 保持开放。

A3 Claim 纠正通知：公开 Correct 的 supersede/dispute/retract 及撤回引起的下游 Claim/Relation 级联，在 Canonical 事务中生成各自旧修订的失效事件。范围使用受影响资源自身的身份；事件失败回滚整条修订/证据链，原键重试与成功重放不重复通知。六项新增专项测试及相关回归共 202 项通过，Core 类型和 Ruff 检查通过。见 [ADR 0032](./decisions/0032-phase4-claim-correction-events.md) 与 [本轮证据](../../evidence/phase4-claim-correction-probe.json)。

最终候选为 Core 0.13.0 / Schema 19，170 个安装文件核验通过，探针仅按精确 wheel hash 接纳；相对 Schema 18 的应用 OpenAPI 全文一致。真实 Worker 停止期间，公开 supersede 仍使 Bellis 取消旧 Context 并保存截止修订 1；恢复投影后，修订 2 的新文本实际进入后续 Context，旧修订被排除。删除、检查点、断档屏障/清单、Chromium 联合回归退出 0，公开工具及 24 次既有恢复冒烟通过，完整恢复入口保持退出 2。宿主生产源码未变，本轮没有重跑上一轮 1040/254 项根检查，也没有声明新纠正 SIGKILL 窗口或 Core 全量回归通过。

默认 SDK 0.11.1 与默认 Provider Schema 上限保持现状，候选 0.11.2 的本机 registry 发布仍等待此前明确授权；自动审批拒绝的原因是该发布目标未获明确授权。其他资源普通修改、公开全量重验及安全解除、完整 A4/Phase4B 和全量 demo 仍未完成，Phase 4 总目标继续进行。

A3 Recall 响应有效性：普通原请求重放、首次发布以及另一并发请求抢先发布后的重放，均在其读/写事务中重新执行候选 Canonical 过滤并比较当前 Persona revision/hash。纠正、撤回、过期或 Persona 切换导致失效时返回 409，不删减或覆盖原返回集合；首次发布失败不保存残留请求，已保存请求与 Usage 身份仍可对账。授权历史请求继续使用原 `as_of` 时刻。见 [ADR 0033](./decisions/0033-phase4-recall-replay-revalidation.md) 及 [验证证据](../../evidence/phase4-recall-revalidation-probe.json)。

本轮 Core 相关测试共 227 项通过（含十三项新增），另有两项现有服务级性能测试通过：各 40 次样本的结构化 p95 ≤ 50ms、FTS p95 ≤ 100ms；类型与 Ruff 检查通过。最终 Core 0.13.0 / Schema 19 候选 170 个安装文件核验，应用 OpenAPI 不变。真实 Worker 停止后公开纠正使原 Recall 重放返回 409；原 Usage 重放的 report ID 和四阶段计数一致，新修订可进入新 Context。删除、事件身份、缺口屏障/清单与 Chromium 回归退出 0，公开工具及既有 24 次恢复冒烟通过，完整恢复入口仍退出 2。

本轮未改宿主生产源码，未重跑此前 1040/254 项根检查；性能结果也不替代长期增长或完整宿主时延 Gate。单响应核验尚不提供跨请求固定快照、缺口清单逐项结论或安全解除，其余 A4/Phase4B 仍开放。SDK 本机发布继续等待此前明确授权，默认依赖未升级。

A3 公开原请求批量核验：新增 `recall.revalidate.v1` 与只读 `POST /v1/recall:revalidate`，提供完整原 Recall 请求和本次截止时间，在一个读取快照与评估时刻内核对原指纹、存档候选及 Persona，返回 valid/unavailable，不重放正文或新建 Recall/Usage。未知、错误指纹或失效统一不能证明；重复 ID、能力/scope/截止时间和大小超限拒绝整批。见 [ADR 0034](./decisions/0034-phase4-recall-batch-revalidation.md) 与 [证据](../../evidence/phase4-recall-batch-probe.json)。

本轮 135 项 Core 相关测试通过：Recall/HTTP/公开契约 102 项（含六项新测试），Schema 20 新增 Console 操作迁移及相关回归 33 项；并发纠正和 TTL 推进验证同批快照/时刻一致。类型、Ruff、生成契约、兼容和公开 API 白名单检查通过。最终精确候选为 Core 0.13.0 / Schema 20，178 个安装文件核验；应用 API 仅新增一个操作与两个 Schema。真实 HTTP 原请求 valid、纠正后 unavailable、旧截止时间可重验且不回正文；原 Usage 回执、新 Context、删除、缺口屏障/清单和 Chromium 联合回归退出 0，工具及 24 次既有恢复冒烟通过，完整恢复入口仍退出 2。

批量结论尚未接入宿主生产恢复流程：当前 Manifest 只有摘要，必须先持久保存真实原请求并绑定清单。独立原 Observation/Usage 核对、跨批次一致性、全部范围与安全解除仍待完成；不能用每批 valid 宣告整个历史恢复。默认 SDK/Provider 兼容范围未放宽，SDK 本机发布仍待此前明确授权，其余 Phase4A/4B Gate 保持开放。

A3 实际 Recall 请求存证：Migration 19 接入可信 Provider → Host → DB Worker 回调，保存完整准备正文并等待 ACK 后才发送；保存失败、取消或期间发生失效时停止发送。独立 attemptId 保留同一原请求的多次尝试，原身份重试去重，Session/策略/磁盘与容量检查在事务中执行。该记录证明准备，不证明 Core 已接收。断档清单增加 `recall_request`，真实重启后读取的正文与捕获的 SDK HTTP body 一致，并通过公开批量核验；缺口仍保持。见 [ADR 0035](./decisions/0035-phase4-original-recall-requests.md) 和 [本轮证据](../../evidence/phase4-original-recall-probe.json)。

本轮根检查通过 1043 项单元/性质测试、256 项集成测试，164 个生成契约无漂移；独立 Provider 92 项及类型、lint、格式、构建通过。沿用已核验的 Core Schema 20 精确 wheel，178 个安装文件核对通过；最终 Core/Chromium/删除/纠正/历史缺口回归退出 0，工具及 24 组恢复冒烟通过，完整恢复入口保持退出 2。逐项结论、跨批次一致性、全部事实覆盖与安全解除尚未完成，长期请求保留容量也仍需验收。默认 SDK 0.11.1 保持；候选 0.11.2 发布继续等待此前请求的明确授权。Phase 4 总目标保持进行中。

A3 核验结论持久化：Migration 20 将公开响应的 batchId、清单摘要、评估时间及逐项原请求身份/摘要/结论原子保存。相同批次可在重启后去重；部分插入失败整体回滚，损坏的摘要或成员关系拒绝读取，来源或策略变化同时拒绝旧结论和迟到响应。未核验与 unavailable 明确区分；新 run 只替换覆盖义务，原事实保留。见 [ADR 0036](./decisions/0036-phase4-history-verification-records.md) 与 [本轮证据](../../evidence/phase4-history-verification-probe.json)。

本轮最终根检查通过 1043 项单元/性质测试、260 项集成测试，164 个生成契约无漂移。新增四项 Worker 集成测试；Provider 源码未改，92 项结果为此前基线而非本轮重跑。最终构建通过 Core Schema 20 精确 wheel 的公开响应落盘/再次重启/原批次重试及 Chromium 联合回归，工具与既有 24 组恢复冒烟通过，完整恢复入口保持退出 2。真实清单其余三项仍未核验，缺口及原 Usage 保持；生产调度、全部事实覆盖、跨批次一致性和安全解除继续实施。默认 SDK 与支持范围不变，候选发布仍待此前明确授权，Phase 4 总目标保持进行中。

A3 原请求核验调度：新增独立 `MemoryRecallVerifier` 契约、Iris 公共核验通道和 Runtime 维护调度器，在普通 MemoryHost 停止时分批读取原清单并保存结论。每批使用安装 SDK negotiation，按实际请求 body.scope 检查身份；DB Worker 发送前复核隐私状态及准备代际，旧代际保持未核验。取消后保留实际在途名额，重启使用已保存覆盖进度；核验提交但丢 ACK 也不重复远端请求。见 [ADR 0037](./decisions/0037-phase4-recall-revalidation-coordinator.md) 与 [本轮证据](../../evidence/phase4-revalidation-coordinator-probe.json)。

本轮根检查通过 1049 项单元/性质测试、263 项集成测试，168 个生成契约无漂移。随后修正真实 SDK 嵌套 scope 检查，最终 Provider 96 项及类型、lint、格式、构建通过；Runtime 四项专项包含新增丢失核验 ACK 恢复例，未计作根检查重跑。实际维护调度→公共 Core→DB Worker→重启恢复与 Chromium 联合回归通过，工具和既有 24 组恢复冒烟通过，完整恢复入口继续退出 2。当前为显式维护装配，自动恢复及隐私生命周期联动、旧策略请求授权、其余事实覆盖、跨批次一致性和安全解除继续实施。默认 SDK 和支持范围不变，候选发布仍待此前明确授权；Phase 4 仍在进行。

A3 持久恢复发现与取消归属：DB Worker 在单个快照中读取缺口、真实隐私状态及原清单，区分缺失、有效和正常失效；损坏的摘要不自动重建。`resume()` 复用持久 runId，调用者无需保留内存中的原身份。MemoryHost 工厂固定维护任务身份并绑定当前代际；隐私、Forget、资源/人格失效、Session 改绑或关闭先取消旧任务。见 [ADR 0038](./decisions/0038-phase4-history-recovery-discovery.md) 和 [本轮证据](../../evidence/phase4-history-recovery-discovery-probe.json)。

本轮最终根检查通过 1049 项单元/性质测试、266 项集成测试，168 个生成契约无漂移；持久化八项和 Runtime 六项专项通过。Provider 源码未改，96 项为此前基线。最终真实 Core/Chromium 验证由未启动普通 Provider 的新维护宿主创建调度器，自动发现原清单并在 Worker 重启后复用结果，不重复远端请求；工具及既有 24 组恢复冒烟通过，完整恢复入口保持退出 2。自动后台重试、旧策略请求授权、完整事实覆盖、跨批次一致性和安全解除仍未完成。默认 SDK 与支持范围不变，候选发布继续等待此前明确授权，Phase 4 保持进行中。

A3 受控后台恢复：可信装配通过 `startHistoryRecovery()` 启动每 Provider 单个 worker；无缺口时等待，后续缺口自动发现，暂时失败或清单失效按间隔重试。取消或超时后等待底层实际结束，关闭清除定时器，不合作调用仍占容量；不可重试及身份错误转为 attention。见 [ADR 0039](./decisions/0039-phase4-background-history-recovery.md) 和 [本轮证据](../../evidence/phase4-background-history-recovery-probe.json)。

九项 Runtime 专项通过。最终根检查日志记录 1049 项单元/性质测试、269 项集成测试通过，168 个生成契约无漂移；原终端退出结果未保留，证据未补造退出码。真实 Core/Chromium 联合回归退出 0，后台后续轮次和 Worker 重启复用结论，不重复公开核验；工具和既有 24 组恢复冒烟通过，完整恢复入口退出 2。自动进入启动期/运行期恢复模式、旧策略请求授权、其他事实覆盖、跨批次一致性和安全解除仍待完成。默认 SDK 保持，候选发布等待此前明确授权，Phase 4 继续实施。

A3 Runtime 恢复装配：可信 `historyRecovery` 为所有已注册 Provider 配置独立核验端口，正常启动后自动维护。持久缺口重启跳过普通 Provider/Persona 与决策宿主；启动过程中已持久确认的缺口也能转入维护。运行期缺口中断演出并关闭决策管道，Persona 刷新停止，宿主屏障在本生命周期保持。恢复时 live 200、ready 与新会话交换 503；无关启动错误继续失败，无效配置也清理 DB Worker。见 [ADR 0040](./decisions/0040-phase4-runtime-history-recovery.md) 和 [本轮证据](../../evidence/phase4-runtime-history-recovery-probe.json)。

最终完整根检查退出 0，1049 项单元/性质测试、274 项集成测试通过，168 个生成契约无漂移；十四项历史恢复集成用例覆盖新装配。初次发现的 Node 原生 TypeScript 参数属性兼容错误已修复，最终复跑全部通过。真实 Core/Chromium 通过实际 Runtime 维护启动和重启复用，核验 HTTP 不重复，原 Usage 及其余三项未核验事实保留；工具和既有 24 组恢复冒烟通过，完整恢复入口保持退出 2。生产凭据配置加载器、全部事实核验、跨批次一致性、安全解除和后续 Phase 4B 仍未完成。默认 SDK 保持，候选发布仍等待此前明确授权，Phase 4 继续实施。

A4 可信配置与运行入口：新增 `pnpm start:iris --config /absolute/config.json`，严格配置只接受凭据引用，Iris token 不进入 RuntimeConfig。文件读取有界，POSIX 凭据文件检查私有权限；禁用不解析凭据或导入 Provider，错误不回显配置正文。固定安装入口装配单个 Provider/Persona 所有者及可选恢复通道，支持 SIGINT/SIGTERM 关闭。见 [ADR 0041](../../adr/0041-phase4-iris-launch-configuration.md)、[运行说明](../../iris-runtime-operations.md)、[样例](../../examples/iris-runtime.json) 和 [证据](../../evidence/phase4-iris-launch-probe.json)。

最终根检查退出 0，1054 项单元/性质测试、274 项集成测试通过，168 个生成契约无漂移。五项配置专项及真实 CLI 四场景（启用、重启、禁用、缺失凭据）通过；修复了原默认 paceMs 0 在重复校验时被拒绝的问题。真实 Core/Chromium 联合回归和工具通过，既有 24 组恢复冒烟通过，完整恢复入口保持退出 2。默认 SDK 与 Schema 范围不变；生产输入/工具身份授权、凭据轮换撤销、完整事实核验、安全解除及 Phase 4B 仍待完成。候选 SDK 发布继续等待此前明确授权，Phase 4 保持进行中。

A3 记忆 readiness 与真实凭据撤销：Host 暴露有限的当前准入原因，Runtime 将人格/隐私屏障体现为 unavailable 与 ready 503，历史缺口仍为 recovering。迟到和缓存人格不解除撤销；新的有效 live 版本可恢复对应人格能力。Iris 明确鉴权拒绝锁定本实例、取消在途请求、停用后台网络重试并持久封锁人格回退。见 [ADR 0042](../../adr/0042-phase4-memory-readiness.md) 与 [本轮证据](../../evidence/phase4-memory-readiness-probe.json)。

最终根检查退出 0，1054 项单元/性质测试、275 项集成测试通过，168 个生成契约无漂移；Provider 99 项与类型、lint、格式、构建通过。为隔离测试 Core 从本地缓存安装锁定的 Console 可选依赖，原 wheel 178 个文件核验不变；公开管理接口实际撤销测试业务凭据后，旧 Context 被取消，live 200、ready 503、Provider unhealthy，Persona 回退被拒绝。Core/Chromium/CLI 联合回归及工具、既有 24 组恢复冒烟通过，完整恢复保持退出 2。凭据轮换、多 Provider 健康、全部权限变更与历史事实核验、安全解除和 Phase 4B 仍待完成；候选 SDK 发布仍待此前授权，Phase 4 继续实施。

A4 受控凭据轮换：通过公开 Core 接口进行零重叠轮换，旧 Runtime 在鉴权拒绝后关闭；仅用旧凭据文件重启失败。私有文件原子替换后，新实例以相同业务身份、Session、配置和数据目录恢复 ready。两条原 Recall 请求、一条 Manifest 和一条已确认 Usage 逐项保持，继任凭据接受原 Usage body/身份重放并完成新 Recall；随后撤销继任凭据再次取消 Context 并返回 ready 503。见 [ADR 0043](../../adr/0043-phase4-credential-rotation.md) 和 [本轮证据](../../evidence/phase4-credential-rotation-probe.json)。

真实 Core/Chromium/CLI/历史恢复联合探针退出 0。本轮仅修改验收与说明，Runtime/Provider 生产源码摘要与此前完整检查一致；1054 项单元/性质测试、275 项集成测试、99 项 Provider 测试和 24 组恢复冒烟均为此前基线，未作为本轮重跑。当前受控零重叠轮换路径已验证，热更新、重叠期、多实例和轮换崩溃未验收；完整事实核验、安全解除、其余 A4 Gate 和 Phase 4B 继续实施。候选 SDK 发布仍待此前授权。


A0/A4 正式 SDK 与检查点请求对齐：按指南允许的固定候选安装物路径，将已核验 SDK 0.11.2 原始压缩包纳入仓库，用相对 file 依赖和锁文件 integrity 安装。正式 Provider 在协商后发送持久化游标/事件身份，旧 Core 保留 cursor-only，保存失败及重启沿用原配对值。探针解析同一安装物并逐文件核验，不再代写检查点或依赖临时 SDK 路径；见 [ADR 0044](../../adr/0044-phase4-installed-checkpoint-sdk.md) 与 [本轮证据](../../evidence/phase4-installed-checkpoint-sdk-probe.json)。

最终 Provider 独立 check 退出 0，100 项测试及类型/lint/格式/构建通过；新临时目录冻结离线安装与四个 SDK 文件核验通过。Schema 14、15、20 的真实 Core/Chromium 回归均退出 0，Schema 15 另含已实现工具；Schema 20 联合检查点、历史维护、启动器与凭据轮换通过。新依赖下 24 组恢复冒烟通过，完整恢复入口仍退出 2。根 Runtime 源码未变，本轮未重复根完整检查；1054/275/168 为此前基线。CI 已增加独立 Provider 安装检查，但远端执行尚未观察。默认 SDK 现为 0.11.2，默认 Core Schema 仍为 14–15；此前 registry 发布没有执行，也不是本地安装的前提。历史安全解除、完整 A4 和 Phase 4B 继续实施。


A4 真实 Core 旧快照：新增 `pnpm test:memory:iris:snapshots`，通过已安装 Core 公开 CLI 创建并验证签名备份，停止实际 API/Worker，冷恢复到新隔离目录后以原地址重启。真实 Provider 消费并保存原事件检查点；备份保留的正游标仍可验证，备份后的锚点缺失及数字游标被另一事件复用均返回 410。见 [ADR 0045](../../adr/0045-phase4-core-snapshot-restore.md) 与 [证据](../../evidence/phase4-core-snapshot-restore-probe.json)。

最终新命令（含根与 Provider 构建）退出 0，两个场景各一次通过。旧 Context 取消，两个原请求、一条 Manifest、一条已确认 Usage 保持，独立公开重放返回原 Core report ID/stages；宿主交付被缺口阻止，原目录重启为 recovering/live 200/ready 503、无决策管道。生产源码未变，完整根 1054/275/168、Provider 100 和 24 组恢复冒烟仍引用此前证据，未混作本轮重跑。Bellis 旧快照、Core 目录切换故障/最新删除账本合并、全部游标差异、安全解除及完整 A4/Phase 4B 继续实施。


A4 Bellis 旧快照回退：在真实 Runtime 采用含目标 Claim 的 Manifest 后关闭全部自有数据库连接，复制完整数据目录。Core 公开删除后，宿主先追平、保存较新墓碑，再关闭并实际恢复旧目录；逐文件摘要证明与备份一致。Core 在线时，即便暂缓 SSE，新 Context 不回注 Canonical canary；原 Recall/remember 重放分别返回 409/404。追平后恢复相同永久墓碑和删除检查点，取消旧 Context、拒绝旧 generation Usage，原 Manifest/Outbox 保留，第二次重启 ready 且 generation 稳定。见 [ADR 0045 扩展](../../adr/0045-phase4-core-snapshot-restore.md) 与 [证据](../../evidence/phase4-host-snapshot-restore-probe.json)。

最终 `pnpm test:memory:iris:snapshots`（含根与 Provider 构建）退出 0，新增宿主场景及两项 Core 冷恢复共三项各一次通过。生产源码未变，根 1054/275/168、Provider 100 和 24 组恢复冒烟仍为此前基线，本轮未重跑。Core 离线、pending Observe 快照、两端同时恢复及其他资源/权限变更尚未由本探针证明；完整 A4 和 Phase 4B 继续实施。


A4 待交付 Observe 冷快照：在发送前、Core 已提交/HTTP ACK 未转发、SDK ACK/host delivered 前三个窗口终止实际 Runtime，确切退出后复制含 WAL 的完整目录。先恢复至 delivered 再关闭并回退旧快照，Core 保持较新 cursor=1；原 event/outbox ID、HTTP 正文摘要和批次键不变，三次实际投递只对应一个 Canonical ID，测试专用新批次键仍只返回原记录 duplicate 且不产生新任务。三个场景分别保留 remote cursor null/1/1 与 Provider cursor null/null/1 的真实区别。见 [ADR 0045 扩展](../../adr/0045-phase4-core-snapshot-restore.md) 与 [本轮证据](../../evidence/phase4-observe-snapshot-restore-probe.json)。

最终 snapshots 命令（含构建）退出 0，六个快照场景各一次通过。本轮另在当前 SDK 0.11.2/固定 Schema 20 Core 上跑满所有已实现的 480 个恢复用例，24 个组合各 20 次：采用/Usage 180、Observation HTTP 180、SSE 120，全部断言通过。完整恢复入口仍按剩余窗口返回 incomplete/退出 2。生产源码未改，根完整检查和 Provider 100 项测试本轮未重跑。Stage 效果耦合、完整容量/游标矩阵、安全解除及 Phase 4B 继续实施。


A4 真实 Stage 效果事务：新增 `test:memory:iris:stage-recovery`，Chromium 在 AudioWorklet 渲染后经实际 Control 连接发送回执；在确认/Observe 事务 COMMIT 前、COMMIT 后尚未回复 Stage 两个窗口分别 SIGKILL Runtime，每窗口 20 次。原数据库和相同 Session 配置重启，提交前零观察，提交后保留唯一原事实；40 条原 Manifest 保持，剩余配额全部释放，没有旧 Scene 自动重播，未确认后半段不进入下一轮上下文。独立安装 SDK 公共重放核对 20 个 Canonical ID，新增事实/任务为零。见 [ADR 0046](../../adr/0046-phase4-stage-effect-crash-recovery.md) 和 [本轮证据](../../evidence/phase4-stage-effect-recovery-probe.json)。

Stage 页面增加可选 `resumeSessionId`，通过已有认证接口恢复原 Session；验收核对 `resumed=true` 和下一轮本地确认历史中的原 receipt ID，不能用新 Session 的 Recall 命中代替。完整专项（含根与 Provider 构建）退出 0，Stage 66 项单元测试、类型/lint/格式及既有浏览器三项回归通过；恢复参数补充后另行验证真实 Core/Chromium 三轮正常输出。Runtime/Provider/持久化生产源码未改，根完整检查、Provider 100 项和此前 480 次/六快照未重跑。本专项仍缺 Core 进程组合、活动 Stage 的 Observe HTTP ACK 窗口与容量压力，完整 A4、安全解除、其余 A3 Gate 及 Phase 4B 继续实施。
