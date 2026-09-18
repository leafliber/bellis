# P0 本机入口

本目录提供 Supervisor、Host 与操作员 CLI 的可运行入口，运行逻辑在 [packages/runtime](../../packages/runtime/README.md)。当前 W3 只实现真实身份、安装准入、有界传输、时钟与无授权查询；没有假设备效果、活动 grant 或成功占位存储。P0 验收仍为 PENDING。

## 启动和查询

使用 `.node-version` 的 Node 24.21.0 与 pnpm 11.11.0。入口会校验实际 Node 版本并拒绝 `NODE_OPTIONS`、`NODE_PATH`。当前阶段 worktree 可使用本地 `.cache/toolchains/node-v24.21.0-darwin-arm64/bin`；这不是跨机器工具链保证。

```sh
pnpm p0:supervisor --config /absolute/private/runtime.json
pnpm p0:operator --config /absolute/private/runtime.json --command authenticate
pnpm p0:operator --config /absolute/private/runtime.json --command query
```

配置采用 `P0RuntimeConfig`，字段与路径规则见[契约简报](../../docs/generated/P0.md)及[第22.3、22.5、22.6节](../../docs/spec/22-tech-storage-deployment.md)。本包不提供配置、凭据或数据库初始化工具；测试在临时私有目录生成隔离材料。真实配置、密钥和运行数据不得提交。

`supervisor.ts` 校验配置与实际安装文件后，建立管理 socket，再启动 `host.ts`。Host 没有公开命令行配置入口，只接受私有 fd 3 上的 `P0HostBootstrap`。各实例临时私钥经该描述符传送，操作员凭据及核心私钥不会进入 argv、环境或 stdout。子进程只继承实际 Node 所在 PATH 和固定 LANG。端点专用材料已隔离，W4 才创建端点进程。

CLI 使用受控凭据和目标 socket 对应的 `P0PeerIdentity` 文件，验证签名公告后，经同一管理入口执行 `operator.authenticate` 或 `session.query`。每条命令新建连接并使用一次挑战；`test_operator` 不绕过认证。stdout 输出服务端实际 RPC id 和经 Schema 校验的完整成功回包；失败只在 stderr 输出固定错误码并非零退出，不输出证明或凭据。

## 所有权和失败边界

Supervisor 拥有其管理 socket、身份文件和 Host 生命周期；Host 拥有自己的管理 socket 和身份文件。运行目录、文件权限、UID、符号链接和已有冲突均在启动时检查；退出只清理由本实例登记的 inode。进程退出事件表示进程生命周期事实，不能作为设备停止、效果或清理证明。

查询返回 `P0SessionSnapshot`：初始 supervision 为 `stopped`，grants 为空，持久化 `blocked`，端点事实为空且质量 `unknown`。端点实例号是待启动身份，不能据此声称端点已经运行。Host 的心跳只更新监督的连接观察，不创建授权或延长人工租约。W3 只使用初始代次 0。

`session.authorize`、`session.execute` 与 `supervisor.register_effect` 在真实持久化尚未接入时拒绝；停止、续租和故障注入尚未接通时明确返回未就绪。当前进程关闭是入口资源清理，不是 StopOperation 或设备清理实现。重启重新生成会话及实例，不能恢复旧权；持久化缺口与未知资源隔离的完整行为留待 W6。

## 实际覆盖

`tests/p0-identity.test.ts` 启动真实 Supervisor、Host 和 CLI，覆盖认证查询、伪造操作员、旧挑战、时钟错误、畸形/超长 socket 帧及存储未就绪的执行拒绝。stdio 测试入口是明确合成的协议 fixture，只运行真实身份和传输模块，不是 W4 假设备。SDK 语义反例在 `tests/schema.test.ts`。

```sh
node --test tests/p0-identity.test.ts tests/schema.test.ts
pnpm check
```

真实 Unix socket 测试需要允许本机监听的执行环境；限制 socket 的沙箱会返回 EPERM，不能替换成内存测试。执行日志位于阶段 worktree 的 `reports/p0/w3/`。以上是 W3 中间覆盖，不提升任何 `sut.*` 或 `exit.P0`；完整状态机、有限效果、独立停止、Outbox 和重启故障必须由 W4–W7 的真实链路补齐。
