#!/usr/bin/env node
/**
 * 从编译产物重新生成两套 JSON Schema 目标（2020-12 / Draft 7）。
 * 默认写入 packages/contracts/generated；传入 --out <dir> 写入指定目录
 * （漂移检查用）。生成内容完全确定，可安全提交与逐字节比对。
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateJsonSchemaFiles } from "../dist/json-schema.js";

const args = process.argv.slice(2);
const outFlagIndex = args.indexOf("--out");
if (outFlagIndex !== -1 && args.length <= outFlagIndex + 1) {
  console.error("usage: generate.mjs [--out <dir>]");
  process.exit(2);
}
const defaultOut = resolve(dirname(fileURLToPath(import.meta.url)), "../generated");
const outDir = outFlagIndex === -1 ? defaultOut : resolve(args[outFlagIndex + 1]);

const files = generateJsonSchemaFiles();
const targetDirs = [...new Set(files.map((file) => file.path.split("/")[0]))];
for (const targetDir of targetDirs) {
  rmSync(join(outDir, targetDir), { recursive: true, force: true });
}
for (const file of files) {
  const destination = join(outDir, file.path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, file.content, "utf8");
}
console.log(`generated ${files.length} files under ${outDir}`);
