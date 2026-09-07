# ADR 0042：记忆屏障与 Runtime readiness

状态：实现、专项测试及真实凭据撤销验证已完成。日期：2026-09-07。

Runtime 原 readiness 只在 MemoryHost 持有历史缺口时报告 recovering。Persona 已失效或真实隐私已封锁时，Context 构建会拒绝，但 HTTP ready 仍可能是 200。新增宿主只读 `readiness`，返回有界原因：starting、closed、history_recovery、privacy_blocked、persona_unavailable 或 ready，不包含凭据、异常正文或 Persona 内容，也不发网络请求。

Runtime 在正常监听状态下同时读取历史恢复与记忆准入状态：历史缺口仍是 recovering，其他记忆屏障是 unavailable，ready 仅在二者均允许时成立。现有健康、新会话、新 WebSocket 和已注册决策 HTTP 门禁随之返回不可用。live 仍只表示进程存活。该状态是最近观察到的准入状态，不宣称瞬时获知远端权限变化或替代 DB/Provider 的实际操作校验。

Iris 在公共调用收到 401、403 或隐藏资源权限错误 404/access_denied 时，锁定本实例鉴权失败。立即取消同实例其他在途网络调用、标记 Provider 不健康、停止事件/Lease/兼容投递定时重试，并沿用已有持久 Persona 失效路径通知 Host。Host 取消旧 Context；静态或缓存 Persona 不能重新开放。原凭据、请求身份及待处理事实不被改写。调用者必须修复可信配置并显式重启实例；新生命周期仍先重新协商并验证 live Persona。

Persona 发布撤销与凭据拒绝不同。Persona 撤销保留已存在的修订屏障；迟到或缓存响应不会解除，新的合法 live 修订可恢复该能力。隐私策略仍由持久操作改变，readiness 自身没有解除权限。历史屏障继续在本生命周期保持，不因 ready getter 或核验结论清除。

本项覆盖单 Iris/Persona 所有者。多 Provider 健康聚合、凭据轮换与全部权限收紧变体、跨进程发送锁及历史全量重验仍需后续 Gate。ready 503 不声称能撤回已经在外部完成的副作用。

最终根检查退出 0：1054 项单元/性质测试、275 项集成测试通过，168 个生成契约无漂移；Provider 99 项及类型、lint、格式、构建通过。Runtime 十五项专项含新增撤销/迟到/缓存/恢复/隐私 readiness 测试。真实 Core 公开管理接口撤销临时凭据后，旧 Context 取消、Provider unhealthy、live 200、ready 503 且人格回退被拒绝。Core/Chromium/CLI 联合回归、工具及既有 24 组恢复冒烟通过，完整恢复保持退出 2。见 [本轮证据](../evidence/phase4-memory-readiness-probe.json)。
