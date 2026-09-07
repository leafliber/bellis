# ADR 0023：显式 Space scope 与启动期 Session 归属

状态：Space scope 实现；Core Session 映射与 Phase 4 仍未完成。日期：2026-09-07。

## 决策

`RuntimeOptions.memory` 必须声明：

```ts
scope: { kind: "space", acknowledgeCrossSession: true }
```

这表示同一 Core space 的远端记忆可跨 Bellis Session 读取。配置缺失、未接受跨 Session 语义、session scope、未支持的 scope 扩展，或旧的 `coreSessionId` / `spaceGroupId` 字段均拒绝启动。Runtime 在分配 Worker、监听端口之前验证，直接创建 MemoryHost 时也验证。更新了仓库内 Demo、真实服务和恢复夹具的装配。

当前检查的 Core 0.13 应用 OpenAPI 有 85 个路径，没有 Session 查询路径，SDK 0.11.1 也没有查询 Session 的方法。随机 ID、成功的空 Recall、用户提供的字符串都不是远端 Session 存在及授权的证明。因此本切片收紧支持范围，不生成假的 Session 映射。以后开放 session scope 时仍须实现可信初始化/公开核验、显式映射落盘、恢复核对及工具协同。

MemoryHost 复制作用域标识、Provider 注册列表、输出策略与标签。Recall、输入 Observe、输出 Observe 共用该配置快照；输出投影改由 MemoryHost 提供。改变调用方原始对象不改变既有输出目标。

## 持久化与恢复

启动时 `phase4EnsureMemoryPolicy` 接收可选的 Bellis `sessionId`，在一个 `BEGIN IMMEDIATE` 事务中创建/读取策略、核对 Session 归属并保存绑定。复用 Migration 10 的 `phase4_memory_session_scopes`，无需新 Migration；绑定使用应用、agent、space、身份与隐私作用域组成的原有摘要。新策略插入与绑定失败整体回滚。

MemoryHost 在 Provider 启动之前等待该事务。已有 Session 的作用域不能因重启改配置而改变，即使尚未接纳 Signal 或采用 Cycle。相同作用域的另一个 Bellis Session 被允许，体现显式接受的跨 Session 语义。占位 Session 改绑后，下一次 Context/交付策略刷新再次核对新 Session；接纳与采用事务继续执行原有归属约束。

已 blocked 的策略仍可恢复原绑定并启动 Provider，以继续 Forget/SSE 对账；读取及采用的隐私屏障不被清除。归属核验和解除屏障是独立操作。

交付恢复另核对 Observe 原始 agent/space；缺失 space、目标不符、携带 Session/group 的旧事件返回不可重试的 `memory_observation_scope_mismatch`。Provider 不会收到这些事件，原始正文、目标和业务键不重写；既有 Outbox 失败流程保留记录供后续审计/对账。Usage 继续依赖原 Recall 血缘与策略 stamp，本切片不把旧 Usage 追认为已验证的 Session 映射。

## 验证边界

单元测试覆盖配置拒绝、冻结输出目标、启动绑定失败前 Provider 零调用，以及五类不兼容的恢复 Observe。真实 DB Worker 集成在无 Signal/采用记录时关闭并重开数据库，验证应用/agent/space/身份/隐私/版本变更拒绝、原配置恢复、另一本地 Session 共享 scope、blocked 状态保留和失败事务回滚。

完整检查及真实 Core/Chromium 回归见 [本轮证据](../evidence/phase4-explicit-scope-probe.json)。此前 480 次恢复结果保持历史证据，不把本次配置变更后的冒烟或短程回归当作重新完成整套矩阵。独立 Tool Adapter 的低层 `coreSessionId` 参数不构成宿主已支持 session scope 的证明。
