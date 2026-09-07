# Phase 4 真实进程恢复验收

恢复入口为 `pnpm test:memory:iris:recovery`。根据用户明确要求及 [ADR 0047](./adr/0047-phase4a-recovery-scope-freeze.md)，Phase 4A 恢复范围显式冻结为下表 8 个窗口 × 3 个目标 × 20 次，冻结时已通过 480/480。现有用例、断言和重复次数均不减少。

顶层比较实际 casesPassed 与窗口数 × 目标数 × repetitions，并要求 repetitions 达到 requiredRepetitions=20，满足时返回 covered-windows-passed、命令退出 0。完整执行但次数不足仅报告 smoke-passed，不作为正式 Gate 证据；计数不符为 incomplete。断言失败仍退出 1；缺少 Core 安装路径仍退出 2 并明确报告 NOT RUN。

Stage 事务、活动 Stage 的额外 HTTP/SDK ACK 组合、容量及 cursor 扩展归 [Phase 4B 待办](./phase-4b-backlog.md)。它们不再控制这个 Phase 4A 命令的成功状态，本次收尾不继续运行新专项。

```sh
IRIS_CORE_PYTHON=/absolute/isolated-venv/bin/python \
IRIS_PROBE_REPORT=/absolute/output/phase4-recovery-core-probe.json \
pnpm test:memory:iris:recovery
```

## 冻结后的本次验证

完整 `pnpm check` 与 `pnpm test:memory:iris:recovery` 均退出 0。恢复报告为 `covered-windows-passed`，实际/预期均为 480，24 个窗口/目标组合各保留 repetition 1–20。见 [收尾摘要](./evidence/phase4a-recovery-scope-freeze.json) 和 [原始报告](./evidence/phase4a-frozen-recovery-raw.json)。本次验证后提交并停止，不启动 Phase 4B。

## 已接入的矩阵

| 窗口                                                      | Runtime SIGKILL  | Core API SIGKILL | Core Worker SIGKILL |
| --------------------------------------------------------- | ---------------- | ---------------- | ------------------- |
| Manifest 已形成，adoption 尚未调用                        | 每组合要求 20 次 | 每组合要求 20 次 | 每组合要求 20 次    |
| adoption 已提交，Usage 尚未获得 Core ACK                  | 每组合要求 20 次 | 每组合要求 20 次 | 每组合要求 20 次    |
| Usage 已获得 Core ACK，宿主 delivered 尚未提交            | 每组合要求 20 次 | 每组合要求 20 次 | 每组合要求 20 次    |
| 输入 Observe 已持久化，代理尚未向 Core 发布 HTTP          | 每组合要求 20 次 | 每组合要求 20 次 | 每组合要求 20 次    |
| Core Observation 已提交，代理尚未向 Runtime 转发 HTTP ACK | 每组合要求 20 次 | 每组合要求 20 次 | 每组合要求 20 次    |
| SDK 已确认 Observation，宿主 delivered 尚未提交           | 每组合要求 20 次 | 每组合要求 20 次 | 每组合要求 20 次    |
| pending 失效已落盘，宿主处理尚未确认                      | 每组合要求 20 次 | 每组合要求 20 次 | 每组合要求 20 次    |
| 策略/tombstone 已提交，Provider 游标尚未推进              | 每组合要求 20 次 | 每组合要求 20 次 | 每组合要求 20 次    |

测试子进程调用真正的 `startRuntime`，构造 MemoryHost、DB Worker、Phase 2/3 宿主。可信操作者仅通过私有 IPC 和测试包装的 PersistenceClient 等待检查点；采用前检查点在真实 adoption RPC 前等待；提交后检查点先等待真实 DB Worker ACK，Usage 检查点先等待真实 Core ACK，均不伪造提交。生产入口、HTTP 和 Control WebSocket 没有故障开关。

### Cycle 与 Usage

Cycle 子进程向真实 Signal Pipeline 提交一次输入，由 Loop 调用已安装 Iris Provider 进行 Recall，并由确定性模型生成 no-op 决策。检查点记录原候选 Manifest ID/digest、原 Usage、持久 Manifest 是否存在、Outbox 状态及实际 Core ACK 次数。

采用前终止 Runtime 后，未消费的已接纳输入按 Phase 3 规则恢复为新 Cycle；新身份必须不同，原候选 Manifest 仍不存在。采用后的 Runtime 恢复不得再次请求模型，必须读取原 Manifest；Core API/Worker 终止时 Runtime 保留原候选并继续同一 Cycle。三类情况最终都只能消费该输入一次、保留一条采用记录和一条 delivered Usage。

重启投递必须沿用原 Usage 请求、Cycle、Persona revision 和三集合。父进程用原键重放得到公开回执，再用测试专用的新传输键核对 Core 自然去重：`created=false` 且 report ID 与原回执一致。这个额外请求只用于测试去重；生产恢复仍使用原幂等键。

本测试使用短暂的 1,000ms Outbox Lease，使真实重启等待租约回收；不直接改宿主租约、不手工标记 delivered。既有默认生产 Lease 不变。模型选择 no-op，因此这些用例不证明活动 Scene 的崩溃恢复。

### Observation 与 HTTP ACK

Observe 子进程通过真实 Runtime 的可信输入映射、Signal 接纳事务和 Outbox 投递一次 user 事实。它不将模型文本或未确认 Scene 伪装成 assistant 观察。Actor 来自测试操作者初始化的公共身份；同一事实的 event ID、时间、正文、隐私标签、源流和源游标随宿主恢复保持不变。

测试使用固定目的地址的 loopback HTTP 代理。第一窗口在代理收到请求后、向 Core 转发前暂停；第二窗口已经取得 Core 成功响应，但没有向 Runtime 发出响应头或正文；第三窗口正常转发响应，在 Provider 完成 SDK ACK 和状态保存后、宿主 delivered 提交前暂停。不会用一个假 SDK 成功值代替真实 Core 提交。

检查点核对宿主行仍为 in-flight、delivered 为 0；前两个窗口的 Provider 尚未确认，第三窗口的 Provider 源游标已为 1。独立公开 `sourceCursor` 在第一窗口为 null，后两个窗口为 1，明确区分“尚未写入”与“已写入但宿主尚未结算”。第一窗口释放后，即便 Runtime 已退出，代理已受理的在途请求仍可能到达 Core；测试不将断线视为远端回滚。

Runtime 重启时必须从原 Outbox 重发完全相同的 HTTP 正文摘要和批次键；原进程未重启的 API/Worker 用例继续原请求。最终宿主 delivered 恰为 1、Provider/Core 源游标同为 1。使用原批次键重放后，再以测试专用新批次键、原记录业务键核对自然去重：没有新 accepted ID，duplicate ID 指向同一 Canonical Observation，`outbox_enqueued=0`。这是记录级去重证明，不只是命中批次响应缓存。

代理按请求/响应字节数和记录数限制内存，不把 Bearer token 写入报告。关闭时中止代理在途请求、关闭所有连接并等待处理器结束。

### SSE 失效

父进程经安装 SDK 创建测试观察与 Claim，再调用公共 Forget。Core Worker 发出事件后，Provider 持久保存 pending 事件。父进程核对检查点的真实 pending、tombstone 与游标，确认目标进程仍在运行，发送 SIGKILL，等待确切退出信号，再启动新进程。Runtime 使用原数据库和 Session 启动；API 使用原地址；Core API/Worker 使用原隔离 Core 数据库。

恢复后必须满足：

- 同一失效事件继续处理，永久 tombstone 存在，Provider 游标到达原事件位置。
- 若崩溃前 tombstone 已提交，重试不再推进策略 generation；若尚未提交，只推进一次。
- 策略提交窗口的旧 Context 已取消；普通删除失效处理完成后不留下额外 blocked 标志。
- 公共 getClaim 仍返回 404；使用原幂等键重放 Forget，得到完全相同的删除回执。
- 原 SSE event ID 和目标引用仍可通过公开事件接口读取。
- 当前 Runtime 正常关闭，注入的 DB Worker 显式关闭；父进程终止它创建的 Core 服务并清理临时数据。

每个用例使用新的宿主目录。Core 保持同一个数据库，因此后续宿主必须先消费之前的公共失效事件，再冻结本用例 Context；不会写入伪造游标以跳过历史。测试操作者不打开或查询 Core 数据库，只有 Core 自身 CLI/API/Worker 使用它。

## 已迁入 Phase 4B 的待办

原「仍需完成」一节与聚合返回值中的 remaining 数组已整体移到 [Phase 4B 待办](./phase-4b-backlog.md)，保留全部条目及已有专项证据。这是显式范围冻结，不是把未完成的扩展改记为通过。Phase 4A 的恢复通过条件仅为本页八窗口的 480/480。

二十四组合各一次的 `node scripts/iris-public-probe.mjs --recovery --recovery-smoke` 仅用于调试；报告保留实际次数 1，不能算作 20 次要求通过。

## 冻结前历史运行

十五组合各 20 次、共 300 次联合矩阵已通过：新增采用/Usage 180 次，SSE 回归 120 次。160 个采用路径保留原 Manifest 摘要；20 个采用前 Runtime 崩溃用例保留原候选缺席，并从未消费输入形成新 Cycle；40 个采用后 Runtime 重启用例没有再次请求模型。180 个 Core Usage report ID 各自唯一，重复请求均得到原 report ID。

当时聚合写死 incomplete，退出 2；当前判定已由 ADR 0047 修正。见 [本轮摘要](./evidence/phase4-cycle-recovery-probe.json) 和 [逐次原始报告](./evidence/phase4-cycle-recovery-core-probe.json)。历史 [SSE 摘要](./evidence/phase4-recovery-probe.json) 保持原样。

本轮二十四组合各 20 次、共 480 次联合矩阵已通过：Observation HTTP 新增 180 次，采用/Usage 180 次与 SSE 120 次回归通过。180 个独立事实保持 180 个 Canonical Observation ID；60 个 Core 已提交/HTTP ACK 未转发用例完成原键恢复。240 次实际 Observe 请求的正文摘要和批次键一致性均核验，记录级去重没有新增事实或投影任务。

见 [480 次摘要](./evidence/phase4-observe-recovery-probe.json) 和 [逐次原始报告](./evidence/phase4-observe-recovery-core-probe.json)。该原始报告保留冻结前的 incomplete/退出 2；剩余项目现归 Phase 4B。

## 确认事务与收尾余额的新增本地窗口

Migration 16 的确认提交新增两个受控窗口：全部确认/Observe/余额写入后、COMMIT 前，以及 COMMIT 后、Client ACK 前。根检查中的 `completion-crash.integration.test.ts` 为每个窗口运行 20 次真实 SIGKILL，共 40 个不同子进程；先使旧快照阻塞 WAL 回收，确认后台写入已停止，再执行受预留保护的确认。提交前不留下回执/观察，提交后保留原身份并按 duplicate 重放，重启释放旧演出的未用额度。

这些是本地 DB Worker/宿主子进程的事务案例，与历史 480 个 Core 联合恢复案例作用域和源码版本不同，不相加宣称完整矩阵通过。真实 Stage 播放、操作系统空间耗尽、旧备份及全部进程组合仍须验证。预算与证据入口见 [ADR 0028](./adr/0028-phase4-completion-reservations.md)。

外部快照跨重启的专项覆盖四个已接纳 Scene：快照持续持有旧视图时，用原关闭额度释放准备记录，保留四条已确认事实及原 Outbox；第二次重启没有新增 WAL 写入，新准入仍被拦截，释放快照后按分区顺序交付。另一用例保留真实 in-flight Lease，确认受阻的恢复明确失败、不开放业务操作，释放快照后可在同一 Client 重试。隐私关闭也在原事务释放额度。这两个用例是持续外部读者与 Worker 重启验证，不增加 SIGKILL 窗口计数。

## 两端旧快照与真实事件分叉

独立入口 `pnpm test:memory:iris:snapshots` 先验证三个 Observe 冷快照及 Bellis 删除前目录回退，再从已安装 Core 的公开 CLI 创建签名备份、停止 API/Worker、恢复到新隔离目录并以原地址重启。需配置已验证且具备 `events.checkpoint.v1` 的候选 Core；默认支持窗口并未扩大。

```sh
IRIS_CORE_PYTHON=/absolute/verified-checkpoint-core/bin/python \
IRIS_PROBE_REPORT=/absolute/output/phase4-snapshot-core-probe.json \
pnpm test:memory:iris:snapshots
```

Core 两个场景各一次：备份后的原锚点缺失，以及恢复后同一数字游标被不同事件身份占用。原备份的正游标保持可验证；原 Usage body/key 返回相同 Core report ID/stages。Provider 正常消费并保存原检查点，不由测试写入假游标；实际 410 触发旧 Context 取消和持久缺口，原 Bellis 请求/Manifest/Usage 保持。重启维护模式 live 200、ready 503、无决策管道。详见 [ADR 0045](./adr/0045-phase4-core-snapshot-restore.md)。

Bellis 场景另验证一个关闭后的完整旧目录：Core 已删除 Claim、宿主已追平后回退本地数据；目录摘要与原备份一致。追平前的 live Recall 不回注 canary，旧 Recall/remember 重放返回 409/404；追平后的墓碑、隐私交付拒绝和第二次重启稳定。原 Manifest/Outbox 保持，详见 [联合证据](./evidence/phase4-host-snapshot-restore-probe.json)。

Observe 另覆盖发布前、Core 已提交/ACK 未转发、SDK ACK/host delivered 前三个冷快照。子进程退出后复制含 WAL 的完整目录，先恢复到 delivered，再关闭并回退到较旧快照；Core 保持 cursor=1。再次恢复沿用原 HTTP 正文摘要、批次键和事件身份，记录级去重仍只有一个 Canonical Observation，最终 host delivered=1、Provider/Core cursor=1。

这证明六条明确路径，不代表全部旧快照组合、删除后 Observation 重投、Core 离线回退、最新删除账本合并、目录切换中断、全部游标偏差、缺口安全解除或 Phase 4B 的扩展恢复范围。


## 冻结前当前 SDK 的 480 例证据

SDK 0.11.2 和固定 Schema 20 wheel 的本轮回归通过 480 个既有用例：采用/Usage 180、Observation HTTP 180、SSE 120；逐组合核对 repetition 1–20，没有用冒烟次数替代。原报告内 180 个 Usage report ID、180 个 Canonical Observation ID 各自唯一；240 次 Observe HTTP 尝试保持原正文/批次键，记录级重复写入为 0。120 项删除读取均为公开 404。

这替代当前安装物只有 24 次冒烟的证据缺口，冻结前入口仍写死 incomplete/退出 2；该判定已由 ADR 0047 修正。六个快照场景在独立最终命令中各一次通过，不能与这些窗口相加冒称新的完整矩阵。见 [本轮摘要](./evidence/phase4-observe-snapshot-restore-probe.json)、[480 次原始报告](./evidence/phase4-installed-sdk-full-recovery-raw.json) 和 [六场景原始报告](./evidence/phase4-observe-snapshot-restore-raw.json)。


## 真实 Stage 效果事务专项

`pnpm test:memory:iris:stage-recovery` 已在固定 SDK 0.11.2/Schema 20 Core 上退出 0：实际 Chromium Worklet 回执触发确认事务，在 COMMIT 前与 COMMIT 后/Stage ACK 前各终止 Runtime 20 次，共 40 次。前者不留下确认或观察；后者保持原 receipt、Manifest、Observe/Outbox 身份，Core 只保留一个 Canonical ID。所有用例恢复后释放剩余预留、不重播旧 Scene，下一轮上下文没有未确认后半段。详见 [ADR 0046](./adr/0046-phase4-stage-effect-crash-recovery.md)、[摘要](./evidence/phase4-stage-effect-recovery-probe.json) 和 [原始结果](./evidence/phase4-stage-effect-recovery-raw.json)。

该专项没有终止 Core API/Worker，也未覆盖活动 Stage 的 HTTP ACK 窗口及磁盘压力；不能把它与此前 480 个输入/Cycle/SSE 用例相加当成完整矩阵。本专项及其剩余组合归 Phase 4B，不再阻止冻结的 Phase 4A 恢复 Gate。
