# ADR 0015：Iris 工具公共传输与未知写结果

状态：公共传输及宿主未知结果路径已实施；四工具完整注册与恢复 Gate 未完成。日期：2026-09-07。

## 决策

1. 独立 Iris 包的 `IrisToolBoundary` 经已安装 SDK 调用 search、rememberClaim、correctClaim、forgetMemory。Provider 本地的可序列化请求信封包含操作、公共请求正文及写幂等键；correct 另含 claimId。它不包含凭据。`freezeIrisToolRequest` 在异步调用前深拷贝、冻结并限制为 64KiB，复核公开请求 Schema、已知字段、幂等键、revision、scope 与 Lease Proof。宿主的授权、可信字段注入和持久化必须在调用它之前完成。
2. 这些 SDK 方法没有 AbortSignal 参数，因此每次调用新建一个 SDK Client，通过它自己的公开 fetch 接缝绑定父取消与截止时间，不修改全局 fetch 或共享 Client。沿用正文上限、重定向拒绝及脱敏 ErrorEnvelope；超时 1–30000ms。单个 Boundary 保留一个实际在途名额，超时返回不释放尚未结束的底层请求。后续调用不能在旧写仍运行时并发绕过它。
3. 已发出写请求后，断流、超时、取消、5xx 或无法验证成功响应都返回 `IrisToolOutcomeUnknown`。明确的 400/401/403/404/409/422 拒绝保留稳定代码和状态；未发出请求的取消或忙碌不冒充未知写。返回值核对安全整数，forget 原样区分 target、erased、protected、held 计数；不把内容清除计数解释为物理磁盘擦除。
4. Tool Runtime 对已启动的可变 Handler，取消、超时、异常或不可验证结果都保留 `tool_outcome_unknown` 与 `remoteOutcome: unknown`，持久运行状态为 uncertain。可信适配器仅在明确拒绝时抛 `ToolRejectedError`。纯读取失败仍是普通失败；尚未执行的排队调用取消不标为未知写。结果不会触发自动重试，下一 Cycle 明确收到“远端写入结果未知，不得断言未写入或用新键重写”的说明。
5. `Phase3HostOptions.confirmation` 允许可信宿主装配 ConfirmationPort；缺少该端口时确认型工具仍拒绝。确认请求包含冻结的模型调用参数、工具版本、Session/Turn/Cycle/Tool Run 身份、幂等键摘要和绑定这些字段的 requestDigest，并携带 AbortSignal 与单调 Deadline。确认和 Handler 共用一次工具期限；批准后及缓存读取后重新检查权限、取消和期限。
6. 每个 Runtime 只允许一个实际未结束的确认请求。取消、超时、异常和忙碌均不执行 Handler；不遵守取消的 Port 保留名额直到真正结束，迟到批准不会重新执行原调用。Runtime 关闭不等待失控 Port 的 Promise。注册声明与编译调用深拷贝后冻结，防止等待期间修改权限或参数；确认型调用不能经并发 L0 结果共享跳过独立确认。
7. Iris 模型工具尚未默认注册。当前确认绑定原始模型调用，尚未包含注入 actor/scope/revision 后的完整可信 SDK 请求；实际请求落库、授权摘要、目标授权、隐私屏障与公共对账仍须接入后才开放写工具。

## 证据与未关闭项

确认专项进一步验证具体参数与持久调用一致、Session 关闭后不执行、迟到批准忽略、单调期限共享、批准期间能力撤销，以及相同缓存调用仍分别确认。Provider 测试使用真实安装 SDK 加受控 HTTP 接缝，验证四个路径、原键/Lease/revision、深冻结、非法请求拒绝、挂起请求取消及名额保留、明确冲突与未知结果、错误脱敏和安全整数。宿主/DB Worker 集成验证可变 Handler 已生效但丢响应后仅执行一次，持久 uncertain，保留原始调用，并在下一 Cycle 提示对账。

`node scripts/iris-public-probe.mjs --tools` 在临时 Core API/Worker 中验证 remember 提交后丢响应及原键恢复、correct 递增 revision/原键重试/旧 revision 409、forget 实际清除/重复结果与删除后不可读。当前固定 Core 0.12.0/schema 14 的新库搜索持续未就绪，因此整个四工具专项明确为 incomplete、退出 2；不能称为四工具验收通过。脚本保留搜索错误原因，并继续验证独立的写操作，不用空结果充当搜索命中或删除证明。

后续需要通过可信公共初始化/管理入口建立 FTS 已验证 generation。当前 Iris 源码已推进到 0.13.0/schema 15，而验收安装仍固定为 0.12.0/schema 14；不能直接覆盖旧安装后沿用历史 SHA 或兼容声明。还需完成宿主四工具注册、实际请求与可信权限冻结、Iris 实际请求的确认绑定、真实 Legal Hold/保护对象、隐私协调器与外部事件、公共未知结果对账矩阵、A4 和 Phase 4B。

2026-09-07 后续增量：[ADR 0016](./0016-phase4-prepared-tool-requests.md) 已增加实际请求落库、确认绑定和恢复的通用端口，并用真实 Core remember 夹具验证；上述决策保留实施当时的边界。生产四工具授权/隐私装配及搜索 Gate 仍未完成。
