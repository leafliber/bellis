# ADR 0022：公共资源失效的持久接收与宿主确认

状态：收到的公共删除事件链路已实现并验证，Phase 4 未完成。日期：2026-09-07。

## 决策

1. Core 0.13 的 `memory.invalidated` Worker 任务在确认资源已 tombstoned 后发出 `revision.invalidated.v1`，引用没有 revision；这些资源在宿主写永久 tombstone。带 revision 的资源失效只封锁该版及更早版本。人格引用仍走既有人格流程，普通纠正没有已证明的对应公共通知，不能宣称本切片覆盖所有纠正。
2. Provider 将一个规范化资源失效事件保存为待处理状态，再调用可信 `MemoryProviderContext.invalidateResources`。宿主确认前不得推进事件游标；失败、无宿主处理器或重启恢复时继续封锁 Provider Recall。该状态不是另一条 Fire-and-forget 队列。
3. Migration 15 保存按 scope/provider/event ID 去重的事件摘要，和策略 generation/tombstone 在同一事务更新。重复事件返回当前策略，变更同 ID 内容拒绝；保留已有 privacyRevision 与 blocked 状态，不能释放显式隐私或未知 Forget 的屏障。
4. MemoryHost 在处理事件的第一个异步边界前取消未采用 Context/投递并封锁读取。持久事务及演出停止都确认后才解除该事件的本地屏障；ACK 丢失按原事件重试，旧完成不能覆盖新屏障。Provider 的游标晚于宿主确认提交。
5. 处理器在 Provider 启动前注入，恢复中的待处理失效先于 Recall 开放。事件不携带凭据或正文；资源引用均为公开 SDK 返回的数据。Core SSE 按凭据访问范围筛选，但事件本身不带 agent ID，宿主目标 agent 来自可信 Provider 配置，不能把它描述为事件的独立 agent 证明。

## 开放边界

公共事件只证明收到的失效。SSE 历史缺口/无事件支持的全量重验、普通纠正通知、真实 Persona 撤销、A4 与 Phase 4B 仍有独立 Gate。总磁盘配额不能由单张事件表的行数上限替代。

## 验证与兼容

根检查通过 1018 项单元/性质测试、229 项集成测试，160 个生成契约无漂移；独立 Provider 80 项测试通过。故障注入覆盖事件 receipt 失败时策略整体回滚、同事件 ACK 丢失重试、旧 Recall 迟到与取消旧投递队列。

真实联合探针通过公共外部 Forget → Core Worker/SSE → MemoryHost generation/tombstone → Provider cursor，DB Worker 重启后保留策略和游标；同轮注册工具、三轮 Chromium、四条 Observe 和三条 Usage 也通过。见 [专项证据](../evidence/phase4-resource-invalidation-probe.json) 和 [原始报告](../evidence/phase4-resource-invalidation-core-probe.json)。

原 0.13 CLI 应用凭据没有 `events.sse.v1`，所以 Provider 按协商结果不轮询；直接公共事件读取可见删除事件。Core 可信初始化默认应用能力已补齐该读取能力，仍限原 agent/space、没有管理员权限，既有凭据不被修改。新独立 wheel SHA 为 `74f8105d0607d44475d0d7b0c9c5afcb8bcba3e5e4067a40850f33b453f9f105`；不能把同版本号的旧 wheel 当成这项能力的证据。

Core 初始化专项 9 项及修改文件 Ruff/Mypy 通过。本次新安装还包含上游工作树增量；本次全量回归为 11,114 通过、4 项 Console Schema 失败、54 项本地端口权限错误，覆盖率 83.29%，历史 Core 全量通过结果保持为历史证据。

上述 54 项 Mock Server 环境错误在获得本地端口权限后单独重跑，54 项全部通过；4 项 Console 契约失败仍保留，不将分次结果合并为一次全量通过。
