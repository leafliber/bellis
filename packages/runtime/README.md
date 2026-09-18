# P0 运行时

本包承载当前 P0 的真实本机进程边界。可运行入口位于 [apps/host](../../apps/host/README.md)。W3 实现身份、配置/安装核验、有界传输、跨进程时钟映射和无授权查询；不实现媒体、供应商、自动恢复或通用结算引擎。

## 模块和 Schema

| 模块 | 当前职责与契约 |
| --- | --- |
| `src/files.ts` | 受控目录/文件、UID/权限/符号链接检查、一次实例的 inode 清理、私有 bootstrap 描述符读取；`P0OperatorCredential`、`P0PeerIdentity`。 |
| `src/config.ts` | `P0RuntimeConfig`、`P0HostBootstrap`、`P0TrustedInstallation` 及实际 Manifest/加载闭包核验；仅核验后创建 SDK 安装上下文。 |
| `src/identity.ts` | Node crypto Ed25519 公告与 peer 挑战、管理 HMAC 和单次挑战消耗；`P0ConnectionAnnouncement`、`P0OperatorProof`、`P0PeerProof`。 |
| `src/clock.ts` | 实例单调时钟、保守偏移区间和明确目标域 deadline；`P0ClockMapping`、`Deadline`。 |
| `src/transport.ts` | socket/stdio 共用的有界 UTF-8 NDJSON、重复键与结构解析、有限写入和关闭。 |
| `src/client.ts` | 验签建连、有限 pending 与请求时限、命令/结果 Schema 验证、原始 RPC 回包保留。 |
| `src/service.ts` | 受控 socket、登记命令路由、角色/实例/会话/摘要/时钟/权限复核；`RpcRequest`、`RpcSuccess`、`RpcFailure`。 |
| `src/processes.ts` | Supervisor 启动 Host、最小环境、私有 fd、真实健康连接与有限子进程终止；初始 `P0SessionSnapshot`。 |

字段和签名规范唯一来源是 [contracts/src](../../contracts/README.md)、[P0 契约简报](../../docs/generated/P0.md)及[第22.6节](../../docs/spec/22-tech-storage-deployment.md)，此处不复制字段表。SDK 的 `bindVerifiedP0Installation` 是进程内绑定，不负责文件认证；生产路径只在 `verifyInstallation` 完成后使用它。

## 安装边界

安装清单固定入口、每项制品 SHA-256、Manifest 摘要、插件/协议/契约身份、能力和目标白名单。入口旁 `manifest.json` 必须列入制品。文件必须属于当前 UID、没有组/其它用户写权限，实际路径不得经过符号链接；每文件最多 32 MiB。核验前后读取摘要，拒绝缺项、重复路径、替换入口及身份不符。

当前支持静态 ESM 加 Node 内建模块。使用已锁定的 esbuild 仅解析依赖，不执行入口，实际依赖文件、生成校验器及最近的 `package.json` 必须全量列入清单。解析警告、动态 import、require/require.resolve、间接 require、direct eval，以及外部非内建加载均拒绝；内建 `module`、`vm`、`child_process`、`worker_threads` 也拒绝进入插件依赖闭包。文件中的普通字符串不作为执行调用匹配。尚不支持依赖动态加载的插件包。

该核验只允许受信安装的 P0 假设备能力，不是恶意代码沙箱。W3 未加载假设备；W4 在真正启动和握手时仍须复核实际入口/制品与 Manifest，不能以本包预检代替加载身份验证。真实效果适配器、管理凭据和外部供应商秘密不得进入端点。

## 状态、所有权和时钟

Supervisor 是监督状态、grant 和 StopOperation 的预定唯一归约者，W3 仅维护初始无 grant 的快照及 Host 连接观察；Host 只有执行入口和投影。端点实际计数/水位/停止/清理必须由 W4 的端点写入，W3 查询明确为空/unknown。W6 才有单一物理写入者的 SQLite Worker 和事务 Outbox，当前没有数据库读写、成功持久化替身或旧记录恢复。

公告绑定固定服务公钥、角色、实例、会话和单次挑战。管理证明的认证主体来自凭据，不来自 `operator_id` 字符串；peer 角色来自启动时固定公钥。无管理凭据的服务使用显式 null，管理请求直接拒绝。认证连接的 proof 防重放不等于业务 operation 去重；W5/W6 必须以稳定认证主体、会话和 operation 维护原授权与期限，不能把每次 CLI 连接当作新业务身份。

公告的外层发布者与签名载荷中的 Session owner 分别核验：Supervisor 绑定自身权威，Host 的权威来自固定 bootstrap，端点协议 fixture 同样只使用固定监督身份。签名覆盖 authority_id、authority_instance_id 和 authority_epoch，外层 epoch 必须一致；客户端保存不可变的验签公告并据其构造 context。当前核心入口仍无授权、代次为 0，通过受信 getter 复核当前值，公告后发生代次变化即拒绝旧连接请求。非零代次测试只修改受控模块实例，不提供网络修改入口。

该核心入口的“context、公告、当前代次三值相等”限制不能直接作为后续端点的统一前置检查：W4 需分别处理首次连接认证、已认证 Host 的当前代次执行，以及仅认证监督 lease/revoke 的合法 advance；不能重公告或延长固定 stdio 的 TTL 来绕过。

时钟映射从验签公告和客户端前后采样生成，保留整数毫秒量化的 ±1 ms，检查双实例、连接、域、顺序、误差和 TTL。期限取偏移下界并限制于映射有效期，目标侧再次检查；失效直接拒绝。客户端无自动重试，不生成延长期限的补偿请求。W3 仅使用初始 authority_epoch 0；后续撤权代次传播尚未实现。Worker 同域基准留待 W6 显式绑定。

## 资源、背压与清理

`P0SafetyLimits` 控制帧长、pending、连接上限、连接健康超时、时钟误差与 TTL；测试配置是有限参数，不宣称实测安全 SLO。单连接接收缓冲最多一帧，写入超过有限积压即断开，客户端请求超时清空 pending 并关闭连接。非法 UTF-8、重复键、批请求、通知、字段不符和未知方法无法进入执行逻辑。非法帧结束连接时立即停止接收当前 chunk 后续帧，错误回包至多排空 100 ms。

私有 bootstrap 最多 16 MiB、5 秒。Supervisor 等 Host 首次真实健康报告最多 5 秒；终止子进程先 SIGTERM，1 秒后 SIGKILL，2 秒后仍未收到退出则报告未确认，不能无限等候。进程退出/信号不等于端点清理证据。stdout 只用于协议或 CLI 结果，子进程 stderr 不转发任意内容。

入口在第一个异步启动步骤前注册信号处理，使用 AbortSignal 取消启动。配置核验后的异步边界复核取消状态，不继续创建资源；listen/spawn 之后的取消会收尾已创建的 socket、身份文件和子进程。取消等待 bootstrap 时关闭私有描述符。关闭服务立即拒绝新连接，避免文件清理期间又接纳连接延长退出。

socket 与身份文件由创建者记录 inode，关闭只删除自己的实例路径；已有冲突拒绝覆盖。发生外部路径替换时保留替换路径，并将旧 listener 从事件循环存活引用中移除，真正文件描述符随进程退出关闭。异常退出可能留下旧路径；当前需明确核查后人工处理，不自动删路径或恢复旧权。

## 验证与后续接线

`tests/p0-identity.test.ts` 验证真实核心进程、CLI/socket、stdio 协议 fixture、安装闭包和拒绝路径；`tests/schema.test.ts` 以匹配变更后摘要的合成安装上下文，独立验证 effect、version、refs、权限、管理 method、mode 与 phase 边界。日志在 `reports/p0/w3/`，可复跑命令见入口说明。

W3 没有完成状态机转换覆盖或 SUT 验收。W4 要实现独立假设备及不经过 Host 的监督安全通道，并由该通道读取实际效果/清理事实；W5 实现三状态机、撤权栅栏和持续清理；W6 接入真实持久化后立即运行完整授权→效果→撤权→查询链。此前授权和新增效果保持拒绝。畸形 RPC 的真实入口测试不得改成免鉴权入口，端点 fixture 不能充当 SUT 证据。

W4C 配套检查在 `tests/p0-authority.test.ts`：签名 owner/epoch 与外层篡改、固定 owner 不符、公告后当前代次改变、请求自报更大代次，以及 Host bootstrap 的入口路径/摘要不符。当前 Supervisor 只把已核验 installation.entry 写入 endpoint_config.entry_artifact，Host 精确比较；真正同 Buffer 加载由后续 W4 launcher 实现。新增回执摘要集合和端点事实字段当前没有成功构造器，不能据此声称持久化或端点已经接通。
