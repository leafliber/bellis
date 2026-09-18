# Bellis 规范索引

规范基线 v0.8，协议设计版本 0.8.0（拟议，未发布 SDK）。本目录只收现行阶段（P0/P1）需要的章节和全局原则；章号与小节号保持稳定，缺少的章节和小节属于后续阶段，冻结在 [docs/future/spec/](../future/README.md) 的同名文件中。

机器可读定义（字段、状态机、守卫、事件、错误码、命令、代次、不变量）不在正文重复，见 [contracts/src](../../contracts/README.md) 和按阶段生成的契约简报：[P0](../generated/P0.md)、[P1](../generated/P1.md)。

## 章节

| 章节 | 内容 |
| --- | --- |
| [1 引言](01-introduction.md) | 系统定位、目标与原则、范围、非目标、产品边界 |
| [2 关键设计决策](02-decisions.md) | 执行模型、控制/媒体/数据边界、跨系统整合边界 |
| [3 总体架构](03-architecture.md) | 职责主体、确定性机制、权威划分、微内核、宿主循环、插件清单、隔离 |
| [4 对象模型](04-object-model.md) | 对象层级与ID、权威归属、结果事实分层、运行数据类别、代次与序号 |
| [5 事件流](05-event-flow.md) | 事件信封、目录与防重入 |
| [7 停止与自然完成](07-task-effect-settlement.md) | 停止请求与真实结果的竞争规则 |
| [11 状态机登记](11-state-machines.md) | 登记规则、终止记录、守卫、结果优先级、未知入口与独立清理 |
| [12 流式表达与媒体](12-media-streaming.md) | 双文本、seal、音频流、Stage 链路、同步、背压、软收尾与硬停 |
| [17 内容安全](17-content-safety.md) | ContentGuard 契约、审核失败处理、审核结果与对象转换 |
| [19 本地通道与凭证](19-local-channels.md) | loopback 与 Origin、Stage 配对与短连接凭证、安全渲染、必测项 |
| [20 播出运维](20-broadcast-ops.md) | 四层停止、监督模式与 ExecutionGrant、音画偏移 |
| [21 软实时预算](21-budgets-metrics.md) | 队列限额、首段启动、运行配置示例、观测目标 |
| [22 技术与部署](22-tech-storage-deployment.md) | 技术选择、存储分层、部署视图、插件 Manifest、ABI 与传输 |
| [24 验证与验收](24-verification.md) | 测试层级与证明边界、不变量映射、故障注入 |
| [25 路线与门禁](25-roadmap-gates.md) | 阶段路线、最小闭环、增量实施边界、发布门禁、阶段出口 |
| [26 风险与待决](26-risks-open-items.md) | 未验证事项、残余风险、关闭标准 |
| [附录A 场景走查](a-walkthroughs.md) | OBS 刷新与配对 |
| [附录B 契约登记规则](b-contract-registry.md) | 登记边界、错误、事件、对象记录、命令 |
| [附录C 术语表](c-glossary.md) | 现行术语 |
| [附录D 外部参考](d-sources.md) | 引用资料与核验范围 |

## 当前状态

契约 SDK、模拟协议端点与检查工具可离线复现；生产宿主、真实设备与真机验收尚未开始，所有不变量保持 PENDING_SUT。时延数字均为待测目标，公开运营许可按部署核验。未验证事项及关闭条件见[第 26 章](26-risks-open-items.md)。
