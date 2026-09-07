# 构建与验收状态

> 2026-09-06 架构审查修订：任务所有权、工具恢复事实、调用列表范围、场景终态、Seq 分段预留及 Provider 接缝以 [ADR 0007](./adr/0007-task-ownership-and-runtime-scope.md) 为准。

此页维护当前可执行入口，历史 Phase 2/3 指南保留原始实施目标。未通过的指标不因脚本存在而视为完成。

## Phase 5 及以后：计划与已有验收分开

当前已交付基线见 [Phase 4 实施状态](./phase-4-implementation-status.md)；公共游戏 SDK、Session Activity、独立游戏 Runtime 与原神支持仍待实现。新工作以 [Phase 5 指南](./phase-5-development-guide.md) 和 [Phase 5–8 路线图](./phase-5-and-beyond-roadmap.md) 为准，不把现有 GameIntent 类型、Fake Stage 或 Phase 4A 的 480 例当作游戏执行证据。

| 新阶段 | 计划增加的验证 | 外部条件 |
| --- | --- | --- |
| Phase 5 | G0–G5：公共包/独立构建、FakeGame、正式插件注册、Activity/owner/操作/SSE/阅读回执、干净 consumer | 不需要原神或真实输入；公共规格与跨仓访问须明确 |
| Phase 6 | 单桌面真实 Broker、原神能力链、真实效果与输入清理、单一表现/记忆写入 | Windows 11 交互桌面、游戏测试账号/场景，实际表现所需资源 |
| Phase 7 | 第二款真实游戏、跨会话污染防护、包兼容隔离、配对跨机与同协议恢复 | 第二游戏短流程、跨机环境 |
| Phase 8 | 无源码应用安装、签名组合/回滚、managed、Windows/OBS 负载 | 正式签名/发布条件与 OBS 实机 |

以上均为待新增检查，当前没有 `test:game` 或 `demo:phase5` 命令。新增后才更新本页命令列表。Phase 5 开工需让 CI 实际覆盖目标分支或 PR：现有 push 过滤器只包含 main、master 和 codex/**，另有 pull_request 触发；不能仅凭已推送 phase4/dev 分支宣称远程 CI 通过。

Bellis CI 不检出游戏源码来完成宿主构建；游戏 Core CI 不安装 Bellis 或真实游戏来完成 Fake/契约测试。联合发布 Gate 在无相邻源码、editable/link 的 consumer 中安装实际 tarball/wheel，并验证对应版本矩阵。日志/录屏/逐次报告归 artifact，仓库只留摘要与组合清单。

## 首次运行

从仓库根目录执行。Node 的固定复验版本见 `.node-version`，pnpm 版本见 `package.json#packageManager`；安装时强制检查 engines。

```bash
pnpm install --frozen-lockfile
pnpm --filter @bellis/stage exec playwright install chromium
pnpm check
pnpm test:acceptance
```

`check` 先运行 evidence:check、test:scripts，再依次执行 runtime baseline、全量 build、typecheck、lint、format、双 dialect 契约漂移、单元/性质/集成测试，能在无 dist 的检出上运行。`pnpm typecheck` 也通过完整的 workspace 源码映射解析内部包。
`test:acceptance` 依赖 check/build 生成的产物，依次执行 Phase 1 Demo、Phase 2 Demo、Phase 2 Crash、Phase 3 Demo 和 Chromium E2E。依赖及浏览器安装需要提前完成；安装完成后的确定性验收不依赖真实模型、外部记忆或商业资源。
`apps/stage/dist-web/` 是本地构建产物，由 `pnpm build` 生成并被 Git 忽略，不纳入源码提交。

## 能力与证据

| 能力                                         | 当前状态/权威文档                                                     | 自动验证                                                                   | CI                         |
| -------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------- |
| 基础协议/DB Worker/恢复                      | Phase 1 reference、protocols                                          | check、demo:phase1                                                         | Windows/macOS              |
| Scene/媒体/三 Lane                           | Phase 2 reference、scene-execution                                    | demo:phase2、demo:phase2:crash、test:browser                               | Windows/macOS              |
| Decision Loop/独立工具调用列表/来源去重      | Phase 3 reference、ADR 0004/0006/0007                                 | check、demo:phase3                                                         | Windows/macOS              |
| 两 Cycle→真实浏览器、工具并行、urgent 取消   | Phase 3 浏览器专项                                                    | test:browser 中 phase3-e2e                                                 | Windows/macOS              |
| 子任务取消 P99 ≤100ms                        | 目标保留，统计性能验收尚未完成                                        | 当前功能测试证明取消传播；Demo 的 turnSettleLatencyMs 不等于 P99           | 不宣称已验收               |
| Memory 契约与 Iris 独立 Provider             | A0/A1 和 A2 输入侧真实探针，见 Provider README                        | test:memory:iris（需隔离 Core wheel）                                      | 不在根 workspace；独立验证 |
| 宿主 Context/Memory/Persona/Observe/Presence | [Phase 4 实施记录](./phase-4-implementation-status.md)，ADR 0009/0010 | check 覆盖已实现宿主与输入事务；Stage 效果、Presence 和 demo:phase4 未完成 | 真实 Core 不在 CI 默认门内 |

CI 只代表其实际运行的平台与命令结果；本地测试结果不能代替固定 Node 版本的双平台运行。

2026-09-06 本轮修改前的基线复验（macOS、Node 26.8.1）：`pnpm check`、`pnpm test:acceptance` 全部通过，包括两组 Chromium E2E；Iris 独立包的 lint、format、typecheck、23 项测试及 build 通过。另在移除内部构建产物的隔离源码副本上验证 typecheck/build，复用已安装的外部依赖，未重新验证联网安装。CI 配置已补齐验收入口，固定 Node 26.5.0 的远端双平台结果仍以实际工作流为准。

## ADR 0007 本轮验证

2026-09-06，macOS / Node 26.8.1：

- `pnpm check` 通过：构建、类型、lint、格式、双 dialect 契约无漂移，899 项单元/性质测试与 193 项集成测试通过。
- `pnpm test:acceptance` 通过：Phase 1/2/3 Demo、四个 Scene 崩溃窗口和两组 Chromium E2E。
- Iris 独立 Provider 的 typecheck、23 项测试、build、lint 和 format 全部通过。

本轮回归覆盖 Turn 接受后立即关闭、连续 interrupt、后台工具排队后前台返回、执行事实写失败、durable 提交期间断线、Scene 执行截止、soft 准备超时/零预算/迟到丢弃、Worklet 开始确认与跨消息 Lane 偏差聚合、默认 Seq 预留/扩展失败/跨进程恢复、空工具目录和有界 evidence，以及无人格元数据的最小 Memory 贡献。

初次集成运行因沙箱禁止本机监听而返回 EPERM；在允许本机端口的执行环境中重新完成全套验证。浏览器本次样本的 hardLaneSkewMs 为 2.90ms、interruptLatencyMs 为 6.20ms，属于功能验收样本，不构成物理播放或取消 P99 统计结论。真实 TTS、模型 final 前 Prepare、首块预缓冲与 Phase 4 宿主纵向集成仍未交付。

## Phase 3 剩余性能验收

P99 的基准必须分别采样模型流停止、Tool 退出/资源释放、Stage 确认停止，固定起点为 Runtime 接受 interrupt 的单调时刻。跨时钟域先校准，记录样本数、平台、负载、误差上界和原始分位数。不得把一次 Turn idle、2.1s 的 Harness 总超时或“没有收到回执但继续成功”计为 100ms 子任务证据。

Phase 3 功能核心已交付；原计划的这一性能 Gate 仍开放。Phase 4 Gate 0 必须先记录此既有缺口，不能伪称全部 Phase 3 原定 Gate 通过。

## 契约变更与 Provider

Schema 改动后从根执行 `pnpm --filter @bellis/contracts build`、`pnpm --filter @bellis/contracts contracts:generate`、`pnpm contracts:check`；生成物与源变更一起审查。
Iris 处于独立 registry 过渡期，根 check 不包含它。其安装、宿主声明构建前置和独立验证见 [Provider README](../providers/memory-iris/README.md)。
Phase 4A 调研已单独核查 Provider/SDK/Core，结果及来源 hash、版本协商、partial proof 等接入差异见 [调研记录](./phase-4-iris-integration-research.md)。这些测试不代表真实 Bellis + Core 集成通过；后续必须补当前安装物和宿主实际效果/恢复验收。
Migration 只新增版本，不改历史 SQL/checksum；Signal 来源索引升级见 ADR 0006。

## Phase 4 当前专项入口

先构建根声明并安装独立 Provider，再执行真实公共边界探针：

```sh
pnpm build
pnpm --dir providers/memory-iris install --frozen-lockfile
IRIS_CORE_PYTHON=/absolute/isolated-venv/bin/python pnpm test:memory:iris
```

Core 必须由非 editable wheel 安装，可信 `init` 需返回 actor 身份 ID；探针核对 wheel 内实际安装文件。缺环境退出 2，不能作为通过。命令覆盖 A0/A1 和 A2 可信输入接纳/重发，不能替代 Stage 实际输出确认、A4 崩溃矩阵或完整 Phase 4 验收。当前可复验版本与脱敏产物摘要见 [实施记录](./phase-4-implementation-status.md)。

输出专项使用真实 Chromium、Runtime 和 DB Worker，Memory 端为本地测试 Provider：

```sh
pnpm build
pnpm --filter @bellis/stage exec playwright test phase4-effects-e2e.test.ts
```

2026-09-07 本轮 `pnpm check`：1004 项单元/性质测试、222 项集成测试通过，154 个生成契约文件无漂移。独立 Iris Provider 57 项测试另覆盖人格失效恢复、有界后台请求、规范资源引用与四工具注册/授权边界。真实 Stage/Core 专项此前验证渲染片段回写、下一轮确认历史及播放中的可信隐私中断；宿主事务拒绝旧 generation 和迟到回执。Core 四工具/外部失效接入、实际删除与 A4 矩阵仍未关闭。

真实 Stage→Core 联合路径使用相同浏览器断言：

```sh
IRIS_CORE_PYTHON=/absolute/isolated-venv/bin/python pnpm demo:phase4:iris
```

该命令已通过三个实际输出 Cycle、四条 Observe、三次 Usage ACK 和 Core source cursor 核对。仍不代表隐私删除恢复、100 Cycle 长时或 A4 崩溃矩阵完成。缺 Core 安装环境退出 2；首次运行需安装 Chromium。

原始工具调用和 Session 所有权的恢复基础见 [ADR 0014](./adr/0014-phase4-original-tool-calls-and-session-ownership.md)：adoption 原子保存参数/键并拒绝变更重放，空占位宿主绑定后恢复真实 Session；已有工作拒绝跨 Session 迁移。实际请求另由 [ADR 0016](./adr/0016-phase4-prepared-tool-requests.md) 的准备端口持久保存；生产四工具授权与公共恢复矩阵仍待完成。

`pnpm test:memory:iris:tools` 在记录的 Core 0.13/schema 15 安装上通过公共接口专项，搜索写后命中、删后消失；0.12 历史安装仍退出 2。完整生产授权/Legal Hold/宿主恢复 Gate 尚未通过，见 [ADR 0019](./adr/0019-phase4-core13-search-initialization.md)。

ConfirmationPort 已绑定冻结调用参数、身份和摘要，等待受取消及同一次工具 Deadline 控制；真实 DB Worker 集成证明先持久化再确认、关闭 Session 后不执行迟到批准。新增准备端口绑定实际可信请求，Iris remember 夹具已通过真实宿主确认及丢响应后的原请求恢复；当时的 0.12 搜索未就绪、专项退出 2，新 0.13 结果见下文。见 [确认专项](./evidence/phase4-confirmation-probe.json) 与 [实际请求专项](./evidence/phase4-prepared-tools-probe.json)。

四工具注册与应用装配见 [ADR 0017](./adr/0017-phase4-iris-tool-registration.md)：`RuntimeOptions.tools` 显式传递能力、确认及注册函数；独立 Iris 包新增本地 Tool Runtime 链接，修改后重新安装其锁文件。真实 Core remember 已使用注册适配器和 MemoryHost 策略；目标授权规则、完整删除恢复矩阵和搜索 Gate 仍开放，见 [注册专项](./evidence/phase4-tool-registration-probe.json)。

Forget 协调见 [ADR 0018](./adr/0018-phase4-forget-coordination.md)：DB Worker 原子保存屏障/操作归属与完成回执/tombstone，MemoryHost 在 ACK 丢失后保持封锁。真实 Core 专项验证注册工具确认后删除、HTTP 前持久屏障、原键重放和 Worker 重启恢复；Legal Hold/保护对象实测与崩溃窗口仍开放，见 [Forget 专项](./evidence/phase4-forget-coordinator-probe.json)。

Core 0.13 验证使用新的非 editable wheel 环境，CLI 显式 `--initialize-search`，156 个安装文件与 wheel 一致。真实工具公共接口和 Chromium/Observe/Usage 回归通过；旧 Core 0.12 环境未覆盖。已有 Core 数据升级必须遵循其备份迁移流程，不能把新库验证当成已有库迁移证据。见 [Core 0.13 搜索专项](./evidence/phase4-core13-search-probe.json)。

Core 搜索初始化增量另通过当时 Iris 源码的完整 Python 回归：11,032 项测试、覆盖率 84.49%；初始化专项 9 项、修改文件类型检查、生成契约/兼容性/公共 API 检查均通过。该结果不替代 Bellis 的 A4 长时与崩溃矩阵。

写目标核验见 [ADR 0020](./adr/0020-phase4-iris-tool-target-verification.md)：独立 Provider 77 项测试、类型/构建/lint/格式及真实 Core 工具专项通过。注册 Forget 验证两次 getClaim、一次确认/写入与持久屏障；确认期间目标变化或撤权拒绝写入。Core Forget 没有 expected_revision 条件，仍不具备跨写者原子目标核验，详见 [目标核验证据](./evidence/phase4-tool-target-probe.json)。

待消费输入的当前版本核验见 [ADR 0021](./adr/0021-phase4-local-input-privacy.md)：Migration 14 保存 Signal 策略来源，模型请求前核对 Signal/Tool Run，并在 Manifest 记录排除项。根 `pnpm check` 已通过 1014 项单元/性质测试和 227 项集成测试，158 个生成契约文件无漂移；真实 Core 工具 + Chromium 联合回归也通过。旧未标记输入不会自动获得当前授权，元数据 16,384 行满额时拒绝新接纳，历史行不驱逐。见 [本轮证据](./evidence/phase4-local-input-privacy-probe.json)。

收到的公共删除事件专项使用带 `events.sse.v1` 的可信应用凭据：

```sh
IRIS_CORE_PYTHON=/absolute/isolated-venv/bin/python pnpm test:memory:iris:invalidations
```

[ADR 0022](./adr/0022-phase4-resource-invalidations.md) 对应根检查通过 1018/229 项、160 个生成契约，Provider 80 项通过。新 wheel 实测外部删除失效、游标提交与 Worker 重启恢复，联合公共工具/Chromium 回归也通过。本次 Core 全量回归为 11,114 通过、4 项 Console 上传描述与生成契约不匹配、54 项本地端口权限错误（覆盖率 83.29%），未通过；初始化 9 项及修改文件 Ruff/Mypy 通过。详见 [专项证据](./evidence/phase4-resource-invalidation-probe.json)。事件历史缺口和普通纠正通知不在该通过范围内。

上述 54 项 Mock Server 环境错误在获得本地端口权限后单独重跑，54 项全部通过；4 项 Console 契约失败仍保留，不将分次结果合并为一次全量通过。

`pnpm test:memory:iris:continuous` 使用相同 Core wheel/SDK 与 Chromium 路径运行 100 Cycle；已通过 100 份持久 Manifest/Recall/Usage 核对及 101 条实际输出，最终公共源游标 101。新增 5 项审计反例测试、Stage 类型/lint/格式检查与三轮短路径回归通过。运行方法、逐轮来源及未覆盖的崩溃/容量范围见 [连续验收说明](./phase-4-continuous-validation.md)。

`pnpm test:memory:iris:recovery` 已接入三个 Manifest/adoption/Usage 边界、三个 Observation HTTP 边界及两个 SSE 持久边界，分别终止真实 Runtime、Core API 与 Core Worker。当前命令保留剩余恢复/容量窗口清单，报告 `incomplete` 并退出 2，不能将其计作完整 A4 通过。检查点、原键回执及运行方式见 [恢复验收说明](./phase-4-recovery-validation.md)。

最新恢复矩阵通过十五组合各 20 次，共 300 次（采用/Usage 180 + SSE 120）。已采用的 Runtime 重启不再请求模型；采用前的未消费输入以新 Cycle 恢复，原候选不写入。Usage 原键回执与 Core 自然去重核对通过。入口仍因其余窗口未覆盖而退出 2，详见 [本轮证据](./evidence/phase4-cycle-recovery-probe.json)。

最新 Observation HTTP 增量通过 180 次，并联同原矩阵共通过 480 次。透明代理在真正转发 ACK 前暂停，公开源游标证明 Core 已提交；重启保持原请求和批次键，记录级去重返回原 Canonical ID 且未新增投影任务。正式命令因效果/快照/容量等窗口未齐仍退出 2。见 [480 次证据](./evidence/phase4-observe-recovery-probe.json)。

显式空间范围及启动期 Session 归属见 [ADR 0023](./adr/0023-phase4-explicit-memory-scope.md)。`RuntimeOptions.memory.scope` 必须明确为 `{ kind: "space", acknowledgeCrossSession: true }`；缺失配置、未核验的 Core Session/group、恢复目标不兼容都不能静默回退。Core Session 映射仍未实现，验证记录见 [本轮证据](./evidence/phase4-explicit-scope-probe.json)。

磁盘高水位准入见 [ADR 0024](./archive/phase-4/decisions/0024-phase4-disk-admission.md)：默认 `persistence.highWaterBytes=536870912`、`completionHeadroomBytes=167772160`；`readDiskStatus()` 读取 SQLite/WAL 实际占用，高水位时 ready 返回 503。真实 DB/WAL 压力测试验证已有确认与 Outbox 保留；硬配额及最坏预留 Gate 尚未关闭，见 [证据](./evidence/phase4-disk-admission-probe.json)。

数据库页限制见 [ADR 0025](./archive/phase-4/decisions/0025-phase4-database-page-limits.md)：默认 `persistence.stateMaxBytes=1073741824`、`telemetryMaxBytes=67108864`，用 SQLite max_page_count 对所有 Worker 写入生效。空间耗尽保留原事实并返回稳定容量错误；重启预算不足拒绝打开。WAL 总量与确认预留不是本限制的覆盖范围。

WAL 写入拦截见 [ADR 0026](./archive/phase-4/decisions/0026-phase4-wal-write-fence.md)：`persistence.walHighWaterBytes` 默认 67108864，分别作用于两个数据库。检查点受旧快照阻塞时暂停后续实际写事务，后台写入也受约束；`wal_pressure` 令 ready 返回 503。释放快照后读取状态可触发检查点并恢复。单事务超调及确认专用预留仍未完成。

事务缓存约束见 [ADR 0027](./archive/phase-4/decisions/0027-phase4-transaction-capacity.md)：`persistence.transactionCacheMaxBytes` 默认 8388608，范围 4–64 MiB。关闭 cache spill 后，由连接级原生 SQLite 提交检查拒绝超预算事务。`pnpm build` 新增本地 C 编译步骤；macOS/Linux 需要 cc，Windows 需要 Visual Studio Developer 环境中的 cl.exe，CI 已增加该环境配置。头文件固定在仓库内，构建不联网，包发布产物须保留 `dist/native`。

收尾预留见 [ADR 0028](./archive/phase-4/decisions/0028-phase4-completion-reservations.md)：Migration 16 随准备/确认/关闭持久维护余额，普通 state/telemetry 写入必须留下该额度。默认 4 KiB 页下绑定/确认/关闭分别使用 512 KiB、2 MiB、512 KiB 的原生事务预算，较大页同比放大。`pnpm check` 新增两个窗口各 20 次真实 SIGKILL 的确认事务恢复测试；这不等于全部 Core/Stage/真实磁盘耗尽矩阵完成。

## 脚本与证据维护

Iris 验收 harness 位于 `scripts/iris/`，Demo 与 Stage 测试宿主位于 `scripts/demos/`；公开 pnpm 命令不变。`pnpm check` 先运行 `evidence:check` 和 `test:scripts`，检查摘要预算、生成文件归属与 harness 单元测试。逐次报告保存在被忽略的 `artifacts/evidence/`，CI 另上传它及 Playwright 诊断，保留 14 天；这不增加默认 CI 的真实 Core 覆盖。详见 [证据规则](./evidence/README.md) 与 [脚本索引](../scripts/README.md)。

## 提交粒度与远程保存

一个可独立验证、可回滚的切片形成一个提交，提交信息说明行为变化；目录迁移、产物治理和文档整理尽量分别提交。验证结果写入提交说明或 PR，同主题证据按上述规则更新。不要等整阶段结束才集中提交所有工作，也不要为凑次数提交无法构建的中间状态。

对于已授权提交和推送的任务，在切片验证通过及暂停长时间工作前保存提交并推送目标分支；检查上游指向同名远程分支，并核对远程 SHA。工作区改动不包含在 `git push` 中，只有本地提交也不等于已有远程备份。更新 main 前确认仅需快进；删除旧分支前核对 worktree 占用、祖先关系，squash 合并还要核对 PR 的 head SHA、合并提交及完整文件树。

大型历史提交可以事后按逻辑拆解用于审阅，但不能据此重建当时不存在的逐步验证和时间顺序；未经明确要求不重写已共享历史。后续从有界、可验证的新提交开始改善粒度。
