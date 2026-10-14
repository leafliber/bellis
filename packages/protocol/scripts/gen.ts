/**
 * 由 TypeBox 定义生成 JSON Schema 2020-12 文件（D-21、R-03）。
 *   node packages/protocol/scripts/gen.ts          写入 schemas/
 *   node packages/protocol/scripts/gen.ts --check  只比较，有差异时以非零退出
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { schemaModules } from '../src/index.ts';

const outDir = fileURLToPath(new URL('../schemas/', import.meta.url));
const suffix = '.schema.json';
const check = process.argv.includes('--check');

function render(name: string, defs: Record<string, unknown>): string {
  const doc = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `urn:bellis:schema:${name}`,
    $defs: defs,
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

const expected = new Map<string, string>();
for (const [name, defs] of Object.entries(schemaModules)) {
  expected.set(`${name}${suffix}`, render(name, defs));
}

mkdirSync(outDir, { recursive: true });
const existing = readdirSync(outDir).filter((file) => file.endsWith(suffix));
const stale: string[] = [];

for (const [file, content] of expected) {
  const path = join(outDir, file);
  const current = existing.includes(file) ? readFileSync(path, 'utf8') : undefined;
  if (current === content) continue;
  stale.push(file);
  if (!check) writeFileSync(path, content);
}
for (const file of existing) {
  if (expected.has(file)) continue;
  stale.push(file);
  if (!check) rmSync(join(outDir, file));
}

if (check && stale.length > 0) {
  console.error(`生成的 Schema 已过期：${stale.join(', ')}。运行 pnpm run gen 更新。`);
  process.exitCode = 1;
} else if (!check) {
  console.log(stale.length > 0 ? `已更新：${stale.join(', ')}` : 'Schema 已是最新');
}
