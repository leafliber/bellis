# 技术基线

实现准备材料；规范以 `docs/spec/` 为准。版本以环境声明与锁文件为准，升级时同步修改并重跑 `pnpm check`。

## 当前工具链

全部工具只用 Node 与 pnpm，不需要其它运行时。

| 项目 | 用途 | 配置或实现 |
| --- | --- | --- |
| Node | 24 LTS；开发与 CI 使用相同补丁版本，直接运行 `.ts`（类型剥离） | `.node-version`、`package.json.engines` |
| TypeScript | ESM、strict、noUncheckedIndexedAccess、exactOptionalPropertyTypes、erasableSyntaxOnly；只做类型检查 | `tsconfig.json` |
| 包管理 | pnpm workspaces，固定依赖版本与锁文件 | `packageManager`、`pnpm-lock.yaml` |
| 代码风格 | Biome 检查手写 TS/JS；生成物由生成器决定格式 | `biome.json` |
| 契约生成 | 合成 Schema、TS 类型、登记快照、阶段简报 | `tools/generate.ts` |
| 运行时校验 | Ajv 2020-12 构建期编译，esbuild 打包为独立 ESM | `tools/lib/codegen.ts` |
| 一致性检查与门禁 | 登记、Schema、状态机、fixture、文档交叉检查；阶段门禁 | `tools/check.ts`、`tools/gate.ts` |
| 状态机 | 登记生成转换表，SDK 返回决定；受信守卫与动作由宿主实现 | `contracts/src/state-machines.json` |
| 测试 | node:test、node:assert/strict | `tests/` |
| 数据库探针 | better-sqlite3 验证 SQLite WAL/FULL 的有限故障窗口（S-4） | `tools/spikes/sqlite.mjs` |
| 浏览器探针 | playwright-core 驱动独立 Chrome 配置（S-1/S-2） | `tools/spikes/browser.mjs` |

## 实现时按需接入

| 用途 | 选型与接入时机 |
| --- | --- |
| 生产存储 | P0 授权和停止事实开始持久化时接入 SQLite 事务、Outbox、顺序迁移与版本表；不引入 ORM。 |
| HTTP/WS | 首个网络宿主使用 Fastify + ws 时安装并锁定；本地插件先用 stdio JSON-RPC。 |
| 遥测 | 宿主有实际采集需求时接入 OpenTelemetry SDK 和结构化日志。 |
| 属性/浏览器测试 | 真实调度器或 Stage 开始实现时引入 fast-check／所需 Playwright 测试能力。 |
| 本地配置 | 首次引入本地配置时提供脱敏的 `.env.example`；`.env`、`.env.*` 已被忽略。 |

选型依据：[Node 官方发布状态](https://nodejs.org/en/about/previous-releases)、[Ajv 独立校验器](https://ajv.js.org/standalone.html)。本地通过只对应实际运行版本；Linux/Windows 由 CI 与目标真机另行验证。
