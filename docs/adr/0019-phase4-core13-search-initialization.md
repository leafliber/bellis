# ADR 0019：Core 0.13 搜索初始化与独立安装验收

状态：新库公开搜索 Gate 与真实 Stage 回归已通过；不代表完整 Phase 4 验收。日期：2026-09-07。

## 决策

1. 固定 Core 0.12/schema 14 的新库没有已验证 FTS generation；增量 Worker 不负责建立第一个 generation。此前搜索专项明确退出 2，不能用空结果充当命中或删除证明。该历史安装和报告保留。
2. 当前 Iris 源码已经是 Core 0.13/schema 15。为其可信离线 `init` 增加显式 `--initialize-search`：在租户/身份/凭据的同一事务内构建、校验并切换首个 FTS generation，审计该初始化，并输出非秘密的 search_generation_id。索引不可用或验证失败整体回滚，凭据文件不保留。客户端仍只获得 application 平面的受限凭据。
3. Bellis 只调用可信 CLI 完成初始化；搜索、写入、删除与效果回写仍使用安装 SDK/公共 HTTP，不读取或修改 Core 私有数据库、索引或内部对象。Iris 内部的 FTS 调用与故障注入测试属于 Core 自身实现。
4. 新源码构建为独立 0.13 wheel、安装到新的非 editable 环境，并逐项核对 156 个安装文件。旧 0.12 wheel 和环境未覆盖。两个 wheel 的应用 contracts/source 差异只有 package_version 和 schema_version；应用 OpenAPI 未变，Console OpenAPI 有变化。此比较支持 SDK 0.11.1 的应用接口回归范围，不替代 Console 验收。
5. 探针使用显式版本表：0.12→schema 14，不请求不存在的 CLI 选项；0.13→schema 15，必须初始化搜索。未知版本拒绝。Provider 默认 Schema 窗口扩展至 14–15，并验证 13/16 拒绝；兼容矩阵分别保存两个实测 wheel 的摘要与搜索状态。
6. 0.13 新库的公共工具专项现已验证 remember 后搜索命中、correct 修订冲突、协调 Forget 后搜索消失与 getClaim 404，退出 0。remember 和 Forget 已经由注册适配器及宿主执行；search/correct 的完整生产授权装配仍是独立 Gate。真实 Chromium 回归验证三个 Cycle、四次 Observe、三次 Usage、确认历史和播放中隐私中断。

## 安装与范围

使用新 wheel 环境运行 `IRIS_CORE_PYTHON=/absolute/core13-env/bin/python pnpm test:memory:iris:tools` 或 `pnpm demo:phase4:iris`。探针自动选择对应的固定 Schema 和初始化选项。不要把 0.12 的历史退出 2 改写为通过，也不要把本次新库验证解释为已有数据库迁移成功。

已有 Core 数据的 14→15 升级必须使用 Core 的离线备份迁移流程；本次没有原地升级用户数据。生产 SQLite、Surface required/advisory、Legal Hold/保护对象、Persona 撤销、生产目标授权、未知结果恢复矩阵、A4 与 Phase 4B 仍未全部完成。安装摘要、公共搜索和 Stage 证据见 [Core 0.13 搜索专项](../evidence/phase4-core13-search-probe.json)。

Core 当前源码完整 Python 回归已通过 11,032 项测试，覆盖率 84.49%；初始化专项 9 项、修改文件类型检查以及契约生成/兼容性/公共 API 检查均通过。
