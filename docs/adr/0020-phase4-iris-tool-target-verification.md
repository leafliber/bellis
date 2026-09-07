# ADR 0020：Iris 写目标预览与确认后核验

状态：目标读取/确认核验已实施；生产意图与证据授权、完整恢复 Gate 仍开放。日期：2026-09-07。

## 决策

1. `correct`/`forget` 的模型 claimId 只作为选择器。取得可信 grant 后，适配器通过安装 SDK 的公开 `getClaim` 读取目标，独立核对 Claim ID、agent、当前 subject、revision、可见状态、scope 和隐私标签。安全整数、HTTP 字节上限、取消及稳定错误继续适用；目标读取和工具写入共享实际在途名额，超时不释放仍未结束的传输。
2. `subject.self` 必须由配置的 `selfEntityId` 解析；不得从模型选中 Claim 的主体反推 self。显式 entity grant 则使用已授权 entityId。允许当前 agent 的全局继承范围或当前 space；Session 必须属于当前 space 且匹配可信 Core Session。没有证明 group 成员关系时拒绝 group 范围，隐私标签必须非空且全部在 grant 内。
3. 目标的主体、revision、状态、scope、隐私标签、canonical text 和 value 随实际请求保存，纳入确认摘要。它们是供确认使用的不可信数据。`correct`/`forget` 声明版本升为 2；不能把旧版缺少预览的准备记录自动升级为新版已确认请求。
4. 批准后先复核宿主授权，再重新读取目标并逐项比较已保存预览。目标改变即拒绝写入。目标 I/O 完成后再次复核宿主授权，防止读取期间撤权被忽略。写请求的 Claim selector/revision 也必须与保存预览一致。Forget 的持久屏障仍在最后一次核验之后、公共写入之前建立。
5. `correct` 的远端并发保护仍依赖公共 `expected_revision`。当前 Core Forget 契约没有该字段，目标 GET 和 Forget POST 不是一个远端事务；本实现不能证明跨写者的原子修订授权。若目标范围可能被外部写者改变，需要后续公共 Lease/权限策略或 Core 条件写支持，不能把两次读取宣称为消除全部竞态。
6. 已成功纠正/删除后，旧目标可能已推进 revision 或不可读取。普通工具执行保持拒绝，不通过重新授权/换键绕过。未知结果的原请求对账仍走明确的可信恢复路径；本切片不将读取失败解释为已写或未写。

## 验证与范围

独立 Provider 77 项测试通过，包括跨 agent/主体/空间/Session、未证明 group、空或未授权隐私标签、错误 revision/状态、确认期间正文或 scope 变化、目标读取期间撤权，以及失控读取阻止后续写入。类型、构建、lint、格式均通过。

真实 Core 0.13/schema 15 的注册 Forget 已验证两次目标读取、一次确认、HTTP 写入前持久屏障、一次删除，以及 DB Worker 重启后回执和永久 tombstone 保留。公共工具专项退出 0。模型意图/证据的生产 grant、四工具全部宿主路径、真实 Legal Hold/保护对象、外部失效和 A4/4B 仍待完成。见 [目标核验专项](../evidence/phase4-tool-target-probe.json) 与 [真实 Core 报告](../evidence/phase4-tool-target-core-probe.json)。
