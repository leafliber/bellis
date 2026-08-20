# Persistence & Recovery 协议（P2）

> 适用范围：`packages/persistence`（DB Worker、Migration、Session Records、
> 原子 commitScene、Outbox、恢复）。
> 上位规范：[Phase 1 构建指导](../phase-1-build-guide.md) §9 ·
> [P2 任务文档](../phase-1/p2-persistence.md) ·
> [ADR 0002](../adr/0002-node-26-baseline.md)。

## 1. Worker 边界

- `node:sqlite` 只允许在 `packages/persistence/src/worker/database.ts` 静态导入。
- 主线程（Runtime、Route、Dispatcher）只通过 `PersistenceClient` 的版本化
  类型化 RPC 访问持久化能力；任何 SQL 字符串不得穿过 Worker 边界。
- Worker 崩溃时所有在飞 Promise 以同一稳定错误（`unavailable`）结束，
  Client 进入不可用状态，直到调用方销毁并重建。
- Repository 代码不导入 `node:sqlite`：它依赖中性 `SqliteDatabase` /
  `SqliteStatement` 接口（§5），真实实现由 Worker 注入；因此单元测试
  可以在主线程内联验证 Repository 语义，而真实 SQLite 行为在 Worker
  集成测试中验证。

## 2. Gate 1.1 公开 API 清单

对 Gate 1 冻结 Port 的**兼容新增**（无破坏性修改，未触碰 Contracts）：

| 变更 | 说明 |
| --- | --- |
| `ensureSession(input)` | 创建/确认 Session；重复调用幂等；同 ID 不同 `createdAtMs` 返回 `session_conflict`。`commitScene`/`appendRecord` 依赖 Session 已存在。 |
| `CommitSceneInput.scene` | 完整版本化 `Scene`（`SceneSchema`）。Worker 校验 `scene.sceneId === sceneId`、`scene.cycleId === cycleId` 后写入 `scenes.payload_json`。 |
| `advanceServerSeq(input)` | `RecoveryState.latestServerSeq` 的单调推进：相等幂等返回当前值；倒退返回 `seq_regression`。P4 用它保持重连后服务端 Seq 连续。 |
| `CompleteOutboxInput.ownerInstanceId` / `RetryOutboxInput.ownerInstanceId` | Outbox 状态转换改为条件更新，只有当前 Lease 持有者能完成/重试。 |
| `listRecords(input)` | 按 Session/Trace/Aggregate 的索引查询（`session_records` 三索引）。 |
| `readOutboxStats()` | 按 status 计数，供 Dispatcher/监控使用；不暴露单条内容。 |
| `createPersistenceClient(options)` | 公开装配工厂（数据目录、Worker 注入、检查点观察器、重试策略、可注入 ID/墙钟）。公开 Options 不含任何 SQL 通道；实现只从**内部第二参数**读取 Migration 注入（`createPersistenceClientForTesting(options, overrides)`，不从包根导出且 package.json exports 仅暴露 "."），向公开 options 附加 `migrations` 属性（JS 绕过类型）会被忽略。 |
| `createOutboxDispatcher(options)` | Outbox 消费侧编排（Claim→Publish→Complete/Retry + 指标 + 优雅关闭）。 |
| `PersistenceCheckpointObserver` | 见 §9；生产默认 No-op。 |

## 3. RPC 协议

### 3.1 Envelope

```ts
interface PersistenceRpcRequest {
  version: 1;
  requestId: string;            // UUID v4，关联响应
  operation: PersistenceOperation;
  deadlineUs?: string;          // 规范十进制字符串；事务开始前检查
  trace: TraceContext;          // 显式随请求传播
  payload: JsonValue;           // 由 Operation 的 Zod Schema 双侧校验
}

interface PersistenceRpcResponse {
  version: 1;
  requestId: string;
  ok: boolean;
  payload?: JsonValue;
  error?: SafePersistenceError; // { code, message, retryable }
}
```

两侧职责：

- Client 在发送前校验请求 Payload；Worker 在分发前再次校验 Envelope 与
  Payload，任一失败返回 `invalid_request`，不执行任何 SQL。
- `requestId` 关联响应；未知或迟到的响应被丢弃并记录诊断事件，不影响
  其他在飞请求。
- Deadline 在开始事务前检查（超时返回 `deadline_exceeded`）；事务一旦
  开始，按该操作的原子性策略**完成或整体回滚**，不受 Deadline 打断。
- `close()` 停止接收新请求、拒绝/取消在飞请求，并最终终止 Worker。

### 3.2 Operation 表（闭合判别联合）

| operation | Payload 摘要 | 结果 | 说明 |
| --- | --- | --- | --- |
| `ping` | `{}` | `{pongMs}` | 健康探测。 |
| `migrate` | `{}` | `{requeuedInFlight}` | 两个数据库跑 Migration（幂等）；首次 migrate 顺带完成 Worker 启动恢复（§8.1）。 |
| `ensure_session` | `{sessionId, createdAtMs}` | `{}` | 幂等创建/确认。 |
| `append_record` | `{record}` | `{record}` | 追加 Session Record（Schema 校验 + 聚合序号唯一）。 |
| `commit_scene` | `{sceneId, cycleId, sessionId, scene, idempotencyKey, requestFingerprint, watermarks, outbox}` | `{sceneId, committedAtMs, duplicate}` | §7 原子事务。 |
| `advance_server_seq` | `{sessionId, latestServerSeq}` | `{latestServerSeq}` | 单调推进，返回落库后的当前值。 |
| `read_recovery_state` | `{sessionId}` | `{latestServerSeq, signalWatermarks, lastCommittedScene}` | Session 不存在 → `session_not_found`。 |
| `list_records` | `{sessionId?, traceId?, aggregateId?, limit?}` | `{records[]}` | 索引查询；读到未知 `schemaVersion` → `record_version_unknown`。 |
| `claim_outbox` | `{limit, leaseMs, ownerInstanceId}` | `{messages[]}` | 原子选择到期项并写 Lease。 |
| `complete_outbox` | `{outboxId, ownerInstanceId}` | `{}` | 条件更新 → delivered。 |
| `retry_outbox` | `{outboxId, ownerInstanceId, errorCode, retryable}` | `{disposition}` | 条件更新 → pending（退避）或 dead。 |
| `read_outbox_stats` | `{}` | `{pending, inFlight, delivered, dead}` | 计数。 |

### 3.3 安全错误表

错误跨边界只携带 `code`（闭合集合，见 `PERSISTENCE_ERROR_CODES`）、
稳定 `message` 和 `retryable`；SQL 文本、数据库绝对路径、原始 Payload
不进入错误或日志。可重试码：`unavailable`、`deadline_exceeded`、
`database_busy`；其余按语义固定。

## 4. 数据库与 Migration

### 4.1 PRAGMA

| PRAGMA | state.db | telemetry.db |
| --- | --- | --- |
| `journal_mode` | WAL | WAL |
| `synchronous` | FULL | NORMAL |
| `foreign_keys` | ON | ON |
| `busy_timeout` | 3000 | 3000 |

数据目录由调用方显式传入绝对路径；包内没有“仓库内默认位置”。测试一律
使用临时目录并在成功/失败后清理。

**单 Worker 独占（worker-lock.db）**：每个数据目录只允许一个 DB
Worker。Worker 启动先对 `<dir>/worker-lock.db` 以
`locking_mode=EXCLUSIVE` 完成一次写并持久持有文件锁；第二个 Worker
的任何访问得到 SQLITE_BUSY → 安全错误 `unavailable`（“another
persistence worker already owns this data directory”）。进程死亡
（含 SIGKILL）由 OS 释放文件锁，重启即可接管——因此 §8.1 的启动恢复
（in_flight 全量重排队）不可能抢走仍存活 Worker 的活跃 Lease。

已知性能特征：`state.db` 的 `synchronous=FULL` 使每条 `appendRecord`
（独立 autocommit INSERT）伴随一次 fsync 级持久化——这是逐条审计记录
的刻意取舍；批量装载基准约 500 条 / 数百毫秒（本地 SSD 实测），P4 若
需要高频写入应评估批量化接口的兼容新增。另：本仓库 Node 基线下，高频
`setInterval` 与大并发 worker_threads `postMessage` 洪泛同时存在会
偶发饿死 MessagePort 投递（集成测试实测），生产代码只用 Promise/
`clock.sleepUntil` 定时器，不受影响。

### 4.2 Migration 规则

- Migration 是有序只前进的版本化 SQL；SQL 文本内嵌于版本化 TS 模块
  （`src/migrations/{state,telemetry}/`），随包产物发布——tsc 不复制
  `.sql` 文件，内嵌保证“SQL 进入包产物”的构建要求，规则（排序、
  checksum、不可改写）与文件方案等价。
- 对 SQL 文本计算 SHA-256 checksum 写入 `schema_migrations`。
- 单个 Migration 在事务中执行；重复 `migrate()` 幂等。
- 已应用版本 checksum 变化 → `migration_checksum_mismatch`，拒绝启动。
- 版本缺口、重复、降级或库中存在注册表外的版本 → `migration_invalid`。
- Migration 失败时 Client 不进入 Ready；部分 DDL/DML 被事务回滚。

### 4.3 state.db 表结构（0001）

```sql
schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL,
                  checksum TEXT NOT NULL, applied_at_ms INTEGER NOT NULL)

sessions(session_id TEXT PRIMARY KEY, created_at_ms INTEGER NOT NULL,
         latest_server_seq TEXT NOT NULL DEFAULT '0',   -- 无损十进制 TEXT
         updated_at_ms INTEGER NOT NULL)

session_records(record_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL REFERENCES sessions(session_id),
                record_type TEXT NOT NULL, aggregate_id TEXT, aggregate_seq TEXT,
                trace_id TEXT NOT NULL, occurred_at_ms INTEGER NOT NULL,
                schema_version INTEGER NOT NULL, payload_json TEXT NOT NULL)
  UNIQUE(session_id, aggregate_id, aggregate_seq)  -- 聚合序号单调且唯一
  INDEX(session_id, occurred_at_ms) / INDEX(trace_id)

signal_watermarks(session_id TEXT NOT NULL REFERENCES sessions(session_id),
                  source TEXT NOT NULL, watermark TEXT NOT NULL,
                  updated_at_ms INTEGER NOT NULL, PRIMARY KEY(session_id, source))

scenes(scene_id TEXT PRIMARY KEY, cycle_id TEXT NOT NULL UNIQUE,
       session_id TEXT NOT NULL REFERENCES sessions(session_id),
       status TEXT NOT NULL CHECK(status='committed'),
       commit_ordinal INTEGER NOT NULL,     -- 会话内提交序，恢复排序依据
       committed_at_ms INTEGER NOT NULL,    -- 审计墙钟，不用于恢复排序
       schema_version INTEGER NOT NULL, payload_json TEXT NOT NULL,
       idempotency_key TEXT NOT NULL)
  INDEX(session_id, commit_ordinal)

outbox(outbox_id TEXT PRIMARY KEY,
       session_id TEXT NOT NULL REFERENCES sessions(session_id),
       topic TEXT NOT NULL, partition_key TEXT NOT NULL,
       schema_version INTEGER NOT NULL, payload_json TEXT NOT NULL,
       status TEXT NOT NULL CHECK(status IN ('pending','in_flight','delivered','dead')),
       attempts INTEGER NOT NULL DEFAULT 0,
       available_at_ms INTEGER NOT NULL, lease_until_ms INTEGER,
       lease_owner_instance_id TEXT, last_error_code TEXT,
       created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL)
  INDEX(status, available_at_ms)

idempotency_keys(scope TEXT NOT NULL, key TEXT NOT NULL,
                 request_fingerprint TEXT NOT NULL, result_type TEXT NOT NULL,
                 result_ref TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
                 PRIMARY KEY(scope, key))    -- Key 带作用域，非全库裸唯一
```

存储约定：

- 所有 ID 存 TEXT（Contracts 原形式）；Watermark / Server Seq /
  Aggregate Seq 一律**无损十进制 TEXT**，读写经 `formatDecimalString` /
  `parseDecimalString`，绝不经过 JS `number`。
- JSON 列写入前通过对应 Schema；读取后再次校验 `schemaVersion`，未知
  版本返回兼容性错误。
- `committed_at_ms` / `occurred_at_ms` 是审计墙钟；恢复排序依据
  `commit_ordinal` / `aggregate_seq` 等事务事实。`commitAtRuntimeUs`
  不写入 state.db。
- `telemetry.db` 只有最小底座（`schema_migrations` + 事件底表），遥测
  写入不参与 state.db 事务，不影响 Ready 判定。

## 5. Repository 语义

### 5.1 Session Records

- Append-only：不更新既有记录 Payload。
- 写入前 `SessionRecordSchema` 校验；读取后重校验。
- 同一 `(session_id, aggregate_id)` 的 `aggregate_seq` 单调且唯一；
  重复或倒退 → `record_conflict`。
- 按 `session_id` / `trace_id` / `aggregate_id` 索引查询。

### 5.2 Signal Watermark

- `(session_id, source)` 唯一；只允许前进：相等幂等，倒退 →
  `watermark_regression`（整个 commitScene 回滚）。
- 比较在 bigint 域完成。
- 多个 Source 在 commitScene 同一事务内一起推进或全部回滚。

### 5.3 Idempotency

- 作用域固定为 `scene_commit:{sessionId}`，Key 为调用方 `idempotencyKey`。
- 存请求摘要（`requestFingerprint`，调用方提供，Worker 校验为
  1..256 字符的稳定字符串——信任边界：摘要只用于相等比较，不解析语义）
  与结果引用（sceneId + committedAtMs）。
- 同 Key 同摘要 → 返回第一次结果并标记 `duplicate: true`；
  同 Key 不同摘要 → `idempotency_conflict`（不可重试）。
- `BEGIN IMMEDIATE` + 主键约束保证并发相同请求只有一个逻辑 Commit。

## 6. Server Seq

`sessions.latest_server_seq`：`advanceServerSeq` 单调推进，返回落库后
当前值；倒退 → `seq_regression`，相等幂等。存储为无损十进制 TEXT。
P4 在 Control Session 断线重连导出/恢复 `nextSeq` 时必须调用它持久化
最新分配水位（含 persistable=false 的瞬时消息，见 control-websocket.md
§5），防止重启后复用 Seq。

## 7. 原子 commitScene

事务顺序固定：

```text
BEGIN IMMEDIATE
  → 验证 Session 存在
  → 幂等命中：同摘要 → 返回第一次结果（duplicate）；不同摘要 → 冲突
  → SceneSchema 校验 + sceneId/cycleId 与入参一致
  → OutboxMessageSchema 逐条校验
  → 计算 scenes.commit_ordinal（会话内 MAX+1）
  → 插入 scene_committed Session Record（aggregate 为 scene-commit 流）
  → 插入 scenes
  → 单调推进全部 Signal Watermark（倒退即回滚）
  → 插入全部 Outbox Message（pending，available_at_ms = now）
  → 写入幂等结果引用
  → [检查点 before_scene_transaction_commit（仅观察器已注册时）]
COMMIT
```

保证：

- 任一步骤失败全部回滚（含 Worker 内未分类异常 → `internal`）。
- Outbox 只有 COMMIT 后才能被 Claim。
- Commit 前终止：Scene/Record/Watermark/Outbox/Idempotency 均不存在。
- `committedAtMs` 由数据库侧（可注入墙钟）生成，随结果返回。
- 相同请求重放不产生第二个 Scene/Record/Outbox；不同摘要冲突不改变
  第一次结果。
- P2 不向 WebSocket 发布任何消息；发布顺序由 P4 在 Commit 成功后负责。

## 8. Outbox 状态机

```text
pending → in_flight → delivered
              ↘ pending（可重试，退避后可再领取）
              ↘ dead（不可重试或超过 maxAttempts）
```

### 8.1 Claim 与 Lease

- `claim_outbox` 在单个 `BEGIN IMMEDIATE` 事务内选择可领取项
  （`ORDER BY available_at_ms, outbox_id LIMIT :limit`，有 Batch 上限）：
  - 到期的 `pending`：`available_at_ms <= leaseNowMs`；
  - **Lease 已到期的 `in_flight`**：`lease_until_ms <= leaseNowMs`——
    Dispatcher/Publisher 卡死但 Worker 存活时，同一 Worker 生命周期内
    即可回收重领，不必等待 Worker 重启。
  逐条条件更新为 `in_flight` 并写 `lease_owner_instance_id` /
  `lease_until_ms`（条件与选择谓词一致，两个 Dispatcher 不可能领取同一项）。
- **Lease 时钟投影**：Worker 启动时记录 `bootEpochMs + bootMonotonicUs`
  锚点，运行期 `leaseNowMs = bootEpochMs + (nowMonotonicUs -
  bootMonotonicUs)/1000`，同一 Worker 生命周期不直接反复读取
  `Date.now()`，NTP 跳变不影响 Lease 判断。
- **重启恢复**：Worker 启动时（首次 migrate 后）把所有 `in_flight` 项
  一次性恢复为 `pending`，**并把 `available_at_ms` 重置为新 Worker 的
  leaseNowMs**——旧 Worker 的时钟域可能领先（或重启后墙钟回拨），
  保留旧 available_at 会让重排队项在新时钟域里“在未来”而无法立即领取。
  前置条件是 §4.1 的 worker-lock 单 Worker 独占——同目录不存在仍存活
  的其它 Worker，重排队不可能抢走活跃 Lease。这是“可能重复、幂等去重”
  的有意识选择。
- `complete_outbox` / `retry_outbox` 都是条件更新：
  `WHERE outbox_id=? AND status='in_flight' AND
  lease_owner_instance_id=?`；未命中 → `not_claimed`（已被他人领取或
  已完成时幂等成功由调用方区分）。

### 8.2 重试与 Dead Letter

- 可重试失败：`attempts+1`，`available_at_ms = leaseNowMs + delay`，
  `delay = min(maxMs, baseMs · 2^attempts) · (1 + jitter(seed, attempts))`，
  抖动由种子确定性导出（可注入、可重试）。
- **时钟域分离**：调度相关字段（`available_at_ms`、`lease_until_ms`、
  退避基准）全部使用 Lease 单调投影 `leaseNowMs`；审计墙钟只进
  `created_at_ms` / `updated_at_ms` / `committed_at_ms` 等审计列。
  注入的固定审计墙钟（测试）不影响可领取性。
- 不可重试或 `attempts >= maxAttempts` → `dead`，记录
  `last_error_code`（稳定安全码，不是异常文本）。
- 指标：`bellis_outbox_pending`（Gauge）、`bellis_outbox_delivered_total`、
  `bellis_outbox_retry_total`、`bellis_outbox_dead_total`（Counter）；
  不以 Outbox ID 作为 Label。
- Dispatcher 关闭：停止新 Claim，在 `stopGraceMs`（默认 5s）内等待当前
  小批次完成；批次提前完成时清理 Grace 定时器、不中止任何信号（干净
  停止零残留）；超时后仅向**在途批次**的发布器广播 AbortSignal（每批次
  独立信号）并立即返回，挂起项由 Lease 到期回收兜底（发布器签名携带
  `signal`，应当监听并尽快退出）。

## 9. 受控检查点（仅测试可用）

```ts
interface PersistenceCheckpointObserver {
  reached(checkpoint, context: {traceId, sceneId?, outboxId?}, signal): Promise<void>;
}
```

- 检查点：`before_scene_transaction_commit`（Worker 事务内 COMMIT 前）、
  `after_scene_transaction_commit_before_outbox_dispatch`（Dispatcher
  Claim 前）、`after_outbox_publish_before_mark_delivered`（Dispatcher
  发布成功后、complete 前）。
- 观察器只在 `createPersistenceClient`/`createOutboxDispatcher` 显式注入
  时生效；生产默认 No-op，未启用时零额外消息、事务顺序不变。
- Worker 侧检查点通过 RPC 通道上的专用通知消息
  （`persistence_checkpoint` / `persistence_checkpoint_release`）与 Client
  侧观察器交互；观察器正常返回 → 继续，抛出/中止 → 事务回滚或批次放弃。
- 测试适配器仅由测试父进程通过继承的私有 IPC 创建（test/fixtures）；
  生产入口不导出“启用故障”的便利函数，HTTP/WS 无 Fault Route，普通
  环境变量不能开启。

## 10. 三个 Crash Window 与恢复结果

```text
W1 提交前（before_scene_transaction_commit 后被杀）
   → 重启后 Scene/Record/Watermark/Outbox/Idempotency 全部不存在；
     同请求可完整重提交。

W2 提交后、Outbox 发布前（after_..._before_outbox_dispatch 后被杀）
   → 重启后事实完整存在；Outbox 项 pending；重新启动 Dispatcher
     即重新发布；幂等重放同请求返回 duplicate。

W3 发布后、标记 delivered 前（after_outbox_publish_... 后被杀）
   → 允许重复交付（消费者按 outboxId 去重）；重启后项仍可领取，
     重新发布后标记 delivered。

W4 Lease 期间（in_flight 时被杀）
   → 进程死亡释放 worker-lock 文件锁；新 Worker 启动恢复把
     in_flight → pending，立即可再领取，不等待旧 lease_until_ms。
     Dispatcher 卡死但 Worker 存活时，Lease 到期即可重领（§8.1）。
```

恢复测试使用真实 Worker、真实临时 SQLite 文件与父子进程强制终止
（SIGKILL）；普通 `close()` 不算 Crash Window。

## 11. P4 集成顺序

1. 显式传入数据目录绝对路径，`createPersistenceClient` 后先
   `migrate()`（失败不进入 Ready，不接受业务连接）。
2. Session 建立时 `ensureSession`；断线重连恢复时
   `readRecoveryState` + `advanceServerSeq` 回写水位。
3. Scene Commit：`commitScene` 成功返回**之后**才允许向 WebSocket 发布
   `scene.committed`（顺序：事务 COMMIT → 发布）。
4. Outbox：`createOutboxDispatcher` 注入发布器；发布器必须按
   `outboxId` 幂等。关闭顺序：先 stop Dispatcher（Grace），再
   `client.close()`。
5. 生产装配不注入 `checkpointObserver`、不注入测试 Migration 注册表。
