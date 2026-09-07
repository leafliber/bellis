# ADR 0037：原 Recall 请求的受控核验调度

状态：维护调度、独立公共核验通道及真实安装验证已完成；全量重验和安全解除未完成。日期：2026-09-07。

有持久历史缺口时，普通 MemoryHost 启动会失败并停止 Provider。恢复操作因此不能复用该实例已经取消的普通 Recall 生命周期，也不能为恢复而放开 Persona、Context 或 Outbox。新增独立 `MemoryRecallVerifier` 契约、Iris `IrisRecallVerifier` 和 Runtime `Phase4HistoryRevalidator`，由可信维护装配显式创建、运行与停止。它们可在普通宿主停止时工作。

Iris 核验通道使用同一明确配置的 HTTP origin、凭据、agent 和 space。每个批次都经已安装 SDK 的公开 negotiation 核对 Schema 范围及 `recall.revalidate.v1`，随后通过有界 HTTP 调用 `/v1/recall:revalidate`。默认 Schema 范围仍为 14–15；Schema 20 候选只在精确安装探针中配置。原请求内外身份必须相符；保持完整原 body 和其原 deadline，另给批次设置新的截止时间。响应必须包含唯一且完整对应的 requestId 和合法结论，拒绝缺项、重复、外来身份和非法状态。

DB Worker 新增发送前专用读取端口。它复核当前清单、实际隐私 blocked 字段和原请求归属；历史缺口本身不禁止维护核验，真实隐私屏障仍禁止发送。原准备策略 generation 与当前清单不同时返回未授权，不自动重新授权旧请求。此类记录继续算未核验，等待明确的历史隐私授权规则。

调度器固定 scope/provider/agent/space，使用调用者明确提供的原 runId 开始或恢复清单。每次读取最多 64 项，发送批次最多 16 项、正文合计不超过 900000 字节，重复 requestId 的不同尝试拆成不同批次。发送前再次执行专用准入读取；公开响应与原项身份一一对应后，交给 ADR 0036 的事务端口保存。重启后读取持久覆盖进度，已保存项不重新请求。原 run 失效时拒绝，调用者需显式选择新 run。

总运行期限最多 60 秒，Iris 单批最多 30 秒。取消和停止覆盖等待与网络请求；不合作的底层调用未结束时继续占用单个并发名额，迟到返回不会继续发送或写结论。调用者须先停止普通宿主，或在改变实时隐私前取消维护操作；这里的发送前事务检查并非覆盖网络调用的跨进程隐私锁。自动启动/后台重试及与 Runtime 隐私生命周期的进一步装配仍待完成。

进度区分 valid、unavailable 与未核验，始终报告 incomplete。核验期间不启动 Persona/SSE，不写 Recall/Usage/Observation ACK，不解除缺口。其他事实的公共核验、旧策略请求的明确授权、跨批次共同快照、自动恢复装配及安全解除仍需实施，不能把本通道当作整个 A3/A4 Gate 已完成。

本轮根检查通过 1049 项单元/性质测试和 263 项集成测试，168 个生成契约无漂移。随后按真实 SDK 的嵌套 scope 修复 Iris 身份检查，最终 Provider 96 项及类型、lint、格式、构建通过；Runtime 四项专项包含新增丢失核验 ACK 的重启用例，未将该增量伪计为根检查重跑。最终真实 Core/Chromium 已验证生产维护调度、公开通道、原正文、结论落盘和重启不重复请求。

工具及既有 24 组恢复冒烟通过，完整恢复入口保持退出 2。安装物、最终源码摘要与验证范围见 [本轮证据](../../../evidence/phase4-revalidation-coordinator-probe.json)。
