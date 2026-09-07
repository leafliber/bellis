# ADR 0031：历史重验的持久范围清单

状态：持久清单及恢复已实现并验证；远端重验结论与解除事务尚未实现。日期：2026-09-07。

断档后的屏障不能因连通恢复或分页结束而解除。公开重验必须覆盖宿主仍保存、可能参与后续 Context 或恢复交付的事实；进行中的确认和原请求 ACK 也可能改变范围。因此先以 Migration 18 固定重验清单，后续结论必须绑定清单摘要，而不能凭一次 Recall 或 sourceCursor 最大值推断完成。

可信 DB Worker 接口以 scope、provider、原 gapId、当前 policy generation 和显式 runId 建立清单。范围包括该 scope 的所有 Context Manifest 和实际效果确认、该 Provider 的 Observation/原 Outbox 正文及 ACK 状态、Usage 正文及交付状态，以及宿主 DB 中的 Provider 状态（包含 Persona 缓存与旧 pending）。所有 Manifest/Observation/效果回执/Provider 状态原摘要先核验。清单只复制身份及摘要，原正文保持在原事实表。

每个缺口仅保留一个当前 run；同一 runId 的同一快照可幂等重试，变化后必须显式建立新 run。替换清单及逐项插入同事务，失败恢复原清单。分页最多 64 个身份，正文逐项按原摘要读取。每次读取在同一数据库快照中重新核验当前集合与持久清单；新确认、ACK、Provider 状态变化、原正文变化或策略代际变化使旧 run 失效。其他 scope 的事实不进入当前清单。

单次清单限制 4096 项、总正文 64 MiB，单项正文读取上限 1 MiB；超限明确拒绝并保持原缺口，不截断后宣称完整。此限制是当前 Worker 的有界处理范围，不是长期增长 Gate 已通过的证明。更大范围需要后续增量扫描与资源验证。当前每页会重验完整集合，性能验收保持开放。

分页 `done` 仅表示清单已遍历，不表示远端有效、重验完成或允许交付。这里不写重验通过状态、不清除 gap、不更新策略代际、不改写原 Manifest/Outbox、不重新执行模型或工具。后续必须接通公开资源/删除/权限和原请求对账、Persona 权威刷新、远端一致性边界及逐项结论，再以仍然有效的清单完成原子解除。配置在宿主 DB 之外的 Provider StateStore 还需要独立覆盖证明；当前清单不能替它作证。

验证：根检查通过 1040 项单元/性质测试、254 项集成测试，162 个生成契约无漂移。四项新增集成测试覆盖五类事实、正文摘要、跨页/重启、范围变化、ACK、策略变化、完整性、失败回滚、空清单与 4097 项超限；之后补充的其他 scope 隔离断言也通过专项测试与类型检查。真实 Core 410/MemoryHost/DB Worker 探针创建并恢复 Manifest、Provider state 和 Usage 清单，原正文摘要一致，屏障保持。独立 Provider 89 项、类型与构建通过。见 [清单证据](../../../evidence/phase4-history-inventory-probe.json)。
