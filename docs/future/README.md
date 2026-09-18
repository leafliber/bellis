# 冻结的后续阶段设计

这里保存 P2–P8 与 C0–C5 阶段的 v0.8 设计：规范小节、登记条目、fixture 和技术探针。它们是后续阶段的设计输入，不是现行规范。

- 不实现、不生成、不校验；`pnpm check` 不读取本目录。
- 与现行规范或 `contracts/src` 冲突时，以现行内容为准。
- 条目可能引用现行登记中的定义名（例如 `CommandContext`、`TerminationRecord`），这些定义在 `contracts/src/schema.json` 或由生成器派生。
- 文中残留的 `{{…}}` 占位符原本由旧生成器展开成表格；迁回时改为引用生成的契约简报。
- `contracts/events.json` 中的 `payload_refinement` 是五个策略更新事件对载荷的额外约束（原写在 EventEnvelope 中）；迁回时需要让生成器把它并入事件绑定。

## 内容

| 位置 | 内容 |
| --- | --- |
| [spec/](spec/) | 按原章号保存的后续阶段章节与小节：第 6、8、9、10、13–16、18、23 章整章，以及其余各章中标注为后续阶段的小节 |
| [contracts/](contracts/) | 与 `contracts/src` 同名的登记文件，只含后续阶段的状态机、事件、命令、错误码、不变量、测试、Schema 定义等；另有 `readiness.json`（外部事项）和 `fixtures/` |
| [plan/spikes.md](plan/spikes.md) | 后续阶段的技术探针 |

## 迁回某个阶段

进入某阶段时，把该阶段的设计迁回现行规范：

1. 在 `contracts/src/verification.json` 的 `phase_dependencies` 与 `phase_checks` 中加入该阶段。
2. 把该阶段的登记条目从 `docs/future/contracts/*.json` 移到 `contracts/src` 同名文件；Schema 定义移入 `contracts/src/schema.json`。记录的状态字段改为引用 `<状态机>State`，事件名、原因码等内联枚举改为引用派生类型。测试条目去掉 `procedure`/`expected`，性质与必测方向只保留在 `invariants.json`。
3. 把相关规范小节移回 `docs/spec` 同名文件，按实现反馈修订，更新章首的冻结说明。
4. 为该阶段编写 `docs/plan/<阶段>.md` 任务卡，运行 `pnpm generate` 与 `pnpm check`。

迁回是修订，不是原样复制：只保留当前阶段确实需要的内容。
