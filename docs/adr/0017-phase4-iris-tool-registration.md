# ADR 0017：Iris 四工具注册与可信宿主授权端口

状态：注册适配器与应用装配已实施；生产授权规则和 Forget 协调器仍待完成。日期：2026-09-07。

## 决策

1. 独立 Iris Provider 包新增 `registerIrisTools`，通过现有 Tool Runtime 注册 memory_search、remember、correct、forget。读取为 pure/parallel_read；写入为 idempotent/keyed，分别要求 memory.read、memory.write 或 memory.forget，所有写入默认确认。当前均关闭结果缓存，避免在隐私版本变化后复用旧结果。
2. 模型参数使用封闭 Schema。search 只接受 query/limit；remember 接受 predicate/value/canonicalText；correct 接受 claimId/value/canonicalText；forget 只接受 claimId。模型不能传入 scope、证据、subject、reason、revision、Lease、凭据或删除选择器。agent/space/Core Session 来自可信配置，Core Session 不由 Bellis Session UUID 推导。
3. `IrisToolAuthority.authorize` 必须从可信用户请求、身份和目标状态作出授权，返回策略 stamp、subject、证据、隐私标签、来源权威、reason，以及已授权目标的 claimId/revision；无授权拒绝准备。correct/forget 的目标必须与模型选择器完全一致，revision 必须为安全正整数。此端口本身不是目标授权实现，不能把模型选择器直接包装成 grant 当作生产授权。
4. 实际业务键按策略 scope、Bellis Session、Tool Run 和操作生成稳定摘要，不使用模型提供的键。准备结果经公共 SDK Schema/字段校验后进入 ADR 0016 的不可变记录及确认摘要。恢复只加载原请求，不能重新领取 grant 或分配业务键；执行时仍须由 `assertCurrent` 复核保存的授权。
5. Forget 必须先成功调用宿主 `beforeForget` 持久封锁读取与新采用，才发出公共写请求。未知结果及明确拒绝均不自动解除屏障。成功响应交给 `afterForget`，由宿主持久化 tombstone，并根据 target/erased/held/protected 计数决定是否解除屏障。当前注册适配器没有内置“全部成功”的假设，也不声称已经实现生产协调器。
6. 所有成功结果经必需的 `filterResult` 重新检查当前隐私与可见性，之后才成为 Tool Result。边界明确拒绝转为稳定 `ToolRejectedError`；已发送写请求的未知结果继续保留 uncertain。宿主过滤失败不能暴露原始内容，写入后处理失败也不能声称未写入。
7. `RuntimeOptions.tools` 提供可信应用装配入口，显式配置 capabilities、ConfirmationPort 和注册函数。注册函数得到已启动的 MemoryHost，核心 Runtime 不导入 Iris SDK。该入口不是 JSON 配置或 Stage API；配置自定义工具时使用其显式授权集。Decision/Performance Host 未启用则拒绝启动；注册或启动失败会关闭已创建的宿主、Memory、DB Worker 和自有时钟。

## 证据与未完成项

独立 Provider 测试经已安装 SDK 验证四个真实 HTTP 方法、封闭参数、可信 scope/证据/revision、稳定原键、必需 capability、授权拒绝、目标不匹配、批准期间撤权、Forget 屏障顺序、未知结果保持封锁、结果过滤与明确 Core 冲突。应用集成测试验证启动入口传递注册、能力、准备存储和确认，以及注册失败后同目录可重新启动。

真实 Core 专项使用 `registerIrisTools`、Decision Host、MemoryHost/DB Worker 与固定安装 SDK，验证 remember 持久确认、未知写结果、Worker 重启和原请求对账。授权端仍是明确限制为该单次可信输入的探针策略；不能据此声称生产目标授权、真实 Forget 协调、四工具全部经宿主或 Legal Hold 已通过。搜索仍缺 FTS 已验证 generation，完整四工具入口保持 incomplete/退出 2。见 [注册专项](../evidence/phase4-tool-registration-probe.json)。

2026-09-07 后续增量：[ADR 0018](./0018-phase4-forget-coordination.md) 已实现宿主 Forget 协调事务，并接通真实 Core 单目标删除；本 ADR 保留注册切片实施时的边界。生产目标授权、真实 Legal Hold/保护对象和完整恢复 Gate 仍开放。
