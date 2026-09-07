# ADR 0024：SQLite 实际占用与新工作准入

状态：磁盘高水位准入已实现；硬配额与最坏情况确认预留 Gate 仍开放。日期：2026-09-07。

## 配置与测量

Runtime JSON 配置新增以下 `persistence` 字段，独立 Persistence Client 可通过 `diskAdmission` 设置同名字段：

```json
{
  "persistence": {
    "highWaterBytes": 536870912,
    "completionHeadroomBytes": 167772160
  }
}
```

默认数据库文件高水位为 512 MiB，最小可设为 16 MiB；完成流程剩余空间检查默认且最小为 160 MiB，两个配置最多 1 TiB。每次新准入另要求距离高水位至少 8 MiB 的写入余量。160 MiB 是当前准入策略的空闲空间下限，不是已证明的最大确认开销，也不代表预分配了磁盘空间。

DB Worker 读取 `state.db`、`telemetry.db`、两者 WAL/SHM，以及 Worker 独占锁数据库与回滚日志的实际文件长度；WAL 不按数据库正文大小推算。已 delivered 的记录、历史 Manifest 和空闲但尚未缩小的数据库页都计入占用，不通过隐藏历史数据降低数字。文件系统剩余空间来自同目录 `statfs.bavail * bsize`。正常文件测量失败时拒绝准入，错误不带本地路径或 SQL。

新增闭合 RPC `read_disk_status` / `PersistenceClient.readDiskStatus(signal?)`，返回实际占用、剩余空间、配置和 `ready / high_water / completion_headroom` 状态。查询受取消控制；不增加 SQLite Migration，不修改历史 checksum。

## 新工作与已接纳事实

以下检查在写入新事实前执行，失败为稳定 `storage_not_ready`：

- 新 Signal 接纳；原 Signal 的去重读取仍允许；
- 新 Cycle adoption；原采用的严格幂等重放仍允许；
- 新效果准备；相同未关闭准备的原请求重放仍允许；
- 新 Scene commit；相同业务键、相同请求的原提交重放仍允许。

事务失败不分配新的 Signal 序号、不推进 consumed watermark、不插入新的 Manifest/Usage/Scene。高水位检查不会拦截已接纳 Scene 的音频绑定、片段确认与完成/取消收尾，也不删除 pending/dead 行；这些路径继续使用既有有界效果确认与 Observe 保留记录。

MemoryHost 在 Context 构建前进行可取消的磁盘预检查，耗时计入后续 Recall 的剩余预算。最终是否允许采用仍由 DB Worker 的事务内检查决定，前台健康读数不充当写授权。

`/api/v1/health/ready` 读取同一状态，磁盘高水位、剩余空间不足或检查失败均返回安全的 `503 not_ready`；读取等待上限 250ms。`/health/live` 不访问磁盘，仍只表示进程可响应。Runtime 生命周期状态与已有连接继续保留，便于提交已产生的确认、读取恢复事实及对账。磁盘错误通过既有 ErrorEnvelope 映射为 `not_ready`，不输出文件路径。

## 恢复与验证

真实 DB Worker 测试通过创建 SQLite 大字段使实际 WAL 超过 16 MiB，证明新 Signal/采用/准备/提交拒绝且无新增 Manifest、水位推进；相同准备/提交和 Signal 重试仍可返回原结果。已活动场景确认写入一次，重复回执不重复投影；关闭 Worker、重开数据库后确认正文、游标与待交付 Observe 保留，磁盘仍不就绪。

真实 Runtime HTTP 测试验证从 ready 200 到磁盘压力下的 ready 503，而 live 继续 200；错误不含目录。Context 测试验证等待磁盘检查时取消，不发起 Provider Recall。最终检查与真实 Core/Chromium 结果见 [本轮证据](../evidence/phase4-disk-admission-probe.json)。

## 尚未证明的容量边界

本策略是实际文件占用驱动的准入门槛。它没有为文件系统预分配空间，没有对所有后台写入施加整体硬上限，也没有证明 SQLite 单事务的最坏分配开销。其他进程、Provider 状态/隐私对账和既有交付仍可能消耗剩余空间；达到真实 ENOSPC 后不保证确认能成功。

§9.2 的完整 Gate 仍要求按四个活动 Scene、每 Scene 最多 32 个片段及最多八个 Provider，证明所有正文副本、索引、WAL 和收尾开销的预留，验证后台写入不会侵占该预留，并执行各容量/恢复窗口。8 MiB 写入余量和 160 MiB 空闲下限不能替代这个证明。没有自动删除、VACUUM、强制 checkpoint 或降低历史审计保留；运维提高预算或按已验证维护流程处理后，下一次检查重新判断准入。
