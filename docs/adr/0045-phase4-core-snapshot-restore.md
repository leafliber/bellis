# ADR 0045：两端旧快照与事件分叉验收

状态：Core 两个冷恢复、Bellis 删除前回退和三个 Observe 冷快照场景已通过。日期：2026-09-07。

ADR 0044 已证明正式 Provider 发送成对检查点，但故意填入不同事件身份只能验证错误处理，不能证明实际备份恢复后的行为。本验收通过已安装 Core 的公开 CLI 和业务 API 构造真实历史分叉。

Core 每个场景先用公开 Observation/Claim/correct API 创建一个正游标，真实 Provider 从事件流消费并持久确认，不直接写宿主检查点。真实 Runtime 接纳一次输入并完成 Cycle、Manifest 与 Usage ACK。可信测试操作者调用 `migrate --with-backup --backup-key-file`：当前库没有待应用迁移，输出须为 `applied=0`，但仍创建并验证签名备份。密钥由随机私有文件传入，正文不进入命令参数或报告。

备份后再公开纠正同一 Claim，等待 Provider 确认新事件身份，然后构建一个仍有效的 Context。测试仅暂缓后续事件请求，不修改请求头、SDK 选项或响应。操作者停止自己创建的 Core API/Worker，确认退出，再通过 `restore --backup-key-file` 冷恢复到新隔离目录，以原服务地址启动替代进程。

恢复后的两种场景：

- 缺失锚点：原备份的正游标和事件身份仍可公开验证，但备份后的原锚点不存在；成对请求返回 410。
- 游标复用：在恢复后的分支重新纠正 Claim，新事件使用原来的数字游标、不同事件身份；原检查点仍必须返回 410，不能把数字相同视为已经追平。

公开独立客户端用备份前原 Usage 正文和幂等键重放，核对相同 report ID 与 stages；这证明备份中已有的确认事实保留，不授权普通宿主越过屏障。恢复事件轮询后，Provider 自身收到 410，取消旧 Context、保留原配对检查点与缺口身份，宿主拒绝 Usage 交付。Bellis 的两条原请求、一条 Manifest 和一条已确认 Usage 逐项保持。原数据目录重启进入 recovering，live 200、ready 503、普通决策管道不启动。

测试操作者只调用 Core 的公开 CLI；业务验证只用 SDK/HTTP。只有 Bellis 自身的审计 DB 被读取；不查询 Core 私有表、不复制活跃 Core 数据库、不以日志推断 Canonical 结果。

运行入口为 `pnpm test:memory:iris:snapshots`，需指定兼容矩阵中具备检查点能力的真实 Core 安装路径。Core 两个确定性场景分别运行一次；这不增加既有 SIGKILL 窗口的 20 次计数，不是完整恢复矩阵。冷恢复到新目录不覆盖原目录切换故障、最新删除账本合并、全部 cursor 偏差或历史安全解除。完整 A4 与 Phase 4B 保持未完成。

最初 Core 专项 `pnpm test:memory:iris:snapshots` 退出 0，包含根工作区和独立 Provider 构建。两个场景各保留两条请求、一条 Manifest 和一条 Usage；原 Core Usage 报告身份与 stages 也经过公开重放核对。见 [摘要](../evidence/phase4-core-snapshot-restore-probe.json) 与 [原始结果](../evidence/phase4-core-snapshot-restore-raw.json)。生产代码未变，本轮未重复完整根测试或此前恢复矩阵。


## Bellis 删除前旧快照

同一命令现先运行 Bellis 冷恢复，再运行上述两个 Core 场景。真实 Runtime 的已采用 Manifest 引用了目标 Claim，准备后的 Context 包含仅来自 Canonical 的唯一 canary。Runtime 及其 DB Worker 完全关闭后，复制整个数据目录并计算逐文件摘要。Core 随后通过公开 Forget 删除 Claim；宿主先正常追平并持久保存删除，再关闭、保留这个较新目录，将原备份整体复制回配置指向的数据目录。恢复目录摘要必须与原备份完全一致，不能只修改一个游标或策略字段模拟回退。

恢复后 Core 保持在线，包含较新的删除事实。测试暂缓 SSE 读取以核对追平前的 live Recall：新 Context 不含 canary 和已删除 Claim 引用；原 Recall 重放返回 409/conflict，原 remember 幂等键重放返回 404/not_found，公开 getClaim 仍为 404。释放 SSE 后，Provider 从备份原配对检查点追平，重新持久化相同删除墓碑和事件身份，取消追平前的 Context。旧 generation 的 Usage 被隐私准入拒绝，原 Manifest 和 Outbox 正文/状态逐项保留，重复 Forget 返回原回执。

再次关闭重启后，首个事件请求携带删除后的配对检查点，策略 generation 不再增加，墓碑仍在且 Runtime ready；新 Context 继续没有 canary。整个测试只读取 Bellis 自有审计表，Core 只通过公开 API 访问。

扩展后最终命令（包含构建）退出 0，三个场景各一次通过。见 [本轮摘要](../evidence/phase4-host-snapshot-restore-probe.json) 和 [联合原始结果](../evidence/phase4-both-snapshots-raw.json)。本场景不证明 Core 离线时的人格回退、全部资源类别、pending Observe 快照、两端同时回退、在线备份产品或完整 A4 恢复矩阵。根完整测试及 Provider 100 项测试沿用此前生产源码相同的基线，本轮未重复执行。

## 待交付 Observe 的旧快照

快照命令再加入三个 Observe 场景：发送前、Core 已提交/HTTP ACK 未转发，以及 SDK 已确认/宿主 delivered 未提交。使用既有真实 Runtime 子进程、DB Worker 和固定目的地址代理。检查点分别记录 Core cursor 为 null/1/1、Provider cursor 为 null/null/1，宿主行均为 in-flight 且 delivered 为 0，不把未知结果归为未写。

测试终止自己创建的 Runtime，等待 SIGKILL 的确切退出，再复制完整冷目录（包括尚在目录中的 SQLite WAL）。先用原目录完成恢复并确认 delivered=1，然后关闭、保留这个较新目录，真正回退至原冷快照；摘要必须完全相同。Core 保持较新的 cursor=1。第二次恢复仍使用原 event/outbox ID、逐字节 HTTP 正文摘要和批次键，不能通过改写本地 delivered 或源游标假装对账成功。

三次实际 HTTP 投递（原请求、首次恢复、旧快照恢复）得到同一个 Canonical Observation ID。再以测试专用新批次键和原记录幂等键请求，必须 accepted 为空、duplicate 指向原 ID、outbox_enqueued=0；这验证记录级去重，不只命中原 HTTP 响应缓存。最终宿主恰有一条 delivered，Provider/Core cursor 都为 1，无 pending/in-flight/dead。

这些是每场景一次的实际快照回退；与既有 20 次 SIGKILL 矩阵分别记录。它们不覆盖删除后的 Observation 重投、同时回退 Core、真实 Stage 效果快照或在线备份流程。

最终扩展命令（含构建）退出 0，六场景各一次通过。同时在当前 SDK 0.11.2/固定 Schema 20 Core 上重新运行全部已实现的恢复矩阵：24 个窗口/进程组合各 20 次，共 480 次通过。矩阵入口仍退出 2，完整 A4 未完成。原始报告及摘要见 [本轮证据](../evidence/phase4-observe-snapshot-restore-probe.json)。
