# ADR 0041：Iris 启动配置与凭据引用

状态：配置加载、固定启动入口及真实安装验证已完成。日期：2026-09-07。

新增 `pnpm start:iris --config /absolute/config.json`，使用已构建的 Runtime 和固定本地 Iris Provider 安装入口。配置不能选择模块路径或执行脚本；Iris 禁用时不导入 Provider、不读取凭据，沿用无记忆的 Runtime 装配。模型、Stage 和网络接口均不能提交此配置。

配置使用版本 1 严格结构，只接受环境变量或绝对文件路径凭据引用，拒绝内联 token。Runtime 配置与凭据值分开保存；启动失败只输出固定错误，不回显原配置、文件路径、token 或上游异常正文。配置读取最多 64 KiB，凭据最多 8 KiB；通过单个描述符读取并限制增长后的分配。文件必须为普通文件；POSIX 上 token 文件必须为当前用户所有且无组/其他用户权限，使用 O_NOFOLLOW 拒绝符号链接。Windows ACL、重解析点与远程安装仍需独立验证，不能引用 macOS 测试宣称通过。

Iris URL 必须是显式允许列表内的精确 Origin：HTTPS 或 loopback HTTP，无路径、userinfo、查询或片段；HTTP Adapter 继续拒绝重定向。业务 appInstanceId、agentId、spaceId、固定读取 actor、隐私标签和空间共享确认来自可信配置。读取 actor 是明确选择的上下文身份，不能把它当作任意观众输入的身份解析；本入口未启用自动输入 Observe 或写工具权限装配。

默认 Core Schema 范围保持 14–15，Surface 仅接受明确的 off；未知或 required 模式不会静默降级。操作者可明确选择其他 Schema 范围用于已核验候选，但配置声明不等于新增兼容证据。真实验证中的 Schema 20 仍依赖既有精确 wheel 核验与安装文件检查，不改变默认支持矩阵。

正常启动时一个 Iris 实例同时持有 MemoryProvider 与 PersonaSource 端口；可选历史恢复使用独立 Verifier，随 Runtime 关闭停止。SIGINT/SIGTERM 走统一关闭。新入口默认不打印 token；显式 `--print-startup-token` 只在 ready 时输出一次性本地会话 token，业务 Iris token 永不输出。模型与演出宿主须在配置中显式启用。

这提供可重复的可信文件启动路径。生产输入身份/工具授权、凭据轮换与撤销的完整生命周期、Core Session 映射、全部历史事实核验及安全解除仍待交付。

最终根检查退出 0：1054 项单元/性质测试、274 项集成测试通过，168 个生成契约无漂移。五项配置专项与真实 CLI 的启用、重启、禁用、缺失凭据四场景通过；实际命令正常关闭退出 0，缺失凭据退出 1。原默认 paceMs 0 的重复解析问题已修复并通过根检查与实际命令复跑。Core/Chromium 联合回归及工具、既有 24 组恢复冒烟通过，完整恢复仍退出 2。见 [本轮证据](../evidence/phase4-iris-launch-probe.json)。
