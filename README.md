# Bellis

Bellis 是一个面向 Windows 11 的 AI 主播与通用游戏交互运行时单仓（Python + Rust）。

核心结构将系统收拢为两层：
- **确定性安全与物理执行底座**：安全核（授权、单调许可令牌、急停、SQLite WAL 意图存储）、Rust 实时核（窗口采集、音频回环、共享内存、唯一键鼠写入与低层钩子）、独立外部看门狗、高频音画管线。
- **快慢双主 Agent 事件流循环**：慢主 Agent 负责直播互动与高层任务决策，快主 Agent 负责游戏通用感知与交互执行。

## 文档索引

- Agent 工作规则与防失控护栏：[AGENTS.md](AGENTS.md)
- V2 精简架构与安全边界：[docs/architecture.md](docs/architecture.md)
- 垂直切片路线图：[docs/plan.md](docs/plan.md)

## 历史参考

V1（原 `bellis` 与 `bellis-game-runtime`）已归档于本地 `dev-1` 分支，仅用于白名单移植已真机验证的底层模块与踩坑参考，不推送至远端 `main`。
