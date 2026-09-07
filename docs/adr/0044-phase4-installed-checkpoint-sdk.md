# ADR 0044：正式安装物与检查点请求对齐

状态：实现及本机安装验证完成。日期：2026-09-07。

开发指南 §0.1 允许固定候选安装物。SDK 0.11.2 已有不可变压缩包及公开边界证据，但此前只有独立探针消费者使用它；正式 Provider 仍使用 0.11.1，且 `events()` 没有传出已保存的事件身份。因此原探针不能证明正式请求链的检查点校验。

把既有压缩包原字节保存到 Provider 的 `vendor/`，通过相对 `file:` 依赖和 pnpm integrity 锁定。包内四个文件的摘要、来源证据和许可证随安装物保存；不使用跨仓库源码 alias、运行时 `/tmp` 路径或 registry 发布。原发布申请仍未执行，本地安装不需要该发布。将来更新包必须同时更新版本、压缩包、摘要、锁文件和对应验证，不能同名覆盖已有安装物。

正式 Provider 在 Core 声明 `events.checkpoint.v1` 且已有持久事件身份时，把 `after` 和 `afterEventId` 一起交给 SDK。未声明能力的旧 Core 仍只接收原游标；新流不伪造身份。旧状态缺少身份时继续使用 ADR 0030 的缺口屏障。状态保存失败后重试旧的一对值；重启也使用这对持久值。SDK 的公开头编码和 Core 的 410 检查属于真实 HTTP 验证范围。

公开探针现在解析正式 Provider 的同一已安装 SDK，先核对压缩包和四个安装文件，再消费其公开导出。历史缺口探针只控制读取时机、构造本地测试历史，不替 Provider 补写 `afterEventId`。缺口仍需先持久封锁、取消旧 Context，再进入只读维护；本改动不解除缺口。

Provider 新增独立 `check` 命令，现有 macOS/Windows CI 在根构建后安装并检查它。候选包使该步骤不依赖本地 Verdaccio；远端 CI 是否通过必须由实际 Job 结果证明，本机结果不代替远端运行。根离线检查仍不依赖真实 Core。

本机已通过新临时目录的冻结离线安装、100 项 Provider 测试及类型/lint/格式/构建。真实 Core 0.12/Schema 14 与 0.13/Schema 15 的 Chromium、Persona、Recall、Usage、Observe 回归通过；Schema 15 另通过已实现工具路径。固定 Schema 20 wheel 的检查点、历史维护、真实 Chromium、启动器与凭据轮换联合验证通过。默认 Core Schema 范围仍为 14–15，Schema 20 保留明确候选配置，不把版本号相同的不同 wheel 视作等价。新依赖下另通过既有 24 组恢复冒烟，完整恢复入口继续退出 2。证据见 [本轮摘要](../evidence/phase4-installed-checkpoint-sdk-probe.json)。

这不证明任意日志篡改、真实旧备份恢复、全量历史事实核验与安全解除，也不代表完整 A4 或 Phase 4B 已完成。
