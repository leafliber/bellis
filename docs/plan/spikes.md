# 技术探针

探针验证会影响设计的外部假设，结果不能替代生产 SUT 或发布验收；失败与未覆盖范围同样保留。探针代码只放在 `tools/spikes/`，不能作为生产适配器接入。本表只列 P0/P1 需要的探针，其余见 [docs/future/plan/spikes.md](../future/plan/spikes.md)。

负责角色目前均为项目维护者与对应平台实施者，具体人员待认领；计划复核日期为 **2026-09-25**，用于补齐环境与排期，不是交付承诺。

| ID | 假设与目标 | 当前结论 | 尚需的环境/证据 | 未成立时的设计影响 |
| --- | --- | --- | --- | --- |
| S-1 | OBS/CEF 的 IndexedDB 可跨刷新/卸载/重启保存不可导出签名密钥（19.3） | PARTIAL：macOS 隔离 Chrome 的首次、刷新、页面重开、浏览器重启路径签名成功，公钥指纹一致，私钥导出被拒。`reports/spike-browser.json` | 本机标准位置未安装 OBS；目标 OBS/CEF 的隐藏卸载、重启及系统重启仍 PENDING | 不支持时只允许人工重新配对的受控测试；持久身份设计需调整，不能换成长URL令牌 |
| S-2 | AudioWorklet 可运行，getOutputTimestamp 可关联输出位置（12.7–12.8） | PARTIAL：同一 Chrome 环境静音 Worklet 有实际回调，时间戳有限且递增 | OBS/CEF、已知 PCM 的真实录制偏差、欠载/爆音与完整负载仍 PENDING；headless 使用显式 autoplay 测试开关 | 重新界定内容位置估计、误差与字幕能力，不以 currentTime 伪装实际输出 |
| S-4 | SQLite 状态与 Outbox 在崩溃窗口一致（10.5、22.2） | PARTIAL：已提供并运行本地 WAL/FULL 的 SIGKILL 窗口及 SQLITE_FULL 页数限额注入；结果见 `reports/spike-sqlite.json` | fsync/VFS 故障、真实断电、物理磁盘耗尽、目标 Windows 文件系统与生产 SUT 仍未覆盖 | 调整持久化确认、记录缺口和恢复顺序；不能把 SQLite 本地事务扩展成远端效果原子性 |

## 本机复现

先按 [AGENTS.md](../../AGENTS.md#命令) 安装锁定环境。数据库探针只使用新建的临时数据库：

```bash
pnpm spike:sqlite
```

在现有 Chrome 的独立临时配置中运行浏览器预验证，不使用日常浏览器资料：

```bash
BELLIS_PROBE_CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' pnpm spike:browser
```

目标 OBS 的人工探针使用固定 Origin，测试期间不要更换端口、协议或主机名：

```bash
pnpm spike:serve
```

在隔离的 OBS 浏览器源中打开 `http://127.0.0.1:17869/stage.html`，用页面按钮执行密钥与静音音频探针，逐次保存页面结果；重启前后保持同一 Origin。这不是 Stage 配对实现，不连接 Bellis 权限或真实内容。

## 证据要求

每次保留日期、系统/浏览器/OBS/驱动版本、命令、脚本指纹、样本数、原始结果和限制。自动化结果写入 `reports/`，由 CI 上传；它们是本次运行的原始证据，不是永久可引用的发布证明。探针改变设计时，直接修改对应 `docs/spec/` 和 `contracts/src/`，不建立补丁规范。
