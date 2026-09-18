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
- 原始命令记录含命令、退出码、信号和执行错误。工具适配器独立要求 `command.json`、`node-events.ndjson`、`stderr.txt` 三份原始文件及精确的 trace/输出关联；即使 stderr 为空也不可省略。每个用例的 complete、pass/fail、文件汇总和最终汇总须一致，事件的 file/entryFile 必须绑定登记 runner。场景、断言、用例计数与时延从这些记录重算。这里的断言计数是完整 `node:test` 用例结果数，不是 `assert.*` 调用总数。

## 构建绑定

`tools/lib/build-manifest.ts` 保守遍历明确覆盖根，包含现有和后续出现的 `apps/`、`packages/`、`plugins/`、`tools/`、`tests/`，必要契约源/生成物/fixture，以及锁文件、包、Node 和构建配置。SUT 与 runner 分别带类型摘要，当前采用相同保守输入集合；gate 每次重新遍历，不能由证据缩减覆盖范围。

安装包的实际文件内容参与摘要，包括原生 `.node` 制品；依赖同时记录名称、实际版本、package.json 摘要和包内容摘要。依赖解析符号链接绑定规范根相对目标和目标内容，允许指向已覆盖的 workspace 包，拒绝根外或未覆盖根。源码内任意符号链接默认拒绝。Node 可执行文件另记实际哈希。

不遍历 `reports/`、工具缓存、真实 `.env` 凭据、包管理器安装位置元数据和原生编译中间文件；构建清单不包含时间戳或绝对安装路径。`.env.*` 下明确的 JS/TS、Wasm 和原生模块代码扩展名仍须纳入；有歧义的 JSON/YAML/TOML 配置、目录或链接直接拒绝，避免静默漏掉输入或读取凭据。受测程序和 runner 不得从被排除的 `.env` 文件加载行为配置；运行期 profile 由后续 SUT 记录绑定，工具运行没有活动 profile，明确为 null。

运行器在整批工具执行前固定 SUT、runner 和环境，在每个实际子进程结束后重新计算并比较。发现源码、依赖或环境变化时保留原始命令/输出，结果为 FAIL，报告说明绑定失败；不能用运行后的新摘要替换原摘要。取证期间仍要求冻结受测输入：前后比较不能证明恶意并发替换后又恢复没有发生。

## 资源、时限与失败

工具用例文件串行执行，每个子进程最多 120 秒、stdout/stderr 缓冲上限 16 MiB。gate 对单个原始文件设置 64 MiB 读取上限；Schema 对条目数另有限制。此运行器不是运行时安全循环，允许同步等待子进程，但不能承担独立监督或停止职责。

原始文件和 gate 的 `--output` 只允许在真实 `reports/` 下的规范路径，拒绝路径别名与符号链接，文件使用排他创建，已有证据不能覆盖。读取使用不跟随最终符号链接的文件描述符，核对 fstat、大小、读前后身份/时间与实际字节哈希；读取增长或截断会失败。父目录逐级核对及打开后的再次核验缩小竞态窗口，但不宣称完全抵御同权限进程并发置换父目录。测试夹具在 `finally` 中删除自身隔离目录，验收运行保留 reports 供审查，不自动删除失败轨迹。超时、输出过限、不完整事件、SKIP/TODO、异常退出或不匹配会得到 FAIL/PENDING；修复后用新目录完整重跑，不修补旧报告。

## 实际覆盖与后续接入

`tests/gate.test.ts` 通过真实执行隔离工具 fixture，验证缺测试、SKIP/FAIL、未实现、陈旧契约/构建、helper/依赖/原生制品变化、新 runtime 文件、原始哈希破坏、重新哈希后的错误退出记录、截断事件、缺失场景、重复/未知 ID、伪造汇总、路径逃逸与重复输出拒绝。夹具明确标记为 `contract_tools`，不更改生产契约状态。

回归还实际执行原始 complete/来源/汇总矛盾、删除整份 stderr 及全部引用、gate CLI 排他输出、工具运行中修改受测输入、读取中增长文件、真实失败/跳过/取消，以及 `.env.*` 代码覆盖和歧义配置拒绝。这些属于工具验证，不证明生产 SUT 的身份、守卫或停止行为。

后续 SUT 用例应放在独立验收入口，不能把默认 `tests/*.test.ts` 的结构检查当成系统验收。当前非工具适配器明确抛出未实现错误，即使填入 catalog 或自洽的事实数组也不能通过。接入时由实际驱动进程的场景代码提供明确 `test_id → scenario_id` 集合、原始协议轨迹、端点/宿主事实及对照断言，并实现绑定实际来源的进程、事实与归约解码和交叉核验。

`p0TransitionRequirements()` 从当前登记派生 P0 转换、守卫拒绝、表外事件和终态不复活覆盖要求；禁止的无人准入只要求拒绝，不建立批准条件。该函数本身不执行状态机，也不证明 SUT 覆盖。实际覆盖报告必须将条目绑定到执行过的场景；竞争与组合故障仍由相应 SUT 场景给出真实轨迹。
