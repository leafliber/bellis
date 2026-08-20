# P2 开发文档：SQLite Worker、Session Records、事务、Outbox 与恢复

> 任务编号：Phase 1 / P2
> 前置 Gate：P0 / Gate 1 已合入
> 建议分支：`codex/phase1-persistence`
> 文件所有权：`packages/persistence/**`、持久化协议文档
> 上位规范：[Phase 1 构建指导](../phase-1-build-guide.md) 第 6、7、9、11、12、13.3 节 · [ADR 0002](../adr/0002-node-26-baseline.md)

## 1. 任务目标

实现只通过类型化 Worker RPC 访问 `node:sqlite` 的持久化层，并用真实进程/Worker 终止证明 Scene Commit、Signal Watermark、Session Record 和 Outbox 的原子性与恢复语义。

本任务结束时必须具备：

- DB Worker 与类型化、版本化 RPC Client。
- `state.db` / `telemetry.db` 初始化和有 checksum 的前向 Migration。
- Session、Session Record、Signal Watermark、Scene、Idempotency 与 Outbox Repository。
- 原子 `commitScene`。
- 至少一次 Outbox Dispatcher 状态机、Lease、退避、Dead Letter 和重启恢复。
- 生产 No-op + 测试私有 IPC 的 `PersistenceCheckpointObserver`。
- 单元、性质、集成和真实 Crash Window 测试。
- `docs/protocols/persistence-and-recovery.md`。

## 2. 明确不做

- 不在主线程导入或调用 `node:sqlite`。
- 不引入 ORM、Redis、Kafka、NATS、PostgreSQL 或通用 Repository 框架。
- 不允许任意 SQL 字符串穿过 Worker RPC。
- 不实现 Control WS、Fastify Route 或真实 Scene 执行。
- 不建立生产 Fault Route、调试端口或可由普通环境变量开启的故障注入。
- 不承诺 Exactly Once；Outbox 是 At Least Once，消费者负责幂等。
- 不用纯 Mock Repository 代替真实 Worker/SQLite 恢复测试。

## 3. 开工步骤与接口审查

1. 从 Gate 1 Commit 创建分支和独立 worktree。
2. 阅读 `packages/persistence/src/index.ts`、Session/Outbox/Scene Contracts 和 `runtime:check` Worker 脚本。
3. 运行 [任务索引](./README.md) 第 4 节共同检查。
4. 在主体实现前提交 Gate 1.1 公开 API 清单。
5. 增加真实的 `test` 和 `test:integration` 脚本。

当前 Port 存在需要在 Gate 1.1 明确的实际缺口：

### 3.1 Session 生命周期

`commitScene` 要求 Session 已存在，但当前 `PersistenceClient` 没有创建/确认 Session 的方法。建议以兼容新增方式提供类型化操作，例如：

```ts
interface EnsureSessionInput {
  sessionId: string;
  createdAtMs: number;
  trace: TraceContext;
}

ensureSession(input: EnsureSessionInput): Promise<void>;
```

重复调用必须幂等；同一 ID 的不兼容元数据必须明确冲突。

### 3.2 Scene Payload

当前 `CommitSceneInput` 只有 `sceneId/cycleId`，但规范要求 `scenes.payload_json` 写入经过 Schema 验证的版本化 Payload。推荐兼容新增：

```ts
interface CommitSceneInput {
  // 保留现有字段
  readonly scene: Scene;
}
```

Worker 必须验证 `scene.sceneId === sceneId`、`scene.cycleId === cycleId`，并用 `SceneSchema` 验证后写入。不得写入未验证的任意对象，也不得只保存空 `{}` 假装完成。

### 3.3 服务端序号恢复

`RecoveryState.latestServerSeq` 已存在，但没有推进方法。P2 应提供单调推进操作，例如：

```ts
advanceServerSeq(input: {
  sessionId: string;
  latestServerSeq: bigint;
  trace: TraceContext;
}): Promise<bigint>;
```

序号只能前进，持久化时使用无损表示。P4 用它保持逻辑 Session 重连后的服务端 Seq 连续性。

上述签名需经集成负责人确认。对既有字段做破坏性修改或改 Contracts 必须按 README 第 5 节走变更流程。

## 4. 推荐目录

```text
packages/persistence/
  src/
    client/
      persistence-client.ts
      rpc-channel.ts
    worker/
      entry.ts
      rpc-router.ts
      database.ts
      operations/
    migrations/
      state/
        0001_initial.sql
      telemetry/
        0001_initial.sql
      runner.ts
    repositories/
      sessions.ts
      session-records.ts
      scenes.ts
      watermarks.ts
      idempotency.ts
    outbox/
      repository.ts
      dispatcher.ts
      retry-policy.ts
    checkpoints/
      observer.ts
    errors.ts
    index.ts
  test/
    unit/
    integration/
    fixtures/
  vitest.config.ts

docs/protocols/
  persistence-and-recovery.md
```

只有 `src/worker/**` 可以静态导入 `node:sqlite`。Migration Runner 如果直接调用 SQLite，也必须实际运行在 Worker 内；文件所在目录不能成为绕过边界的理由。

## 5. Worker RPC

### 5.1 Envelope

内部 RPC 至少包含：

```ts
interface PersistenceRpcRequest {
  version: 1;
  requestId: string;
  operation: PersistenceOperation;
  deadlineUs?: string;
  trace: TraceContext;
  payload: JsonValue;
}

interface PersistenceRpcResponse {
  version: 1;
  requestId: string;
  ok: boolean;
  payload?: JsonValue;
  error?: SafePersistenceError;
}
```

要求：

- Client 和 Worker 两侧都校验 Envelope 与具体 Operation Payload。
- Operation 是闭合判别联合，不接受任意方法名或 SQL。
- `requestId` 关联响应；未知、重复或迟到响应稳定处理。
- Deadline 在开始事务前检查；事务开始后按操作的原子性策略完成或回滚。
- TraceContext 显式随请求传播。
- Worker 崩溃时所有在飞 Promise 以同一稳定错误结束，Client 进入不可用状态直到明确重建。
- `close()` 停止接收新请求、处理或取消在飞请求，并最终终止 Worker。
- 错误返回安全码和可重试性，不包含 SQL、数据库绝对路径或原始敏感 Payload。

### 5.2 事件循环隔离

必须有集成测试在 Worker 执行批量写入/查询时持续采样主线程响应，证明主事件循环没有同步执行 SQLite。静态测试同时扫描 `packages/persistence/src`，确保 Worker 目录外不存在 `node:sqlite` 导入。

## 6. 数据库初始化与 Migration

### 6.1 数据库位置

- 数据目录必须由调用方显式传入绝对路径。
- 不提供“当前工作目录/data”之类可能污染仓库的生产默认值。
- 测试使用 Testkit 临时目录或系统临时目录，并在成功/失败后清理。
- `state.db` 使用 `synchronous=FULL`；`telemetry.db` 使用 `synchronous=NORMAL`。
- 两者都启用 WAL、Foreign Keys、`busy_timeout=3000`。

### 6.2 Migration 规则

- 文件名按固定宽度版本号排序，例如 `0001_initial.sql`。
- Migration 内容计算 SHA-256 checksum 并写入 `schema_migrations`。
- 单个 Migration 在事务中执行。
- 重复 `migrate()` 幂等。
- 已应用版本 checksum 改变时拒绝启动。
- 版本缺口、重复版本、降级或未知已应用版本明确失败。
- 失败时 Client 不进入 Ready；部分 DDL/DML 不得留在已完成状态。
- 已合入 Migration 不允许原地改写，后续变更新增文件。

构建必须确保 SQL 文件进入包产物；不能只在源码目录运行时可用。

## 7. state.db Schema

至少建立：

```text
schema_migrations
sessions
session_records
signal_watermarks
scenes
outbox
idempotency_keys
```

实现约束：

- 所有 ID 存为 TEXT，保留 Contracts 形式。
- Watermark、Server Seq、Aggregate Seq 使用无损十进制 TEXT 或经测试的 SQLite BigInt 策略；读写不得经过 JS `number`。
- JSON 使用 UTF-8 TEXT，写入前通过对应 Schema，读取后再次校验版本。
- `committed_at_ms` 是审计墙钟，不用于恢复排序。
- `commitAtRuntimeUs` 不写入 `state.db`。
- 唯一索引必须覆盖 Scene ID、幂等作用域/Key、Session Record 的聚合序号以及 Outbox ID。
- 外键和删除策略必须显式；Phase 1 不做隐式级联清理历史事实。

`telemetry.db` 可以只建立最小 Migration/索引底座；不得让遥测写入参与 `state.db` 事务或影响 Ready 的核心恢复事实。

## 8. Repository 语义

### 8.1 Session Records

- Append-only，不更新原记录 Payload。
- `SessionRecordSchema` 校验通过后才能写入。
- 同一 Aggregate 的 `aggregateSeq` 单调且唯一。
- 读到未知 `schemaVersion` 返回兼容性错误，不盲转当前类型。
- Trace ID、Session ID 和 Aggregate ID 可索引查询。

### 8.2 Signal Watermark

- 按 `(session_id, source)` 唯一。
- 只允许前进；相等是幂等，倒退明确拒绝。
- 比较在无损整数域完成。
- 多个 Source 在 `commitScene` 的同一事务内一起推进或全部回滚。

### 8.3 Idempotency

- Key 必须带作用域，不能全库裸唯一。
- 保存请求摘要、结果引用和必要的生命周期信息。
- 同 Key + 同摘要返回第一次结果，标记 `duplicate: true`。
- 同 Key + 不同摘要返回不可重试冲突。
- 并发相同请求只能产生一个逻辑 Commit。
- 请求摘要必须基于稳定、明确的输入；若由调用方提供，P2 仍需验证格式并在协议文档写明信任边界。

## 9. 原子 commitScene

事务顺序固定：

```text
BEGIN IMMEDIATE
  → 验证 Session、Scene 和幂等键
  → 处理幂等命中/冲突
  → 插入 scene_committed Session Record
  → 插入 scenes
  → 单调推进全部 Signal Watermark
  → 插入全部 Outbox Message
  → 写入幂等结果引用
COMMIT
```

必须证明：

- 任一步骤失败全部回滚。
- Outbox 只有 Commit 后才能被 Claim。
- Commit 前的检查点终止后，Scene/Record/Watermark/Outbox/Idempotency 均不存在。
- Commit 后返回结果包含数据库生成的 `committedAtMs`。
- 相同请求重放不创建第二个 Scene、Record 或 Outbox。
- 不同摘要冲突不会改变第一次结果。
- P2 不向 WebSocket 发布任何消息；P4 负责 Commit 成功后的发布顺序。

`scene_committed` Record 的 ID/时间生成策略必须可测试。可注入 ID Generator 和墙钟，但调度/Lease 逻辑不能依赖会倒退的实时墙钟。

## 10. Outbox

### 10.1 状态机

至少支持：

```text
pending → in_flight → delivered
                    ↘ pending（可重试）
                    ↘ dead（不可重试/超限）
```

每次状态转换必须带条件更新，避免两个 Dispatcher 同时领取或完成同一项。

### 10.2 Claim 与 Lease

- Claim 有 Batch 上限，不能一次加载全部 Pending。
- 原子选择到期项并写 `lease_owner_instance_id` / `lease_until_ms`。
- Worker 启动时记录 `bootEpochMs + bootMonotonicUs` 锚点，运行期间用单调增量投影 `leaseNowMs`。
- 同一 Worker 生命周期不直接反复读取 `Date.now()` 判断 Lease。
- 重启后旧 Instance 的 `in_flight` 项立即恢复可领取，不无限等待旧墙钟截止时间。

### 10.3 重试

- 可重试错误使用有上限、带确定性可注入抖动的指数退避。
- 不可重试或超过最大尝试次数进入 `dead`。
- `last_error_code` 只能是稳定安全码。
- 指标记录 Pending、成功、重试和 Dead 数量，不以 Outbox ID 作为 Label。
- Dispatcher 关闭时停止新 Claim，并在 Grace Period 内完成或释放当前小批次。

## 11. 受控检查点与故障注入

公开装配支持可选 `PersistenceCheckpointObserver`，默认 No-op。检查点固定为：

```text
before_scene_transaction_commit
after_scene_transaction_commit_before_outbox_dispatch
after_outbox_publish_before_mark_delivered
```

测试适配器：

- 仅由测试父进程通过继承的私有 IPC 创建。
- 到达检查点后通知父进程并等待 Abort/释放。
- Harness 可在确定位置强制终止 Runtime/Worker。
- 生产入口不导出“启用故障”的便利函数。
- HTTP/WS 没有 Fault Route；普通环境变量不能远程开启。

检查点 Observer 不得改变未启用时的事务顺序和性能语义。

## 12. 测试计划

### 12.1 单元测试

- RPC 编解码、Deadline、未知 Operation、Worker 崩溃和 Close。
- Migration 排序、checksum、重复、缺口、改写和失败回滚。
- Repository Schema 校验和未知版本。
- Watermark/Server Seq 单调性。
- Idempotency 命中、冲突和并发。
- Outbox 状态转换、Lease 和退避。

### 12.2 fast-check 性质测试

- 任意 Watermark 更新序列不会倒退。
- 同一幂等输入任意次数只得到一个逻辑 Commit。
- 不同事务故障点不会留下部分提交。
- Outbox 状态机不会从终态回到可执行态。
- 任意合法大整数经 Worker/SQLite 往返保持等价。

### 12.3 集成与恢复测试

使用真实 Worker、真实临时 SQLite 文件和父子进程，覆盖：

1. Migration 中断和重启。
2. SQLite Busy/Locked 超时。
3. DB Worker 崩溃时 Client 在飞请求失败。
4. Commit 前终止：所有事实不存在。
5. Commit 后、Outbox 发布前终止：重启后重新发布。
6. 发布后、标记 Delivered 前终止：允许重复交付，消费者按 ID 去重。
7. Lease 期间终止：旧 Owner 项在重启后恢复。
8. 相同 Commit 并发/重放：只有一个逻辑结果。
9. 批量数据库工作期间主事件循环保持响应。
10. Close 后没有 Worker、Timer、文件句柄或临时目录泄漏。

每个 Crash 测试都要在父进程确认到达检查点后执行真正的强制终止；普通 `close()` 不算 Crash Window。

## 13. 协议文档要求

`persistence-and-recovery.md` 至少包含：

- Worker 边界、RPC Operation 表和安全错误表。
- 两个数据库的 PRAGMA、Migration 和表结构。
- `commitScene` 事务顺序和幂等语义。
- Watermark/Server Seq 的无损存储与单调规则。
- Outbox 状态机、Lease 时钟投影、重试和 Dead Letter。
- 三个 Crash Window 的时序图和恢复结果。
- 检查点仅测试可用的安全边界。
- P4 必须遵守的初始化、Ready、Commit 后发布和关闭顺序。

## 14. 验收命令

```bash
pnpm runtime:check
pnpm --filter @bellis/persistence typecheck
pnpm --filter @bellis/persistence lint
pnpm --filter @bellis/persistence format:check
pnpm --filter @bellis/persistence test
pnpm --filter @bellis/persistence test:integration
pnpm contracts:check
pnpm build
```

## 15. 拒绝合入条件

- Worker 目录外导入 `node:sqlite`。
- 任意 SQL 穿过 RPC，或 Route/Runtime 能直接执行 SQL。
- 数据库默认写入仓库。
- Watermark、Seq 或微秒值经过 JS `number`。
- 未验证 JSON Payload 就持久化。
- Migration 可被原地改写或 checksum 变化后静默继续。
- `commitScene` 留下部分 Record/Scene/Watermark/Outbox。
- Outbox 声称 Exactly Once、Lease 依赖会倒退的实时墙钟，或队列无界。
- 用 Mock 代替真实强制终止恢复测试。
- 生产可访问 Fault Route、密钥/SQL/绝对路径进入日志或错误。
- 测试脚本为空成功、临时 DB/Worker/句柄泄漏。

## 16. 可直接交给 Agent 的任务提示

```text
你负责 Bellis Phase 1 的 P2 Persistence。基线和执行规则见 docs/phase-1/README.md，完整任务见 docs/phase-1/p2-persistence.md。先完成共同检查和 Gate 1.1 API 充分性审查，重点解决 Session 创建、完整 Scene Payload、latestServerSeq 单调持久化三个已知缺口；只修改 packages/persistence/** 和 docs/protocols/persistence-and-recovery.md。node:sqlite 只能在 DB Worker 内导入，主线程只走版本化类型化 RPC。实现 state.db/telemetry.db、带 checksum 的 Migration、Session Records、Watermark、幂等、原子 commitScene、Outbox Claim/Lease/重试/Dead Letter/恢复，以及生产 No-op、测试私有 IPC 的 PersistenceCheckpointObserver。使用真实 Worker、临时 SQLite 和父子进程强制终止覆盖三个 Crash Window，不用 Mock 冒充恢复。运行文档第 14 节全部命令，并按 README 第 9 节报告公开 API、Schema/事务边界、恢复证据、风险、分支和 Commit。
```
