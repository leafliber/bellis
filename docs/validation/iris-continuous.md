# Phase 4 真实连续纵向验收

此验收覆盖开发指南 §11.5 的连续纵向行。它在同一个真实 Runtime 子进程、DB Worker、Core API/Worker 和 Chromium 会话中运行 100 个 Cycle；模型和 TTS 使用既有确定性测试边界。双进程崩溃窗口、长期资源增长及总磁盘配额仍须另验。

## 运行

先按兼容矩阵准备非 editable 的 Core wheel 安装。安装文件必须与 wheel 一致，CLI 初始化隔离数据库和应用凭据；所有临时服务使用 loopback。缺少安装路径时退出 2，不能视为通过。

```sh
IRIS_CORE_PYTHON=/absolute/isolated-venv/bin/python \
IRIS_PROBE_REPORT=/absolute/output/phase4-continuous-core-probe.json \
pnpm test:memory:iris:continuous
```

命令先构建 Runtime/Provider 并运行审计反例测试，再启动真实公共消费与浏览器验收。运行期间每 10 轮打印进度。默认 `demo:phase4:iris` 仍使用三轮；两种模式共用实际 Lane、输出确认与逐轮审计实现。

## 证据来源

| 核验项 | 实际证据与拒绝条件 |
| --- | --- |
| 每轮真实采用 | 测试包装器仅在真实 `phase3AdoptCycle` ACK 后记录 Session/Cycle 标识；审计从 DB Worker 重新读取 Manifest。模型请求数、采用数、Usage ACK 数必须相等。 |
| Prompt 与来源 | 持久 Manifest 摘要、模型实际 Prompt 摘要及 Manifest ID/Epoch 必须匹配；已采用 Block 的 revision、公开来源引用与 Core 原生摘要必须与该轮真实 Recall 返回一致。Core 来源摘要保持原格式，不伪称为 SHA-256。 |
| Persona 与预算 | 每轮 Recall 必须成功，其 persona revision 与 Manifest Persona Slot 相同；估算输入不得超过配置上限。 |
| Usage 三集合 | 仅在真实 Provider 调用获得 Core ACK 后记录；requestId、cycleId、persona revision、returned/hostSelected/modelVisible 三集合必须与持久 Manifest 相同，每轮使用唯一 Usage Outbox 身份。 |
| 实际输出 | 逐轮等待 Worklet/字幕输出经过 Runtime/DB Worker 并获得 Core Observe ACK，核对内容、确认范围和连续源游标；下一轮开始前等待前一 Scene 释放。最终公共 `sourceCursor` 必须与实际输出数量相同。 |
| 隐私中断 | 最后一轮仍在第二语义片段播放时提交隐私屏障；只有已渲染的第一片段进入 Observe，字幕清空、Scene 释放且策略 generation 持久更新。 |
| 关闭 | Playwright fixture 要求 Runtime 正常退出、Vite 停止并移除临时目录；注入的 DB Worker 由测试操作者显式关闭。父进程再停止隔离 Core 服务。 |

报告保存每轮身份、摘要、版本、预算、三集合和 Usage 身份，以及测试输出事实。凭据只写入临时 owner-only 配置文件，不写入报告、浏览器或 IPC。模型完整 Prompt 不写入最终报告。

审计反例测试覆盖 Prompt 被改写、Core 来源摘要不一致、Usage 集合变化、Manifest 摘要不匹配、超预算与 Persona revision 不一致。该测试不能替代真实 100 轮运行。

## 当前结果

100 轮真实运行通过，退出 0：100 份持久 Manifest、100 次 Usage ACK、101 条实际输出，Core 源游标 101。每轮 Persona/Recall revision 均为 1、Prompt Epoch 保持一致；最大输入估算 6,857，配置上限 16,000。最后一轮隐私 generation 更新到 1，未完成片段没有被观察。

见 [验收摘要](../evidence/phase4-continuous-probe.json) 和 [逐轮原始报告](../evidence/phase4-continuous-core-probe.json)。此结果仅覆盖连续纵向项，Phase 4 尚未完成。
