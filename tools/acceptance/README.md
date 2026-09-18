# P0 验收运行器

本模块负责从实际执行取得工具测试证据，把当前受测输入、安装依赖、运行器与原始输出绑定后交给 `tools/gate.ts` 核验。哈希不是签名；受信边界是可审查运行器、当前构建、保留的原始执行和可复跑过程。规范语义在 `docs/spec/24-verification.md` 与 `25-roadmap-gates.md`，字段定义在 `contracts/src/schema.json`，此处不另设验收规范。

## 当前入口与边界

在 `.node-version` 指定的 Node、`package.json` 固定的 pnpm 环境下运行：

```sh
pnpm acceptance:p0:tools --output reports/p0/tools-run
pnpm gate --phase P0 --evidence reports/p0/tools-run/acceptance.json
```

输出目录应使用新名称；既有文件拒绝覆盖。第一条命令实际执行登记的五个 `contract_tools` runner，保存 `AcceptanceReport` 及经 `TestEvidence.artifacts` 引用的 `P0TestRunEvidence`。第二条在真实 SUT 尚未接入时应返回 PENDING/退出码 2；五个工具 PASS 不关闭任何 SUT 不变量。

目前只实现工具测试适配器。`catalog.ts` 的 `sutScenarios` 尚无条目，SUT 与 `exit.P0` 证据验证保持拒绝。宿主、监督、假设备、鉴权、效果和清理执行不属于本模块现有实现；不能用 `SimulationEndpoint` 或手写记录补齐这些证据。

## 输入、输出与所有权

- `run.ts` 读取当前 `verification.json`，以真实 Node 子进程执行完整登记文件；清除继承的 `NODE_TEST_CONTEXT`，避免嵌套运行器被 Node 当作递归测试跳过。`NODE_OPTIONS`、`NODE_PATH` 有额外注入时拒绝取证。
- `node-reporter.ts` 从官方 `node:test` 事件流保存连续编号的 NDJSON。测试 stdout 是独立事件，日志中的 PASS 不参与判定。
- `P0BuildManifest`、`P0ExecutionEnvironment`、`P0TestRunEvidence` 和 `AcceptanceReport` 均使用生成的类型与校验器。运行器是这些报告的唯一写入者；它不写 SUT 事实存储，也不更新契约验收状态。
- 原始命令记录含命令、退出码、信号和执行错误。报告中的命令/退出码必须与该记录一致；场景、断言、用例计数、时延与原始事件交叉核验。这里的断言计数是完整 `node:test` 用例结果数，不是 `assert.*` 调用总数。

## 构建绑定

`tools/lib/build-manifest.ts` 保守遍历明确覆盖根，包含现有和后续出现的 `apps/`、`packages/`、`plugins/`、`tools/`、`tests/`，必要契约源/生成物/fixture，以及锁文件、包、Node 和构建配置。SUT 与 runner 分别带类型摘要，当前采用相同保守输入集合；gate 每次重新遍历，不能由证据缩减覆盖范围。

安装包的实际文件内容参与摘要，包括原生 `.node` 制品；依赖同时记录名称、实际版本、package.json 摘要和包内容摘要。依赖解析符号链接绑定规范根相对目标和目标内容，允许指向已覆盖的 workspace 包，拒绝根外或未覆盖根。源码内任意符号链接默认拒绝。Node 可执行文件另记实际哈希。

不遍历 `reports/`、工具缓存、真实 `.env` 凭据、包管理器安装位置元数据和原生编译中间文件；构建清单不包含时间戳或绝对安装路径。运行期 profile 由后续 SUT 记录绑定，工具运行没有活动 profile，明确为 null。

## 资源、时限与失败

工具用例文件串行执行，每个子进程最多 120 秒、stdout/stderr 缓冲上限 16 MiB。gate 对单个原始文件设置 64 MiB 读取上限；Schema 对条目数另有限制。此运行器不是运行时安全循环，允许同步等待子进程，但不能承担独立监督或停止职责。

原始文件只允许在真实 `reports/` 下，写入前逐级拒绝符号链接父路径，文件使用排他创建；读取再次核验真实路径和哈希。测试夹具在 `finally` 中删除自身隔离目录，验收运行保留 reports 供审查，不自动删除失败轨迹。超时、输出过限、不完整事件、SKIP/TODO、异常退出或不匹配会得到 FAIL/PENDING；修复后用新目录完整重跑，不修补旧报告。

## 实际覆盖与后续接入

`tests/gate.test.ts` 通过真实执行隔离工具 fixture，验证缺测试、SKIP/FAIL、未实现、陈旧契约/构建、helper/依赖/原生制品变化、新 runtime 文件、原始哈希破坏、重新哈希后的错误退出记录、截断事件、缺失场景、重复/未知 ID、伪造汇总、路径逃逸与重复输出拒绝。夹具明确标记为 `contract_tools`，不更改生产契约状态。

后续 SUT 用例应放在独立验收入口，不能把默认 `tests/*.test.ts` 的结构检查当成系统验收。接入时由实际驱动进程的场景代码提供明确 `test_id → scenario_id` 集合、原始协议轨迹、端点/宿主事实及对照断言，并完善 SUT 原始事实解码和交叉核验；只填写目录或复制 PASS 不构成适配。

`p0TransitionRequirements()` 从当前登记派生 P0 转换、守卫拒绝、表外事件和终态不复活覆盖要求；禁止的无人准入只要求拒绝，不建立批准条件。该函数本身不执行状态机，也不证明 SUT 覆盖。实际覆盖报告必须将条目绑定到执行过的场景；竞争与组合故障仍由相应 SUT 场景给出真实轨迹。
