# ADR 0016：可信工具实际请求的持久化与确认

状态：通用宿主边界已实施；Iris 生产四工具装配尚未完成。日期：2026-09-07。

## 决策

1. 原始模型 `ToolCall` 继续随 adoption 保存。可信注册层可另外提供 `ToolPreparationHook`，只读解析实际目标、scope、证据、revision 和业务幂等键，不能在准备阶段发出远端写入。准备结果不是 Stage 或模型输入接口。
2. `PreparedToolCall` 绑定原调用摘要、Session/Turn/Cycle/Tool Run、工具版本、Provider、实际请求、实际业务键及可确认描述；可附 Memory policy stamp 和目标资源版本。执行身份由 Runtime 注入，Hook 不能覆盖。请求深冻结后再经过异步确认；Iris 适配器仍须用其公共请求白名单排除凭据和非法字段。
3. Migration 12 保存实际请求，外键关联原始调用。首次保存及精确重试均核对原调用、归属、策略 generation、blocked 和 tombstone。请求只能写一次，换键、参数、确认描述或版本均拒绝；摘要和字节数在读取时复核。每条最多 64KiB，全表最多 4096 条/8MiB，拒绝超额而不驱逐未对账请求。此限额不是总 DB/WAL 配额。
4. Runtime 必须取得保存 ACK 才向 ConfirmationPort 展示请求。保存已提交但 ACK 丢失时不确认、不执行；后续显式重试先加载原请求，不重新解析目标或分配新业务键。恢复读取不受当前隐私版本阻断，以便可信对账；重新执行必须再次通过当前策略检查。该读取不会注入模型上下文或自动发出请求。
5. ConfirmationPort 的摘要包含整个冻结实际请求，业务键摘要采用实际宿主键。批准后再次精确保存以事务复核策略，并复核能力。Handler 收到冻结的 `prepared` 和实际键。原始调用及 Tool Run 的旧 key hash 仍指模型键，实际键与请求保存在独立准备记录，不用改写历史字段混淆两者。
6. 准备、确认和执行共享单调截止时间与父取消域。准备超时、失败、存储不可用或容量耗尽都不执行 Handler。Runtime 至多保留 8 个真实未结束的准备操作；取消不释放仍挂起的操作名额。取消后的晚到解析不能保存；已开始的 DB 保存可能完成，但不再确认或执行。准备工具要求关闭结果缓存。

## 验证与边界

单元测试覆盖缺存储拒绝、恢复原请求与宿主键、保存 ACK 丢失、确认期间策略变化、晚到准备取消，以及批准后存储等待期间能力撤销。真实 DB Worker 测试覆盖进程重启、参数与键变更拒绝、身份/大小失败回滚、缺原调用拒绝、资源 tombstone、跨 scope 与策略变化，以及历史读取保留。真实宿主测试验证持久请求先于确认、实际键执行、未知写结果和 Worker 重启。

`test:memory:iris:tools` 增加可信 remember 夹具，经真实 Decision Host/DB Worker、ConfirmationPort 和安装 SDK 写入 Core，注入成功响应丢失后从重启 Worker 恢复原请求，再用原键对账。它不提供生产目标授权规则，也不把 correct/forget/search 宣称为已通过完整宿主流程。固定 Core 的 FTS Gate、Legal Hold/保护对象、隐私协调与外部失效、公共未知结果恢复矩阵，以及 A4/Phase 4B 仍开放。证据见 [实际请求专项](../evidence/phase4-prepared-tools-probe.json)。
