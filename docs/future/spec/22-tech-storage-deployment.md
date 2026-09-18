## 22. 技术路线、存储与部署

> 冻结的后续阶段设计，不参与生成与校验；现行部分见 [docs/spec/22-tech-storage-deployment.md](../../spec/22-tech-storage-deployment.md)。

### 22.7 计算与恢复产物的存储与代码边界

| 产物 | 建议归属 | 保留与恢复 |
|---|---|---|
| VisualObservationRef／DerivedView／GroundingResult | Game Runtime的perception模块与有界证据仓 | 保留根来源链；过期后不再用于执行，必要审计按权限保留。 |
| ComputeArtifact | 后端内部cache模块 | 默认内存、可淘汰；持久化必须重验用途／版本／墓碑，不影响正确性。 |
| ControlCandidate／ExecutionPrefix／CandidateRepairRecord | Game Runtime control模块 | 高频有界记录；真实输入前缀依Broker账目，关键冲突固化。 |
| ReflectionRecord／RecoveryContextView | 现有Task／Recovery职责及用途隔离存储 | 有界、任务局部；跨分支过滤后才供模型读，非默认Iris写入。 |
| RecoveryCapability／Proposal／Result | 受信Manifest＋RecoveryCoordinator＋目标恢复适配器 | 提议和真实结果分开；保护平面记录不进入快照。 |

Bellis只增加必要公共Schema、只读投影、上下文构造和实验追踪。Game Runtime实现感知／本地候选／动作解释及真实恢复；Iris继续独立。代码可落在`perception/grounding`、`control/candidates`、`control/cache`、`recovery/adapters`等现有领域目录，不强制建立新仓库或网络服务。

世界快照的manifest明确白名单和排除项。授权、Journal／Outbox、Effect／Settlement、删除和预算数据库位于不可回滚的保护平面，恢复操作没有覆写权限。实际存档或沙箱适配器如何实现该隔离，必须由目标后端单独测试，本文不将设计分区冒充OS安全隔离。
