# ADR 0046：真实 Stage 效果事务崩溃恢复

状态：两个 Runtime 效果事务窗口各 20 次通过，完整 Phase 4 仍在实施。日期：2026-09-07。

既有 480 个 Core 联合恢复用例使用 no-op Cycle 或可信输入，不能证明演出端实际效果的恢复。本专项通过真实 Chromium、AudioContext/AudioWorklet、Runtime/DB Worker、已安装 Iris SDK 和隔离 Core API/Worker，补充效果事务提交前、提交后尚未向 Stage 回复两个窗口。

测试先接纳一次真实 Signal，由脚本模型产生两个语义片段。Stage 按真实 Worklet 已渲染样本边界发出第一段回执；测试记录实际 WebSocket 帧，并与 Runtime 收到的 receipt 逐项比对。冻结的摘要、片段范围和音频 Lane 来自正常生产路径，不通过测试端直接提交确认。第二段没有持久确认，不能依据预计播放时间补记。

检查点只安装在可信测试子进程的 Persistence Observer 中，由继承 IPC 启用。普通启动配置和浏览器接口不提供该故障入口。提交前窗口停在确认、Observe、游标与预留余额都已执行写入但尚未 COMMIT 的事务内；提交后窗口停在数据库已经 COMMIT、Client 尚未回复时。独立只读连接核对 Bellis 自有审计表，随后仅对该测试创建且仍存活的 Runtime 发出 SIGKILL，等待确切退出，再使用原目录和相同逻辑 Session 配置启动新进程。

两个窗口的期望不同：

- 提交前：事务内的确认和 Observe 都不可见，重启后仍为零；不把已渲染但没有持久证明的内容推断成已确认。Core 对该输出流返回 null。
- 提交后：原 receipt、Observe 正文/摘要、eventId、Outbox 身份与 source cursor 保持不变；正常 Outbox 在重启后通过安装 SDK 投递，Core 源游标为 1。独立公共客户端按原批次键重放得到原 ACK，再用新测试批次键及原记录键验证同一个 Canonical ID，新增事实与投影任务均为零。

两个窗口都保留原 Manifest，不再次请求旧 Cycle 的模型；恢复关闭旧效果准备记录并释放未使用的完成配额。Stage 页面支持可选 `resumeSessionId` 查询参数，认证时传给既有的受 startup token 保护的 Session 恢复接口。浏览器重新认证须返回原 Session ID 与 `resumed=true`；随后触发一个新的 no-op Cycle，核对下一轮 Context 的本地确认历史包含原 receipt ID 和已持久确认前缀，且没有第二段。不能用新 Session 的 Core Recall 命中替代本地历史恢复证据。监听真实 `scene.commit` 帧，确认旧 Scene 不自动重播。这里的音频证据是 Worklet 渲染，不声称测量了物理扬声器。

运行入口：

```sh
IRIS_CORE_PYTHON=/absolute/verified-core-env/bin/python \
IRIS_PROBE_REPORT=/absolute/output/stage-recovery.json \
pnpm test:memory:iris:stage-recovery
```

该命令包含根工作区和独立 Provider 构建，每窗口执行 20 次，成功退出 0 仅表示这两个 Runtime 窗口通过。调试可用 `node scripts/iris-public-probe.mjs --stage-recovery --recovery-smoke`，每窗口一次，报告明确标为 smoke。默认浏览器套件没有 Core 操作者时跳过本专项，不将跳过记为已通过。

本专项没有在效果事务窗口终止 Core API/Worker，没有在活动 Stage 的 Observe HTTP ACK 窗口注入故障，也没有施加磁盘/WAL 压力。因此不能与此前 480 个不同作用域用例简单相加宣称完整恢复矩阵完成；`test:memory:iris:recovery` 仍保留 incomplete/退出 2。已归档 [本轮摘要](../evidence/phase4-stage-effect-recovery-probe.json) 与 [40 次逐次原始报告](../evidence/phase4-stage-effect-recovery-raw.json)。本次使用固定 SDK 0.11.2 和候选 Schema 20 Core，默认支持范围未扩大。


完整专项命令（含构建）退出 0：40 个不同 receipt、40 条原 Manifest 保持；提交前 20 次零观察/远端 null，提交后 20 次各保留唯一 Canonical ID。原确认的正文和摘要、Observe 身份与游标不变，剩余完成配额全部释放，没有旧 Scene 重播。Stage 类型/lint/格式与 66 项单元测试通过；既有浏览器回归 3 项通过、2 项 Core 专项按预期跳过。增加恢复参数后另行运行真实 Core/Chromium 三轮正常输出，四条 assistant Observation 和三次 Usage 均通过，见 [联合回归原始报告](../evidence/phase4-stage-recovery-browser-regression-raw.json)。Stage 页面增加原 Session 的恢复参数转发；Runtime/Provider/持久化生产源码未修改。本轮执行 Stage 单元测试与真实浏览器验收，不重复此前根完整检查、Provider 100 项、480 恢复用例和六个快照场景，也不将这些历史次数累加到本专项。

## 活动 Stage 的 Observe 交付窗口

`pnpm test:memory:iris:stage-observe-recovery` 复用同一真实 Worklet/Control/效果事务链路，在已经持久化第一段确认后，分别停在三个交付窗口。测试只在隔离 Runtime 的安装 SDK 传输装配中暂扣请求或响应，并由可信 IPC 启用；没有生产 HTTP/WS 故障入口。

| 窗口 | 本地效果/Observe | Core 源游标 | Provider 持久 ACK 游标 | 宿主 Outbox |
| --- | --- | --- | --- | --- |
| 请求已准备、实际 fetch 尚未调用 | 已提交 | null | null | in-flight |
| Core 响应已被测试传输层读到、尚未交给 SDK | 已提交 | 1 | null | in-flight |
| Provider observe 已返回、宿主尚未结算 | 已提交 | 1 | 1 | in-flight |

第二行不声称 Runtime 进程完全没有收到网络字节；暂停位置是安装 SDK 尚未获得 Response。第三行同时证明 SDK 已接受 ACK、Provider 的游标状态已持久化。Core 状态由独立公共 sourceCursor 调用核验；宿主状态通过自身 DB Worker 读取，不能以测试进程知道 ACK 就提前标记 delivered。

达到窗口时核对真实 Scene 仍未终结、本地 Observation 对应原 Worklet receipt 且 Outbox 正在投递。随后 SIGKILL Runtime，恢复原目录及 Session，等待原 Lease 正常回收。每次比较崩溃前准备请求与重投请求的正文摘要、记录、批次键和原 ACK；第一窗口的准备请求没有发出，只有恢复后的一次实际 HTTP 调用，另两个窗口各有两次实际调用。独立新批次键/原记录键重报只能指向原 Canonical ID，不能产生新观察或投影任务。

所有窗口都必须在下一轮本地确认历史中找到原 receipt ID，排除未确认后半段、原 Scene 自动重播和重复确认，释放旧 Scene 的未用完成配额。每窗口要求 20 次；`--stage-observe-recovery --recovery-smoke` 只运行每窗口一次。该系列仅终止 Runtime，Core API/Worker 进程组合和容量压力仍需独立验收。
