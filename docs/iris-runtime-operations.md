# Iris Runtime 启动与维护

当前交付固定本地安装入口与可信配置加载，见 [ADR 0041](./adr/0041-phase4-iris-launch-configuration.md)。完整 Phase 4 Gate 仍以[实施记录](./phase-4-implementation-status.md)为准。

## 安装与启动

从 Bellis 仓库执行，使用锁定的 Node/pnpm 基线。Iris Provider 独立于根 workspace 安装；通过锁文件安装仓库内不可变 SDK 0.11.2 压缩包，不需要本地 registry 服务或发布步骤，见 [ADR 0044](./adr/0044-phase4-installed-checkpoint-sdk.md)。

```sh
pnpm install --frozen-lockfile
pnpm --dir providers/memory-iris install --frozen-lockfile
pnpm build
pnpm --dir providers/memory-iris build
pnpm start:iris --config /absolute/path/to/iris-runtime.json
```

以[配置样例](./examples/iris-runtime.json)为起点，替换数据目录、已存在的 Core agent/space、受信任读取身份、模型服务及凭据变量名。样例只包含引用，没有可用业务凭据。Core 的 API/Worker 与公开初始化须先完成；不要填写虚构的 Core Session ID。默认范围为 Schema 14–15；其他范围必须由操作者显式配置，并核对对应[兼容矩阵](../providers/memory-iris/compatibility-matrix.json)，不能仅因启动通过就声明兼容。

`credential` 支持 `{ "kind": "environment", "name": "BELLIS_IRIS_TOKEN" }` 或 `{ "kind": "file", "path": "/absolute/private/token" }`。POSIX token 文件须由当前用户所有、权限 0600 或更严；可有一个末尾换行。凭据不写入 JSON，不放在命令参数，也不交给 Stage。环境变量由本地服务管理器或操作者提供。Windows 文件 ACL 路径尚未验收。

要建立本地客户端会话，可显式追加 `--print-startup-token`；只有 ready 时会输出一次性本地会话 token。不要把整份配置加载结果序列化到日志。业务 Iris token 始终不输出。

## 运行边界

监听地址只允许 loopback。配置必须显式启用演出与决策宿主；模型服务使用独立 API Key 环境变量。配置中的固定 actor 只表示经操作者选择的读取上下文；不会据此把任意弹幕或 Stage 文本当作该用户的可信 Observation。本入口不注册记忆写工具或自动输入 Observe。需要输出 Observe 时，另行显式配置 `observeOutput.privacyLabels`。

首个交付入口只接受 Surface `off`。Core 要求其他模式时拒绝相应操作，不以关掉服务端检查代替支持。Origin 允许列表必须包含精确 `baseUrl`；非 loopback 只允许 HTTPS，重定向仍被 HTTP Adapter 拒绝。

## 重启、恢复与停用

使用原数据目录、稳定 appInstanceId、identityScope 和真实 Core 身份重启，保留已持久的 Manifest、请求、Usage 与 Observe Outbox。不要为规避缺口而更换身份、删除账本或复制旧缓存。

需要在 Stage 继续原 Bellis 逻辑 Session 时，重新打开页面并在新的本地 startup token 之外传入 `resumeSessionId=<原 Session UUID>`。页面通过现有认证接口请求恢复，成功响应携带相同 Session ID 和 `resumed=true`。该标识属于 Bellis 本地会话；Iris 业务凭据仍由 Runtime 保管。恢复保留已确认输出的本地历史，并关闭旧演出，不自动补播 Scene。实际 Worklet 回执与恢复证据见 [ADR 0046](./adr/0046-phase4-stage-effect-crash-recovery.md)。

具备公开 Recall 核验能力的已验证 Core 可配置 `historyRecovery: { "intervalMs": 30000, "timeoutMs": 60000 }`。这会启用独立维护通道。持久缺口重启进入 recovering：live 为 200，ready 和新会话交换为 503，普通 Provider/Persona 与决策宿主不启动。运行期发现缺口也会关闭决策管道。部分核验结果不会恢复普通运行；完整事实核验与安全解除尚未交付。

发送 SIGINT 或 SIGTERM 进行统一关闭；配置错误与启动失败使用固定错误信息并退出 1。停用 Iris 时把配置中的 `iris` 改为 `{ "enabled": false }` 并重启；不读取业务凭据、不导入 Iris Provider，原数据保留。不要把停用或重启解释为缺口解除。回退旧二进制前仍须验证 Migration 读兼容，当前不会自动回退账本或 checksum。

## 鉴权和就绪状态

Runtime 的 live 只表示进程存活。已观察到 Persona 撤销或隐私屏障时，ready 返回 503，可信宿主的 `memory.readiness` 提供有限原因；迟到或缓存 Persona 不会解除。新的有效 live Persona 可解除对应人格屏障，历史缺口则继续保持 recovering。

Iris 收到 401、403 或 404/access_denied 后，当前实例停止后台网络重试并取消在途调用，Persona 回退保持封锁。修复可信凭据或授权后显式关闭并重启，由新生命周期重新协商与读取；重复调用运行中实例的 start 不解除鉴权拒绝。已通过真实 Core 公开管理接口验证撤销，详见 [ADR 0042](./adr/0042-phase4-memory-readiness.md)；全部权限变更的验收范围另行记录，受控凭据轮换见下节。

## 受控凭据轮换

已验证零重叠轮换和显式重启，见 [ADR 0043](./adr/0043-phase4-credential-rotation.md)。操作员通过 Core 公开管理接口轮换业务凭据，需具备相应委托权；保留原 agent、space、appInstanceId、Session 配置及数据目录。

1. 轮换后等待旧实例观察到鉴权拒绝。旧实例保持 unavailable，不能以缓存恢复；显式关闭它。
2. 在凭据文件所在目录创建由当前用户所有、权限 0600 的新文件，由可信凭据管理流程写入继任 token，再原子 rename 到配置所引用的原路径。不要把 token 放进命令参数或配置 JSON。
3. 使用原配置重新启动，确认 live/ready 正常，并检查保留的原请求、Manifest 和 Outbox。新实例重新协商并读取 live Persona；沿用原 Usage body 与幂等身份，不生成替代报告来掩盖重试。

轮换失败或新凭据未安装时保持不可用并检查公开管理结果；不要删除数据目录、清空失效屏障或恢复旧缓存。当前未提供运行中热换 token，重叠期和轮换过程崩溃仍需额外验证。轮换恢复就绪不解除既有历史缺口。
