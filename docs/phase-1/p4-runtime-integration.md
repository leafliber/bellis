# P4 开发文档：Runtime 集成、故障验证与 Phase 1 Demo

> 任务编号：Phase 1 / P4
> 前置 Gate：P1、P2、P3 已通过 Gate 2 并合入
> 建议分支：`codex/phase1-runtime-integration`
> 文件所有权：`apps/runtime/**`、Phase 1 Demo、跨包 E2E/故障 Harness、必要的根脚本与 CI
> 上位规范：[Phase 1 构建指导](../phase-1-build-guide.md) 第 8、9、11、13.5、14–19 节

## 1. 任务目标

只通过 P1、P2、P3 的包根公开 API，组装可运行的 loopback Fastify Runtime，完成认证、REST、Control/Media WS、持久化提交、Outbox 发布、恢复和真实 Crash Window Demo。

P4 是集成任务，不是补做组件内部实现。若公开 API 不足，应回到对应包提交最小接口变更，不得从 Runtime 跨包导入 `src` 私有路径。

本任务结束时必须具备：

- Fastify Bootstrap、配置校验、生命周期和依赖装配。
- Loopback Host/Origin/Session 安全边界。
- Health、Ready、Version、Auth Exchange、OpenAPI 3.1。
- `/ws/v1/control` 与 `/ws/v1/media` 的 P1 Adapter。
- 仅用于 Phase 1 验证的 Fake Scene Commit Application Service。
- 先数据库 Commit、后 Control 发布的严格顺序。
- Outbox Dispatcher 编排、优雅关闭和崩溃恢复。
- 跨包 E2E、故障/恢复测试与双平台 CI。
- 可重复、无公网依赖的 `pnpm demo:phase1`。
- 给 Phase 2 的公开接口清单。

## 2. 明确不做

- 不实现真实 LLM、Prompt、Decision Loop、Tool Runtime 或 Audience Batcher。
- 不实现真实 TTS、音频编码、Stage、Live2D、Avatar、Overlay 或 Game。
- 不把领域逻辑写进 Fastify Route/Hook。
- 不让 Runtime 直接执行 SQL 或导入 P1/P2/P3 私有模块。
- 不添加生产 Fault Route、万能 Debug API 或绕过认证的本地后门。
- 不绑定 `0.0.0.0`，不在端口冲突时随机开放局域网端口。
- 不访问公网，不要求外部 Provider。

## 3. 开工门槛

P4 开工前，集成负责人必须记录 P1/P2/P3 的 Gate 2 Commit，并运行：

```bash
pnpm --filter @bellis/transport test
pnpm --filter @bellis/transport test:integration
pnpm --filter @bellis/persistence test
pnpm --filter @bellis/persistence test:integration
pnpm --filter @bellis/observability test
pnpm --filter @bellis/testkit test
pnpm check
pnpm build
```

同时确认：

- P1 暴露框架无关 Control/Media API、Replay Gap Effect 和关闭方法。
- P2 暴露 Session 创建/确认、Scene Commit、Server Seq、Recovery、Outbox 和关闭方法。
- P3 暴露 Trace、Pino Logger、Metrics 工厂和测试设施。
- 生产依赖没有 Testkit。
- 三个包的协议文档与实现一致。

任何缺口先回包内修复并重过 Gate 2。P4 不维护临时替代实现。

## 4. 推荐目录

```text
apps/runtime/
  src/
    application/
      commit-fake-scene.ts
      recovery.ts
      outbox-publisher.ts
    bootstrap/
      config.ts
      dependencies.ts
      lifecycle.ts
      server.ts
    auth/
      startup-token.ts
      local-session.ts
    routes/
      health.ts
      version.ts
      auth.ts
      openapi.ts
    websocket/
      control-adapter.ts
      media-adapter.ts
    errors/
      mapping.ts
    index.ts
  test/
    unit/
    integration/
    e2e/
    fixtures/

scripts/
  phase-1-demo.mjs
  phase-1-demo-child.mjs       # 如需私有父子进程入口
```

Route 只做边界校验、调用 Application Service 和响应映射；业务事务顺序在 `application/**`。

## 5. 依赖与配置

### 5.1 生产依赖

- Fastify 必须是 `apps/runtime` 的生产 dependency，而不是只放 devDependency。
- WebSocket、Cookie/OpenAPI 等插件必须与 Fastify 5 基线兼容、精确锁定并说明用途。
- Runtime 生产依赖可以包含 Contracts、Observability、Transport、Persistence。
- `@bellis/testkit` 只能是 devDependency。
- 新依赖不得引入第二个 DI 容器、ORM、Agent Runtime 或通用消息总线。

### 5.2 配置 Schema

至少配置：

```text
host = 127.0.0.1
port = 17890
allowedHosts
allowedOrigins
dataDirectory（必填绝对路径）
runtimeVersion
buildInfo
startupTokenTtlMs
sessionCookieName
heartbeat/replay/queue/media limits
shutdownGraceMs
```

要求：

- 生产启动时配置先校验，输入类型为 `unknown`。
- Host 默认且只允许 loopback；如未来开放 LAN 必须独立安全决策。
- 数据目录不默认为仓库相对路径。
- Token、Cookie 和密钥配置不进入日志或 Version/OpenAPI 响应。
- 测试可注入随机空闲端口，但正式默认仍是 17890。

## 6. 生命周期

### 6.1 启动顺序

```text
解析并校验配置
  → 创建 Logger / Metrics / Runtime Instance ID
  → 创建 Persistence Client / DB Worker
  → migrate()
  → 读取恢复状态并恢复旧 Outbox Lease
  → 注册 Application Service
  → 注册 REST / Control / Media 边界
  → 开始 loopback Listen
  → ready = true
```

规则：

- `live` 表示进程存在，不等于依赖 Ready。
- Migration、Worker、协议注册或恢复失败时 `ready=false`。
- Ready 前的业务请求返回稳定 `not_ready`，不能进入事务。
- 端口占用时明确失败和退出，不改绑 `0.0.0.0` 或随机正式端口。
- 启动部分失败必须逆序清理已经创建的资源。

### 6.2 关闭顺序

```text
ready = false / draining
  → 停止接受新 HTTP Upgrade 和状态变更
  → 通知 Control 连接 draining
  → Abort Application 子任务
  → Outbox Dispatcher 停止 Claim 新任务
  → Grace Period 内结束/释放当前 Batch
  → 关闭 Media / Control 连接
  → 关闭 Persistence Client / DB Worker
  → Flush Logger / Metrics
  → Fastify close
```

关闭应幂等，可处理重复信号和启动中关闭。测试必须确认没有 Worker、Timer、Socket、文件句柄或未处理 Promise 泄漏。

## 7. REST API

### 7.1 `GET /api/v1/health/live`

- 只证明进程可响应。
- 不访问数据库，不执行昂贵检查。
- 返回稳定小型 JSON 和 200。

### 7.2 `GET /api/v1/health/ready`

- Migration、DB Worker、恢复和协议注册完成后返回 200。
- 未完成或正在 Draining 返回 503 和安全的 `not_ready`。
- 不返回数据库路径、异常 Stack 或内部拓扑。

### 7.3 `GET /api/v1/version`

返回应用版本、Control/Media 协议版本、构建 Commit/时间和 Runtime Instance ID（若确认安全）。不得返回 Token、路径或环境变量。

### 7.4 `POST /api/v1/auth/exchange`

- Startup Token 从请求 Body 或授权头接收，绝不放 URL Query。
- Token 至少 256-bit 随机、短期、单次使用。
- 比较使用安全策略；成功或失败都不记录原值。
- 成功后创建/确认本地 Session，并设置 `HttpOnly`、`SameSite=Strict`、限定 Path 的 Cookie。
- 同一 Token 第二次交换失败。
- 过期、未知、错误 Host/Origin 的交换返回统一安全错误，避免泄露 Token 状态。
- 测试通过 Fixture 注入；开发启动打印时也必须避免进入持久日志。

### 7.5 `GET /api/v1/openapi.json`

- OpenAPI 3.1。
- 请求/响应 Schema 来源于 Contracts 或同一 Zod 源，不复制手写 JSON Schema。
- 文档只包含实际注册的 Phase 1 REST 接口。
- WebSocket 协议通过链接/扩展指向三份协议文档，不伪装成普通 REST。

## 8. Host、Origin 与 Session

- 只接受配置允许的 loopback Host；处理 Host 端口但拒绝欺骗值。
- REST 和 WS Upgrade 都执行 Origin Allowlist；缺失 Origin 的非浏览器测试客户端需走明确配置，而不是默认全放行。
- Control/Media 都要求已认证 Session Cookie。
- Media Stream 的 Session 必须与对应 Control 注册一致。
- Cookie、Startup Token、完整授权头不进入 Trace、Session Record、Outbox 或错误详情。
- 未授权、跨 Session、过期 Session 和伪造 Cookie 有集成测试。

## 9. Control WebSocket Adapter

路径：`/ws/v1/control`。

P4 只负责 Socket 边界和 Application Effect 映射：

```text
HTTP Upgrade 校验
  → 从 P2 读取/确认逻辑 Session 与 latestServerSeq
  → 创建 P1 ControlSession
  → server.hello
  → client.hello
  → Replay 或 session.snapshot
  → active typed messages
```

要求：

- 入站文本先经过 P1 完整校验，不在 Route 中 `JSON.parse as Type`。
- P1 产生的 Seq 推进通过 P2 单调持久化接口保存。
- Replay Gap 时由 P2 `readRecoveryState` 构造 `Phase1SessionSnapshot`。
- Snapshot 的 `activeScene` 恒为 `null`，`openMediaStreams` 恒为空。
- 未知消息、错误方向、过期 Deadline 和重复 Message 走稳定错误映射。
- 慢连接由 P1 背压 Effect 关闭，不阻塞其他连接。
- Scene 消息只服务 Fake Commit 验证，不触发 TTS/Avatar/Game。

## 10. Binary Media WebSocket Adapter

路径：`/ws/v1/media`。

- Upgrade 复用已认证 Session。
- Stream 必须先通过同 Session 的 Control `media.stream.open` 注册。
- 只接受 Binary；Text Frame 明确拒绝。
- 二进制内容完全交给 P1 Parser/Registry，不在 Adapter 重写协议。
- Phase 1 只传随机测试字节，成功只表示 Frame 被验证/接收。
- 大 Media 压力下，Control 心跳和取消仍可运行。
- 连接关闭释放全部 Parser Buffer 和 Stream；重连后重新注册。

## 11. Fake Scene Commit Application Service

P4 提供一个只用于协议验证的最小用例。输入来自受认证、通过 Contracts 校验的测试命令或内部 Demo 调用，不建立真实模型循环。

建议顺序：

```text
验证 Fake Scene / Cues / Watermarks / Outbox
  → 检查 Deadline / Abort
  → 发布 scene.prepared（仅协议事件，无外部效果）
  → P2 commitScene
  → Commit 成功
  → 发布 scene.committed
  → Outbox Dispatcher 异步交付
```

不可破坏的不变量：

- `scene.committed` 绝不能早于数据库 Commit。
- Commit 失败或 Abort 不发布 committed。
- 同一幂等键重试返回第一次结果，不生成第二个逻辑 Scene/Record/Outbox。
- 同 Key 不同摘要返回冲突，不覆盖旧结果。
- Trace ID 贯穿 Control、Application Service、Worker RPC、Session Record、Outbox 和日志。
- Fake Scene 不产生 TTS、Avatar 或游戏副作用。

如果 Phase 1 Contracts 没有公开“提交 Fake Scene”入站消息，优先让 Demo 通过内部 Application Service Port 调用；不要擅自把测试专用命令加入生产协议。若产品确需外部命令，先走 Contracts/ADR 变更。

## 12. Outbox 编排

- Dispatcher 在 Ready 后启动，关闭时先停止 Claim。
- Claim 使用有界 Batch 和当前 Runtime Instance ID。
- 发布者按 Topic 白名单分发；未知 Topic 进入安全失败/Dead 策略。
- 成功后 `completeOutbox`；可重试失败调用 `retryOutbox`。
- 消费者以 `outboxId` 或业务幂等键去重。
- 发布成功但标记前崩溃允许重复交付，不能宣传 Exactly Once。
- P4 的 Phase 1 测试发布者只记录已脱敏、可审计的内存结果，不访问公网。

## 13. 错误映射

建立一个集中映射层，把 Transport/Persistence/Auth/Application 错误转换成 Contracts `ErrorEnvelope`：

- 客户端可修复输入 → `invalid_message`。
- 协议主版本 → `unsupported_version`。
- 身份/Session → `unauthorized`。
- Deadline → `deadline_exceeded`。
- 慢连接 → `backpressure`。
- 启动/迁移/恢复未完成 → `not_ready`。
- 未知内部故障 → `internal_error`。

错误 Message 供人阅读但不能被客户端当机器码。`details` 只含安全、JSON-safe、低敏字段。所有内部错误保留 `cause` 到脱敏本地日志，不返回 Stack、SQL、Token、Cookie 或绝对路径。

## 14. 跨包测试

### 14.1 REST/Auth

- Live/Ready 的启动、失败、Draining 状态。
- Version/OpenAPI 与实际 Route 一致。
- Startup Token 成功一次、重复、过期、并发交换。
- Host/Origin/Cookie/Session 合法和非法组合。
- Runtime 只绑定 loopback。

### 14.2 Control/Media

- Hello、ACK、Heartbeat、Clock、重连、Replay 和 Replay Gap Snapshot。
- WS 在 ACK 前断线；重连使用原 Seq/Message ID 重放。
- 状态变更在不确定状态下用同一幂等键重试。
- Stream 注册、合法帧、非法帧、大小限制和重连重开。
- Media 压力下 Control 仍响应。

### 14.3 Persistence/Recovery

- Migration 失败时 Ready 保持 false。
- Scene Commit 成功、回滚、重复、冲突。
- Commit 前终止。
- Commit 后、Outbox 发布前终止。
- 发布后、Delivered 前终止。
- Outbox Lease 期间终止。
- 重启恢复 Scene/Watermark/Seq，旧 Stream 不恢复。
- DB 批量操作期间 Health 仍响应。

故障测试必须使用 P2 的私有 IPC 检查点和真正的子进程/Worker 强制终止，不得通过生产 HTTP/WS Fault Route。

## 15. Phase 1 Demo

`pnpm demo:phase1` 必须自动执行：

1. 创建系统临时数据目录。
2. 启动 Runtime 子进程并等待 Ready。
3. 用一次性 Token 交换 Session Cookie。
4. 连接 Control WS，完成 Hello 和一次 Clock Sync。
5. 注册 `binary-test` Media Stream，发送一个合法随机字节帧并确认接收。
6. 通过测试装配调用 Fake Scene Commit，携带 Speech/Avatar Cue、Watermark 和 Outbox。
7. 只在数据库 Commit 后观察到 `scene.committed`。
8. 在 `after_scene_transaction_commit_before_outbox_dispatch` 检查点强制终止 Runtime。
9. 使用同一数据目录启动新的 Runtime Instance。
10. 确认 Scene/Watermark/Server Seq 恢复，Outbox 重新交付。
11. 使用相同幂等键重放 Commit，确认没有第二个逻辑结果。
12. 输出同一 Trace ID 的关键事件摘要。
13. 正常关闭，清理临时目录、Cookie、Socket 和子进程。

成功输出至少逐行包含：

```text
protocolVersion=1
controlHandshake=ok
clockSync=ok
mediaFrame=accepted
sceneCommit=durable
watermark=restored
outboxRecovery=ok
idempotency=ok
traceContinuity=ok
```

要求：

- 任一步失败非零退出。
- 不捕获错误后仍打印 ok。
- 不访问公网，不依赖真实 Provider。
- 默认输出简洁；失败输出安全、可复现的阶段和错误码。
- 成功/失败都清理临时资源。

## 16. CI 与根脚本

- `pnpm check` 必须包含新增单元和集成测试，不能依赖本地已有构建产物。
- `pnpm build` 从干净 Checkout 生成所有包和 Runtime。
- Windows 11 / macOS 使用 Node 26.5.0、同一 lockfile 和相同断言。
- CI 运行 `pnpm demo:phase1`，或设置独立、等价且不跳过 Crash 恢复的 Demo Job。
- CI 超时合理，失败时上传脱敏诊断，不上传数据库中的敏感 Payload。
- 根脚本不以 `|| true`、忽略退出码或空占位绕过失败。

## 17. Phase 2 移交清单

P4 交付说明必须列出：

- Contracts 中可供 Fake Signal/ActionFrame/Scene/Cue 使用的入口。
- Transport 中 Clock、Stage 连接、Prepare/Ready/Commit 扩展可复用的入口。
- Persistence 的 Commit/Recovery/Outbox 能力和版本边界。
- Observability 的 Trace/Logger/Metrics 使用方式。
- Runtime Application Service 的依赖注入与新增用例位置。
- Phase 1 Snapshot 的固定限制：`activeScene=null`、Media Stream 不恢复。
- Phase 2 仍需新增/版本化的协议，不允许在 Phase 1 暗中预实现。

## 18. 验收命令

```bash
pnpm --filter @bellis/runtime typecheck
pnpm --filter @bellis/runtime lint
pnpm --filter @bellis/runtime format:check
pnpm --filter @bellis/runtime test
pnpm --filter @bellis/runtime test:integration
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm demo:phase1
```

随后按 [任务索引](./README.md) 第 8 节完成人工 Gate 3 核查。

## 19. 拒绝合入条件

- P1/P2/P3 未过 Gate 2 就在 Runtime 复制临时实现。
- Route Handler 执行事务、SQL、Replay 或领域状态机。
- Runtime 导入其他包的 `src` 私有路径。
- 绑定非 loopback、放宽 Host/Origin、Token 出现在 URL/日志。
- Ready 在 Migration/Recovery 前变 true。
- 数据库 Commit 前发布 `scene.committed`。
- Fake Scene 产生真实 TTS/Avatar/Game 副作用。
- 用正常 Close 冒充 Crash，或用生产 Fault Route 注入故障。
- Snapshot 声称恢复 Active Scene/Media Stream。
- 错误泄露 Stack、SQL、Cookie、Token、绝对路径。
- Demo 捕获失败仍打印 ok、访问公网、依赖本地残留状态或不清理资源。
- CI 跳过 Windows/macOS、恢复测试或 `demo:phase1`。

## 20. 可直接交给 Agent 的任务提示

```text
你负责 Bellis Phase 1 的 P4 Runtime Integration。只有 docs/phase-1/README.md 的 Gate 2 已通过、P1/P2/P3 Commit 已合入后才能开工；完整任务见 docs/phase-1/p4-runtime-integration.md。先记录三项 Gate 2 Commit 并运行第 3 节命令。只通过 @bellis/transport、@bellis/persistence、@bellis/observability 的包根公开 API 组装 apps/runtime；接口不足时回对应包做最小受审查变更，禁止跨包导入 src。实现 loopback Fastify Bootstrap、配置/生命周期、Health/Ready/Version/Auth Exchange/OpenAPI、Control/Media WS Adapter、只用于协议验证的 Fake Scene Commit、数据库 Commit 后发布、Outbox 编排、优雅关闭和真实 Crash 恢复。完成跨包 E2E 与私有 IPC 检查点故障测试，把 scripts/phase-1-demo.mjs 从显式失败占位替换为真正的提交→强制终止→重启→恢复 Demo；不接真实 LLM/TTS/Live2D/Game，不加生产 Fault Route，不访问公网。运行文档第 18 节全部命令，按 README 第 9 节报告启动方式、公开接口、恢复证据、Phase 2 移交清单、风险、分支和 Commit。
```
