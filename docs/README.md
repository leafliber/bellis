# Bellis 文档

Bellis 当前已有决策、工具、演出与限定 Iris 恢复链路，完整直播套件仍待交付。计划不代表实现，浏览器夹具通过不代表真实 TTS、Live2D、直播平台或游戏验收通过。

## 从这里开始

| 要解决的问题 | 入口 |
| --- | --- |
| 现在到底完成了什么？ | [当前能力与验收状态](./reference/current-status.md) |
| 接下来先做什么？ | [Phase 5–8 双线路线图](./plans/README.md) → [Phase 5 执行入口](./plans/phase-5.md) |
| 直播还缺什么？ | [直播套件工作线 L5–L8](./plans/live/README.md) |
| 游戏平台怎样接入？ | [游戏平台工作线 G5–G8](./plans/game/README.md) → [G5 实施指南](./plans/game/phase-5.md) |
| 如何安装、运行、验证？ | [构建与验收](./guides/build-and-validation.md)、[Iris 运维](./guides/iris-runtime.md) |
| 系统最终要做成什么？ | [架构设计](./architecture/overview.md)、[技术选型](./architecture/technology.md) |

## 目录职责

| 目录 | 内容与维护方式 |
| --- | --- |
| [plans/](./plans/README.md) | 当前和后续计划；双线依赖、验收 Gate、外部条件。替换更新，不追加切片日志 |
| [reference/](./reference/README.md) | 已实现能力、准确限制和证据索引；当前状态只有一个总入口 |
| [guides/](./guides/README.md) | 当前可执行的安装、构建、运行与运维步骤 |
| [architecture/](./architecture/README.md) | 长期架构和技术选择；其中的目标不推定为已实现 |
| [protocols/](./protocols/README.md) | 已实现、已冻结且由契约测试保护的协议 |
| [adr/](./adr/README.md) | 跨包边界、协议和兼容性决策；编号保留，切片进度不新增 ADR |
| [validation/](./validation/README.md) | 专项验收方法、覆盖和限制；不储存逐次机器输出 |
| [evidence/](./evidence/README.md) | 有界机器摘要；历史来源、哈希和冻结结果保留 |
| [research/](./research/README.md) | 带时间与来源边界的调研，不能充当稳定接口规范 |
| [design/](./design/README.md) | 外部设计原文快照；采纳与差异记录在 ADR/计划中 |
| [examples/](./examples/README.md) | 运行配置示例，不含真实凭据 |
| [archive/](./archive/README.md) | 历史计划、切片日志与旧验收快照；不作为当前排期或完成状态 |

## 文档维护规则

1. `docs/` 根目录仅保留本索引。先归类，再新增文档；同主题状态与摘要优先更新已有文件。
2. 产品排期以 [双线路线图](./plans/README.md) 为准；细分 Gate 由各工作线维护。历史 Phase/Milestone 编号不能推导当前完成度。
3. 状态区分“已有实现及限定证据”“待实施”“未运行/受外部条件阻塞”。完成记录必须指向实际命令、环境、安装物与结果，不引用计划自证完成。
4. 已交付协议更新到 `protocols/`；尚未冻结的接口留在 `plans/`。ADR 记录决策，PR/提交记录切片经过，历史日志入 `archive/`。
5. 迁移文档同时修正仓内相对链接、代码注释中的路径和索引；不保留重复正文或根目录跳转文件。外部旧路径从 Git 历史查找。
6. 用户设计快照和证据 JSON 保持来源语义；不为整理目录改写历史命令、hash 或通过结论。原始报告归 artifact，预算见 [证据规则](./evidence/README.md)。
7. 所有命令默认从仓库根运行。尚未实现的测试命令只描述为交付要求，不混入 [可执行命令表](./guides/build-and-validation.md)。
