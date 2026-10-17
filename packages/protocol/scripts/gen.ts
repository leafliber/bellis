/**
 * 由 TypeBox 定义生成协议的派生物（D-21、R-03、R-24）：
 * - JSON Schema 2020-12：`schemas/<模块>.schema.json`，类型放在 `$defs` 下；
 * - Python sidecar 用到的 Pydantic 模型：同样的 JSON Schema 经 datamodel-code-generator 生成，再经 ruff 整理。
 *   这一步用 `uv run --locked` 运行，所以先要 `uv sync --locked`。
 *
 *   node packages/protocol/scripts/gen.ts          写入生成物
 *   node packages/protocol/scripts/gen.ts --check  只比较，有差异时以非零退出
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ChannelAccept,
  ChannelChallenge,
  ChannelHello,
  ProcessShutdownParams,
  ProcessShutdownResult,
  RpcCancelParams,
  RpcFailure,
  RpcNotification,
  RpcRequest,
  RpcSuccess,
  SidecarDescription,
  SidecarHealthResult,
  schemaModules,
  TtsInfoResult,
  TtsStatus,
  TtsSynthesizeParams,
  TtsSynthesizeResult,
  TtsWordsParams,
} from '../src/index.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const outDir = fileURLToPath(new URL('../schemas/', import.meta.url));
const suffix = '.schema.json';
const check = process.argv.includes('--check');

/**
 * 只生成 sidecar 实际用到的消息。路径相对仓库根；每个模块一次生成，互不引用。
 */
const pythonModules = [
  {
    name: 'sidecar',
    path: 'python/bellis_sidecar/src/bellis_sidecar/protocol.py',
    defs: {
      ChannelHello,
      ChannelChallenge,
      ChannelAccept,
      RpcRequest,
      RpcNotification,
      RpcSuccess,
      RpcFailure,
      RpcCancelParams,
      SidecarDescription,
      SidecarHealthResult,
      ProcessShutdownParams,
      ProcessShutdownResult,
    },
  },
  {
    name: 'tts-local',
    path: 'sidecars/tts_local/src/tts_local/protocol.py',
    defs: { TtsInfoResult, TtsStatus, TtsSynthesizeParams, TtsSynthesizeResult, TtsWordsParams },
  },
];

const PYTHON_HEADER =
  '# 由 packages/protocol 的 TypeBox 定义经 `pnpm run gen` 生成，勿手改（D-21）。';

/**
 * datamodel-code-generator 的选项：严格类型（不把 "1" 转成 1，与 TypeBox 的校验一致）、
 * 约束写在 `Annotated[..., Field(...)]` 里（pyright 严格模式不接受 `constr(...)` 作类型）、
 * 只生成 `$defs` 中的类型；格式交给仓库自己的 ruff 配置。
 */
const CODEGEN_OPTIONS = [
  '--input-file-type',
  'jsonschema',
  '--output-model-type',
  'pydantic_v2.BaseModel',
  '--target-python-version',
  '3.12',
  '--skip-root-model',
  '--field-constraints',
  '--use-annotated',
  '--strict-types',
  'str',
  'int',
  'bool',
  '--use-type-alias',
  '--reuse-model',
  '--keep-model-order',
  '--disable-timestamp',
  '--formatters',
  'builtin',
  '--custom-file-header',
  PYTHON_HEADER,
];

function render(name: string, defs: Record<string, unknown>): string {
  const doc = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `urn:bellis:schema:${name}`,
    $defs: defs,
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** 在仓库根经 uv 运行一个工具，以 stdin 传入、stdout 取回（统一成 LF）。 */
function uvRun(args: readonly string[], input: string): string {
  const result = spawnSync('uv', ['run', '--locked', ...args], {
    cwd: root,
    input,
    encoding: 'utf8',
    // Windows 上 Python 的标准流缺省用系统代码页。
    env: { ...process.env, PYTHONUTF8: '1' },
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`uv run ${args[0]} 失败（退出码 ${result.status}）：${result.stderr}`);
  }
  return result.stdout.replace(/\r\n/g, '\n');
}

function renderPython(name: string, path: string, defs: Record<string, unknown>): string {
  const schema = render(name, defs);
  const generated = uvRun(['datamodel-codegen', ...CODEGEN_OPTIONS], schema);
  const fixed = uvRun(
    ['ruff', 'check', '--fix', '--quiet', '--stdin-filename', path, '-'],
    generated,
  );
  return uvRun(['ruff', 'format', '--quiet', '--stdin-filename', path, '-'], fixed);
}

const stale: string[] = [];

/** 比较并（非 --check 时）写入一个生成物。 */
function emit(file: string, label: string, content: string): void {
  let current: string | undefined;
  try {
    current = readFileSync(file, 'utf8');
  } catch {
    current = undefined;
  }
  if (current === content) return;
  stale.push(label);
  if (!check) writeFileSync(file, content);
}

mkdirSync(outDir, { recursive: true });
const expected = new Set<string>();
for (const [name, defs] of Object.entries(schemaModules)) {
  const file = `${name}${suffix}`;
  expected.add(file);
  emit(join(outDir, file), file, render(name, defs));
}
for (const file of readdirSync(outDir).filter((f) => f.endsWith(suffix))) {
  if (expected.has(file)) continue;
  stale.push(file);
  if (!check) rmSync(join(outDir, file));
}

for (const { name, path, defs } of pythonModules) {
  emit(join(root, path), path, renderPython(name, path, defs));
}

if (check && stale.length > 0) {
  console.error(`生成物已过期：${stale.join(', ')}。运行 pnpm run gen 更新。`);
  process.exitCode = 1;
} else if (!check) {
  console.log(stale.length > 0 ? `已更新：${stale.join(', ')}` : '生成物已是最新');
}
